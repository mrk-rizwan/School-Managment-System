import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import {
  AssessmentRepository,
  examKey,
  scopeReaches,
  sectionTermKey,
  type AssessmentRecord,
  type NewExam,
} from '../../repositories/assessment.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassSubjectRepository } from '../../repositories/class-subject.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { MarkRepository } from '../../repositories/mark.repository';
import { SectionRepository } from '../../repositories/section.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import {
  classArchived,
  fromDateString,
  toDateString,
  yearClosed,
  type Changes,
} from '../academics/academics.shared';
import { notAuthor } from '../access/access.errors';
import { PermissionsService } from '../access/permissions.service';
import type {
  AssessmentDto,
  CreateAssessmentDto,
  ExamSetUpResultDto,
  ListAssessmentsQueryDto,
  SetUpExamsDto,
  UpdateAssessmentDto,
} from './assessments.dto';
import {
  assessmentHasMarks,
  assessmentLocked,
  assessmentOutsideTerm,
  assessmentVoided,
  resultSheetNotDraft,
  subjectNotAssigned,
  toAssessmentDto,
} from './assessments.shared';

// contracts/slice-30.md §2, §5 (phase-4-academic.md slice 30, R264): tests a teacher creates,
// exams the term's set-up creates, their edits and voids. The scope is minted for the
// assessment's held_on (§0.27): reads with marksReadScopeOf, every write with marksWriteScopeOf.

const ENDPOINT = 'assessments';
/** POST /assessments has no path id; the key's hash binds the body alone. */
const NO_PATH_ID = 0n;
const SUBJECT = 'assessment';
/** Every class of a year, for the set-up (a school has far fewer). */
const ALL_CLASSES = 1000;

export interface AssessmentCreateOutcome {
  replayed: boolean;
  assessment: AssessmentDto;
}

