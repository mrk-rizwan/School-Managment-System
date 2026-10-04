import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AfterCommit } from '../../tenancy/after-commit';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { NotificationService } from '../../messaging/notification.service';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { ClassRepository } from '../../repositories/class.repository';
import {
  DIARY_ENTRY_NATURAL_KEY,
  DiaryEntryRepository,
  type DiaryAttachment,
  type DiaryEntryChanges,
  type DiaryEntryRecord,
} from '../../repositories/diary-entry.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { classArchived, fromDateString, toDateString, yearClosed } from '../academics/academics.shared';
import { notAuthor } from '../access/access.errors';
import { PermissionsService } from '../access/permissions.service';
import { stagedUploadUnusable } from '../documents/documents.service';
import type {
  CreateDiaryEntryDto,
  DiaryEntryDto,
  ListDiaryEntriesQueryDto,
  MyDiaryEntryDto,
  DiaryRangeQueryDto,
  UpdateDiaryEntryDto,
} from './diary.dto';
import {
  AttachmentFiles,
  storedAttachment,
  type AttachedFile,
} from '../documents/attachment-files.service';
import {
  editWindowEndsOn,
  rangeOf,
  requireStaffId,
  sectionInScope,
  studentInCapacityScope,
  toDiaryEntryDto,
  toMyDiaryEntryDto,
  usableSubject,
  type DiarySettings,
} from './diary.shared';

// contracts/slice-13.md §3, §4, §6.1-§6.3 (R137-R139, R142, R143). A diary entry is one row per
// section, date and subject, edited in place under the transaction-local actor so the history
// trigger records every change; a create is idempotent per user and key (slice-6 §6.3).

const ENDPOINT = 'diary_entries';
/** The five editable fields, in the order a refusal names them. */
const EDITABLE = ['topic', 'assignment', 'learningOutcome', 'dueOn', 'attachment'] as const;
type Editable = (typeof EDITABLE)[number];

export interface DiaryCreateOutcome {
  replayed: boolean;
  entry: DiaryEntryDto;
}

const entryExists = (entryId: bigint) =>
  new ApiException(
    409,
    ErrorCode.DIARY_ENTRY_EXISTS,
    'The diary for this date and subject is already written.',
    { entryId: entryId.toString() },
  );

const sameDay = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