@Injectable()
export class AssessmentsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly assessments: AssessmentRepository,
    private readonly marks: MarkRepository,
    private readonly terms: AcademicTermRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly permissions: PermissionsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------------ reads

  /**
   * §2.1: the assessments the caller reads with today's read scope (marks.enter or
   * marks.view_all), newest held first.
   */
  async list(
    session: SchoolSessionContext,
    query: ListAssessmentsQueryDto,
  ): Promise<Page<AssessmentDto>> {
    const schoolId = this.context.schoolId;
    const scope = await this.permissions.marksReadScopeOf(
      session,
      await this.clock.today(schoolId),
    );
    if (scope === null) return toPage([], query, 0);
    const { rows, total } = await this.assessments.list(
      schoolId,
      scope,
      {
        ...(query.termId === undefined ? {} : { termId: BigInt(query.termId) }),
        ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
        ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
        ...(query.classSubjectId === undefined
          ? {}
          : { classSubjectId: BigInt(query.classSubjectId) }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        includeVoided: query.includeVoided ?? false,
      },
      {
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        ascending: query.sort === 'heldOn',
      },
    );
    return toPage(await this.views(session, scope, rows), query, total);
  }

  /** The assessment with its view for the caller, read under the scope of its held_on; else 404. */
  async get(session: SchoolSessionContext, id: bigint): Promise<AssessmentDto> {
    const schoolId = this.context.schoolId;
    const on = await this.assessments.scopeDateOf(schoolId, id);
    const scope = on && (await this.permissions.marksReadScopeOf(session, on));
    const row = scope ? await this.assessments.find(schoolId, scope, id) : null;
    if (!row || !scope) throw notFound();
    const [dto] = await this.views(session, scope, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /**
   * The DTOs of `rows` (read under `readScope`): the live-mark counts in one statement, and
   * whether the caller writes each, from the write scope of its held_on (one mint per date).
   */
  async views(
    session: SchoolSessionContext,
    readScope: MarksScope,
    rows: readonly AssessmentRecord[],
  ): Promise<AssessmentDto[]> {
    const schoolId = this.context.schoolId;
    const counts = await this.marks.liveCounts(
      schoolId,
      readScope,
      rows.map((row) => row.id),
    );
    const lockedPairs = await this.assessments.lockingSheets(schoolId, rows);
    // One mint per distinct date (a page of tests spans a few dates).
    const writeScopes: {
      on: number;
      scope: Awaited<ReturnType<PermissionsService['marksWriteScopeOf']>>;
    }[] = [];
    const dtos: AssessmentDto[] = [];
    for (const row of rows) {
      const on = row.heldOn.getTime();
      let minted = writeScopes.find((entry) => entry.on === on);
      if (!minted) {
        minted = { on, scope: await this.permissions.marksWriteScopeOf(session, row.heldOn) };
        writeScopes.push(minted);
      }
      const write = minted.scope;
      const locked =
        row.lockedAt !== null || lockedPairs.has(sectionTermKey(row.sectionId, row.termId));
      dtos.push(
        toAssessmentDto(row, {
          createdByMe: row.createdBy === session.access.userId,
          markedCount: counts.get(row.id) ?? 0,
          canEnterMarks:
            write !== null &&
            row.voidedAt === null &&
            !locked &&
            scopeReaches(write, 'write', row.sectionId, row.subjectId),
          locked,
        }),
      );
    }
    return dtos;
  }

  // ---------------------------------------------------------------------------------- create

  /** §2.2: a class test, keyed (Idempotency-Key, endpoint `assessments`). */
  async create(
    session: SchoolSessionContext,
    dto: CreateAssessmentDto,
    rawKey: string | undefined,
  ): Promise<AssessmentCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(
      actor,
      ENDPOINT,
      NO_PATH_ID,
      dto,
      rawKey,
      (claim) => this.createInTransaction(session, actor, dto, claim),
    );
    // A replay re-reads the row under the caller's current scope for its date (200).
    if (outcome.replayed)
      return { replayed: true, assessment: await this.get(session, outcome.subjectId) };
    return { replayed: false, assessment: outcome.value };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    dto: CreateAssessmentDto,
    claim: IdempotencyClaim,
  ): Promise<AssessmentDto> {
    const { schoolId, userId } = actor;
    // The first statement: a racing same-key create now waits on the key's unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const sectionId = BigInt(dto.sectionId);
    const heldOn = fromDateString(dto.heldOn);

    const section = await this.sections.findById(schoolId, sectionId);
    if (!section) throw notFound();
    // The scope of the test's own date (§0.27), minted before anything more is read: a section
    // outside it answers as a missing one, whatever its class subjects (wave N review).
    const scope = await this.permissions.marksWriteScopeOf(session, heldOn);
    if (scope === null) throw notFound();
    if (scope.kind === 'sections' && !scope.sections.has(sectionId)) {
      return this.permissions.refuseOutsideDate(session, sectionId);
    }
    const klass = await this.classes.findById(schoolId, section.classId);
    const year = klass && (await this.years.findById(schoolId, klass.academicYearId));
    if (!klass || !year) throw notFound();
    const classSubject = await this.classSubjects.findLive(schoolId, BigInt(dto.classSubjectId));
    if (!classSubject || classSubject.classId !== klass.id) {
      throw fieldRefused(
        'classSubjectId',
        ErrorCode.REFERENCE_NOT_FOUND,
        "Not a subject of this section's class",
      );
    }

    // The section is in scope: the subject must be one the caller teaches there.
    if (!scopeReaches(scope, 'write', sectionId, classSubject.subjectId)) throw subjectNotAssigned();
    if (section.deletedAt !== null) {
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'This section is archived.');
    }
    if (klass.status === 'archived') throw classArchived();
    if (year.status === 'closed') throw yearClosed();

    // A3: the term whose dates contain held_on, fixed at creation.
    const term = (await this.terms.allForYear(schoolId, year.id)).find(
      (t) => t.startsOn <= heldOn && heldOn <= t.endsOn,
    );
    if (!term) throw assessmentOutsideTerm(null);
    // Slice 30: no new test once the section's sheet for the term is submitted (the database's
    // assessments_sheet_guard behind it).
    const locking = await this.assessments.lockingSheets(schoolId, [{ sectionId, termId: term.id }]);
    const lockingSheetId = locking.get(sectionTermKey(sectionId, term.id));
    if (lockingSheetId !== undefined) throw resultSheetNotDraft(lockingSheetId);

    const row = await this.assessments.create(schoolId, scope, {
      academicYearId: year.id,
      termId: term.id,
      classId: klass.id,
      sectionId,
      classSubjectId: classSubject.id,
      subjectId: classSubject.subjectId,
      kind: 'test',
      testType: dto.testType,
      name: dto.name,
      maxMarks: dto.maxMarks,
      heldOn,
      createdBy: userId,
    });
    if (!row) throw notFound();
    await recordSubject(row.id);
    // Creating a test writes no audit row: the row itself records who and when (§7.1).
    return toAssessmentDto(row, {
      createdByMe: true,
      markedCount: 0,
      canEnterMarks: true,
      locked: false,
    });
  }

  // ------------------------------------------------------------------------------ edit, void

  /**
   * §2.3: name, held_on, max marks, by the creator or an assessment.define holder, inside the
   * caller's write scope; refused once any mark exists (ASSESSMENT_HAS_MARKS).
   */
  @Transactional()
  async update(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateAssessmentDto,
  ): Promise<AssessmentDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, row } = await this.lockForEdit(session, schoolId, id);
    const changes: Changes = {};
    const data: { name?: string; heldOn?: Date; maxMarks?: number } = {};
    if (dto.name !== undefined && dto.name !== row.name) {
      data.name = dto.name;
      changes.name = { from: row.name, to: dto.name };
    }
    if (dto.heldOn !== undefined && dto.heldOn !== toDateString(row.heldOn)) {
      const heldOn = fromDateString(dto.heldOn);
      const term = await this.terms.findById(schoolId, row.termId);
      if (!term || heldOn < term.startsOn || heldOn > term.endsOn)
        throw assessmentOutsideTerm(row.id);
      // The caller must still write it on its new date.
      const moved = await this.permissions.marksWriteScopeOf(session, heldOn);
      if (moved === null || !scopeReaches(moved, 'write', row.sectionId, row.subjectId)) {
        throw fieldRefused(
          'heldOn',
          ErrorCode.INVALID_VALUE,
          'You do not teach this subject in this section on that date',
        );
      }
      data.heldOn = heldOn;
      changes.heldOn = { from: toDateString(row.heldOn), to: dto.heldOn };
    }
    if (dto.maxMarks !== undefined && dto.maxMarks !== row.maxMarks) {
      data.maxMarks = dto.maxMarks;
      changes.maxMarks = { from: row.maxMarks, to: dto.maxMarks };
    }
    if (Object.keys(data).length === 0) return (await this.views(session, scope, [row]))[0]!;
    if (await this.marks.anyFor(schoolId, scope, row.id)) throw assessmentHasMarks(row.id);
    const updated = await this.assessments.update(schoolId, scope, id, data);
    if (!updated) throw notFound();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'assessment.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return (await this.views(session, scope, [updated]))[0]!;
  }

  /** §2.4: a test before its sheet is submitted (not locked), an exam before any sheet is. */
  @Transactional()
  async void(session: SchoolSessionContext, id: bigint, reason: string): Promise<AssessmentDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, row } = await this.lockForEdit(session, schoolId, id);
    const voided = await this.assessments.void(schoolId, scope, id, {
      voidedBy: userId,
      voidReason: reason,
    });
    if (!voided) throw notFound();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'assessment.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason,
      metadata: {
        kind: row.kind,
        sectionId: row.sectionId.toString(),
        termId: row.termId.toString(),
      },
    });
    return (await this.views(session, scope, [voided]))[0]!;
  }

  /**
   * The edit and void pre-steps: the write scope of held_on, the row locked (schema notes), the
   * creator or an assessment.define holder, not voided, not locked, the year not closed.
   */
  private async lockForEdit(
    session: SchoolSessionContext,
    schoolId: SchoolId,
    id: bigint,
  ): Promise<{ scope: MarksScope<'write'>; row: AssessmentRecord }> {
    const on = await this.assessments.scopeDateOf(schoolId, id);
    const scope = on && (await this.permissions.marksWriteScopeOf(session, on));
    if (!scope) throw notFound();
    const row = await readLocked(
      () => this.assessments.findWritable(schoolId, scope, id),
      (found) => this.assessments.lockIfUnchanged(schoolId, scope, found),
    );
    const isCreator = row.createdBy === session.access.userId;
    if (!isCreator && !session.access.capabilities.has(Capability.ASSESSMENT_DEFINE))
      throw notAuthor();
    if (row.voidedAt !== null) throw assessmentVoided(row.id);
    if (row.lockedAt !== null || (await this.sheetLocks(schoolId, row))) throw assessmentLocked(row.id);
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    return { scope, row };
  }

  /** Whether the assessment's section-term sheet locks it (submitted or later, R265). */
  async sheetLocks(
    schoolId: SchoolId,
    row: Pick<AssessmentRecord, 'sectionId' | 'termId'>,
  ): Promise<boolean> {
    return (await this.assessments.lockingSheets(schoolId, [row])).size > 0;
  }

  // ------------------------------------------------------------------------------- set-up

  /**
   * §5 (slice 29 moved here, R257): one exam per live class-subject per live section of each
   * class, for a term; idempotent (an existing live exam is counted, never duplicated); a class the
   * term is not held for is skipped. The exam is dated the term's last day, max marks from the
   * class-subject; both can be edited until a mark exists.
   */
  @Transactional()
  async setUpExams(
    session: SchoolSessionContext,
    termId: bigint,
    dto: SetUpExamsDto,
  ): Promise<ExamSetUpResultDto> {
    const { schoolId, userId } = this.context.actor();
    const term = await this.terms.findById(schoolId, termId);
    if (!term) throw notFound();
    const year = await this.years.findById(schoolId, term.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    const scope = await this.permissions.marksWriteScopeOf(session, term.endsOn);
    if (scope === null) throw notFound();

    const { rows: yearClasses } = await this.classes.list(schoolId, {
      academicYearId: year.id,
      status: 'active',
      sort: 'name',
      skip: 0,
      take: ALL_CLASSES,
    });
    let classes = yearClasses;
    if (dto.classIds !== undefined) {
      const wanted = [...new Set(dto.classIds)];
      const byId = new Map(yearClasses.map((klass) => [klass.id.toString(), klass]));
      const missing = wanted.findIndex((classId) => !byId.has(classId));
      if (missing >= 0) {
        throw fieldRefused(
          `classIds[${missing}]`,
          ErrorCode.REFERENCE_NOT_FOUND,
          "Not an active class of the term's year",
        );
      }
      classes = wanted.map((classId) => byId.get(classId)!);
    }

    const skippedClassIds = new Set(term.skips.map((skip) => skip.classId));
    const existing = await this.assessments.liveExamKeys(
      schoolId,
      scope,
      termId,
      classes.map((klass) => klass.id),
    );
    const wanted: NewExam[] = [];
    let skipped = 0;
    let present = 0;
    for (const klass of classes) {
      const subjects = await this.classSubjects.liveForClass(schoolId, klass.id);
      const sections = await this.sections.listLive(schoolId, klass.id);
      // A section whose sheet for the term is submitted or later takes no new exam (R265).
      const locked = await this.assessments.lockingSheets(
        schoolId,
        sections.map((section) => ({ sectionId: section.id, termId })),
      );
      for (const section of sections) {
        for (const subject of subjects) {
          if (!scopeReaches(scope, 'write', section.id, subject.subjectId)) continue;
          if (skippedClassIds.has(klass.id) || locked.has(sectionTermKey(section.id, termId))) {
            skipped++;
          } else if (existing.has(examKey(section.id, subject.id))) {
            present++;
          } else {
            wanted.push({
              academicYearId: year.id,
              termId,
              classId: klass.id,
              sectionId: section.id,
              classSubjectId: subject.id,
              subjectId: subject.subjectId,
              name: `${term.name} exam`.slice(0, 80),
              maxMarks: subject.examMaxMarks,
              heldOn: term.endsOn,
              createdBy: userId,
            });
          }
        }
      }
    }
    const created = await this.assessments.createExams(schoolId, scope, wanted);
    // A pair a concurrent set-up created between the read and the insert counts as existing.
    const result = { created, existing: present + (wanted.length - created), skipped };
    if (created > 0) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'exams.set_up',
        subjectType: 'academic_term',
        subjectId: termId,
        metadata: {
          classIds: classes.map((klass) => klass.id.toString()).join(','),
          created: result.created,
          existing: result.existing,
          skipped: result.skipped,
        },
      });
    }
    return result;
  }
}