@Injectable()
export class DiaryEntriesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly entries: DiaryEntryRepository,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly subjects: SubjectRepository,
    private readonly staged: StagedUploadRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly settings: SchoolSettingsRepository,
    private readonly settingsReader: SchoolSettingsReader,
    private readonly changeContext: ChangeContextRepository,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationService,
    private readonly permissions: PermissionsService,
    private readonly attachments: AttachmentFiles,
    private readonly afterCommit: AfterCommit,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------- staff reads

  /** §4.1: a section in today's scope (an archived one still lists), else 404. */
  async list(
    session: SchoolSessionContext,
    sectionId: bigint,
    query: ListDiaryEntriesQueryDto,
  ): Promise<Page<DiaryEntryDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const range = rangeOf(query);
    if (!sectionInScope(scope, sectionId) || !(await this.sections.findById(schoolId, sectionId))) {
      throw notFound();
    }
    const { rows, total } = await this.entries.listForSection(schoolId, scope, sectionId, {
      ...range,
      ...(query.subjectId === undefined ? {} : { subjectId: BigInt(query.subjectId) }),
    });
    const settings = await this.diarySettings(schoolId);
    const views = await this.entries.withNames(schoolId, rows);
    return toPage(
      views.map((row) => toDiaryEntryDto(row, settings)),
      query,
      total,
    );
  }

  /** §4.2. */
  async get(session: SchoolSessionContext, id: bigint): Promise<DiaryEntryDto> {
    const schoolId = this.context.schoolId;
    return this.dto(schoolId, await this.require(schoolId, session, id));
  }

  /** §4.5. */
  async attachment(session: SchoolSessionContext, id: bigint, thumb: boolean): Promise<AttachedFile> {
    const schoolId = this.context.schoolId;
    return this.file(schoolId, await this.require(schoolId, session, id), thumb);
  }

  // ---------------------------------------------------------------- guardian and student reads

  /** §6.2: `studentId` must be in the capacity scope (a child of the guardian, or oneself). */
  async listForStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    query: DiaryRangeQueryDto,
  ): Promise<Page<MyDiaryEntryDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const range = rangeOf(query);
    if (!studentInCapacityScope(scope, studentId)) throw notFound();
    const { rows, total } = await this.entries.listVisibleToStudent(
      schoolId,
      scope,
      studentId,
      range,
    );
    return toPage(
      (await this.entries.withNames(schoolId, rows)).map(toMyDiaryEntryDto),
      query,
      total,
    );
  }

  /** §6.3: a non-recipient gets 404 from the §6.1 predicate, never the bytes. */
  async attachmentForStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    entryId: bigint,
    thumb: boolean,
  ): Promise<AttachedFile> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    if (!studentInCapacityScope(scope, studentId)) throw notFound();
    const entry = await this.entries.findVisibleToStudent(schoolId, scope, studentId, entryId);
    if (!entry) throw notFound();
    return this.file(schoolId, entry, thumb);
  }

  /** The entry's attachment or its thumbnail, named `diary-<id>` (§4.5). */
  private file(schoolId: SchoolId, entry: DiaryEntryRecord, thumb: boolean): Promise<AttachedFile> {
    const file = storedAttachment(entry);
    const name = `diary-${entry.id}`;
    const log = { diaryEntryId: entry.id.toString() };
    return thumb
      ? this.attachments.thumbnail(schoolId, file, name, log)
      : this.attachments.open(schoolId, file, name, log);
  }

  // ---------------------------------------------------------------------------------- create

  /** §4.3 with §3's pre-steps: key, hash, replay or reuse, then one transaction. */
  async create(
    session: SchoolSessionContext,
    sectionId: bigint,
    dto: CreateDiaryEntryDto,
    rawKey: string | undefined,
  ): Promise<DiaryCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, sectionId, dto, rawKey, (claim) =>
      recoverConstraint(
        DIARY_ENTRY_NATURAL_KEY,
        () => this.createInTransaction(session, actor, sectionId, dto, claim),
        // Rolled back; answered from a fresh read outside the transaction.
        async (error) => {
          const holder = await this.entries.findByNaturalKey(actor.schoolId, {
            sectionId,
            date: fromDateString(dto.date),
            subjectId: BigInt(dto.subjectId),
          });
          if (holder) throw entryExists(holder.id);
          throw error;
        },
      ),
    );
    // Same request: the entry re-read under the caller's current scope, 200 (R143, decision 4).
    if (outcome.replayed) return { replayed: true, entry: await this.get(session, outcome.subjectId) };
    // From the written row, not a scoped re-read: a cover writing inside past cover dates holds
    // no scope today, yet the entry is theirs (a replay re-reads under the current scope, §3).
    return { replayed: false, entry: await this.dto(actor.schoolId, outcome.value) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    sectionId: bigint,
    dto: CreateDiaryEntryDto,
    claim: IdempotencyClaim,
  ): Promise<DiaryEntryRecord> {
    const { schoolId, userId } = actor;
    // Step 1, the first statement: a racing same-key submit now waits on the unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'diary_entry');
    const staffId = requireStaffId(session);
    const today = await this.clock.today(schoolId);

    // Step 2: the section, its class and year; the date inside the year and not in the future.
    const section = await this.sections.findById(schoolId, sectionId);
    if (!section) throw notFound();
    const klass = await this.classes.findById(schoolId, section.classId);
    const year = klass && (await this.years.findById(schoolId, klass.academicYearId));
    if (!klass || !year) throw notFound();
    if (section.deletedAt !== null) {
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'This section is archived.');
    }
    if (klass.status === 'archived') throw classArchived();
    if (year.status === 'closed') throw yearClosed();
    const date = fromDateString(dto.date);
    if (date > today || date < year.startsOn || date > year.endsOn) {
      throw fieldRefused(
        'date',
        ErrorCode.INVALID_VALUE,
        `date must be no later than today and within the academic year (${toDateString(year.startsOn)} to ${toDateString(year.endsOn)})`,
      );
    }
    const dueOn = dto.dueOn === undefined || dto.dueOn === null ? null : fromDateString(dto.dueOn);
    this.assertDueOn(dueOn, date, year.endsOn);

    // Step 3: dated, role-aware scope (§1.3).
    const subjectId = BigInt(dto.subjectId);
    await this.assertMayWrite(session, sectionId, subjectId, date);

    // Step 4: the subject.
    const subject = await usableSubject(this.subjects, schoolId, subjectId);

    // Step 5: retry-safety; the key is rolled back with this refusal.
    const existing = await this.entries.findByNaturalKey(schoolId, { sectionId, date, subjectId });
    if (existing) throw entryExists(existing.id);

    // Step 6: the attachment, consumed by its uploader only (R91, R171).
    const attachment =
      dto.stagedUploadId === undefined || dto.stagedUploadId === null
        ? null
        : await this.consume(actor, BigInt(dto.stagedUploadId));

    // Step 7.
    const row = await this.entries.create(schoolId, {
      sectionId,
      classId: klass.id,
      academicYearId: year.id,
      date,
      subjectId,
      authorStaffId: staffId,
      topic: dto.topic,
      assignment: dto.assignment ?? null,
      learningOutcome: dto.learningOutcome ?? null,
      dueOn,
      attachment,
    });
    await recordSubject(row.id);

    // Step 8 (R138, decision 7): only an entry dated today notifies.
    let recipients = { guardianIds: [] as bigint[], studentIds: [] as bigint[] };
    const notified = date.getTime() === today.getTime();
    if (notified) {
      const settings = await this.settings.find(schoolId);
      recipients = await this.entries.postedRecipients(
        schoolId,
        { sectionId, date },
        settings?.studentLoginEnabled ?? false,
      );
      await this.notifications.send(schoolId, {
        type: 'diary_posted',
        subject: { type: 'diary_entry', id: row.id },
        recipients: [
          ...recipients.guardianIds.map((guardianId) => ({ guardianId })),
          ...recipients.studentIds.map((studentId) => ({ studentId })),
        ],
        vars: {
          className: klass.name,
          sectionName: section.name,
          subjectName: subject.name,
          date,
          topic: row.topic,
          dueOn: row.dueOn,
        },
      });
    }

    // Step 9.
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'diary_entry.created',
      subjectType: 'diary_entry',
      subjectId: row.id,
      metadata: {
        sectionId: sectionId.toString(),
        date: dto.date,
        subjectId: subjectId.toString(),
        hasAttachment: attachment !== null,
        notified,
        recipientGuardians: recipients.guardianIds.length,
        recipientStudents: recipients.studentIds.length,
      },
    });
    return row;
  }

  // ------------------------------------------------------------------------------------ edit

  /** §4.4: the row locked; author inside the window, or a school-wide holder (a reason after it). */
  @Transactional()
  async update(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateDiaryEntryDto,
  ): Promise<DiaryEntryDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    if (dto.topic === null) {
      throw fieldRefused('topic', ErrorCode.INVALID_VALUE, 'topic cannot be removed');
    }
    // The history trigger reads the actor and reason from the transaction (§4.6); a no-op lock
    // below writes no history.
    await this.changeContext.setChangeContext(userId, dto.reason ?? null);
    const entry = await readLocked(
      () => this.entries.findById(schoolId, scopeOf(session), id),
      (row) => this.entries.lockIfUnchanged(schoolId, row),
    );

    const settings = await this.diarySettings(schoolId);
    const today = await this.clock.today(schoolId);
    const insideWindow = today <= editWindowEndsOn(entry.createdAt, settings);
    const byAuthor = entry.authorStaffId === session.access.staffId;
    const schoolWide = scopeOf(session).kind === 'all';
    // The §4.4 table. A school-wide holder who is also the author keeps the school-wide right
    // (a reason after the window), as for anyone else's entry.
    if (!byAuthor && !schoolWide) throw notAuthor();
    if (!insideWindow && !schoolWide) {
      throw new ApiException(
        409,
        ErrorCode.DIARY_ENTRY_LOCKED,
        `The edit window closed on ${toDateString(editWindowEndsOn(entry.createdAt, settings))}.`,
      );
    }

    const year = await this.years.findById(schoolId, entry.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();

    const changes = await this.changesOf(actor, entry, dto, year.endsOn);
    const changed = EDITABLE.filter((field) => changes[field] !== undefined);
    // No change: 200 unchanged, no history row, no audit (a replayed edit is free).
    if (changed.length === 0) return this.dto(schoolId, entry);
    if (!insideWindow && dto.reason === undefined) {
      throw new ApiException(
        409,
        ErrorCode.AMENDMENT_REASON_REQUIRED,
        'A reason is required to change an entry after the edit window.',
        { amendments: changed },
      );
    }

    const updated = await this.entries.update(schoolId, id, changes, new Date());
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'diary_entry.updated',
      subjectType: 'diary_entry',
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: { changes: changed.join(','), afterWindow: !insideWindow, byAuthor },
    });
    return this.dto(schoolId, updated);
  }

  /**
   * The fields that differ from the row (absent = unchanged), validated on the merged result:
   * `dueOn` against the entry's date and year; a new attachment consumed (§4.3 step 6).
   */
  private async changesOf(
    actor: Actor,
    entry: DiaryEntryRecord,
    dto: UpdateDiaryEntryDto,
    yearEndsOn: Date,
  ): Promise<Pick<DiaryEntryChanges, Editable>> {
    const changes: Pick<DiaryEntryChanges, Editable> = {};
    if (dto.topic !== undefined && dto.topic !== entry.topic) changes.topic = dto.topic;
    if (dto.assignment !== undefined && dto.assignment !== entry.assignment) {
      changes.assignment = dto.assignment;
    }
    if (dto.learningOutcome !== undefined && dto.learningOutcome !== entry.learningOutcome) {
      changes.learningOutcome = dto.learningOutcome;
    }
    if (dto.dueOn !== undefined) {
      const dueOn = dto.dueOn === null ? null : fromDateString(dto.dueOn);
      this.assertDueOn(dueOn, entry.date, yearEndsOn);
      if (!sameDay(dueOn, entry.dueOn)) changes.dueOn = dueOn;
    }
    if (dto.stagedUploadId === null) {
      if (entry.attachmentObjectKey !== null) changes.attachment = null;
    } else if (dto.stagedUploadId !== undefined) {
      changes.attachment = await this.consume(actor, BigInt(dto.stagedUploadId));
    }
    return changes;
  }

  // --------------------------------------------------------------------------------- helpers

  /** §1.3: the section held on `date`; a subject teacher only for a subject taught there. */
  private async assertMayWrite(
    session: SchoolSessionContext,
    sectionId: bigint,
    subjectId: bigint,
    date: Date,
  ): Promise<void> {
    const dated = await this.permissions.scopeOf(session, {
      capability: Capability.DIARY_WRITE,
      on: date,
    });
    if (dated === null) {
      throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');
    }
    if (dated.kind === 'all') return;
    const roles = dated.sections.get(sectionId);
    if (!roles) return this.permissions.refuseOutsideDate(session, sectionId);
    if (roles.classTeacher || roles.cover || roles.subjectIds.includes(subjectId)) return;
    throw new ApiException(
      409,
      ErrorCode.SUBJECT_NOT_ASSIGNED,
      'You do not teach this subject in this section.',
    );
  }

  private assertDueOn(dueOn: Date | null, date: Date, yearEndsOn: Date): void {
    if (dueOn !== null && (dueOn < date || dueOn > yearEndsOn)) {
      throw fieldRefused(
        'dueOn',
        ErrorCode.INVALID_VALUE,
        `dueOn must be on or after the entry's date and no later than ${toDateString(yearEndsOn)}`,
      );
    }
  }

  /**
   * The staged upload's object, consumed in one conditional update; else 422 (R91). An image's
   * thumbnail is made once, from the already re-encoded object, and stored beside it after commit
   * (§4.5): nothing is written to storage for a create or edit that rolls back.
   */
  private async consume(actor: Actor, stagedUploadId: bigint): Promise<DiaryAttachment> {
    const { schoolId, userId } = actor;
    const [staged] = await this.staged.findOwned(schoolId, userId, [stagedUploadId]);
    if (!staged || !(await this.staged.consume(schoolId, userId, staged.id, new Date()))) {
      throw stagedUploadUnusable('stagedUploadId');
    }
    const attachment = { objectKey: staged.objectKey, mime: staged.mime, sizeBytes: staged.sizeBytes };
    this.afterCommit.register(() => this.attachments.storeThumbnail(schoolId, attachment));
    return attachment;
  }

  private async require(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    id: bigint,
  ): Promise<DiaryEntryRecord> {
    const entry = await this.entries.findById(schoolId, scopeOf(session), id);
    if (!entry) throw notFound();
    return entry;
  }

  private async dto(schoolId: SchoolId, entry: DiaryEntryRecord): Promise<DiaryEntryDto> {
    const [view] = await this.entries.withNames(schoolId, [entry]);
    if (!view) throw notFound();
    return toDiaryEntryDto(view, await this.diarySettings(schoolId));
  }

  private async diarySettings(schoolId: SchoolId): Promise<DiarySettings> {
    const { timezone, windowDays } = await this.settingsReader.read(schoolId);
    return { timezone, amendWindowDays: windowDays };
  }
}
