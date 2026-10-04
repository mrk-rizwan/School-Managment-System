import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  Capability,
  ErrorCode,
  remarkVisibilitiesFor,
  type RemarkVisibility,
  type StudentStatus,
} from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import {
  REMARK_SUPERSEDES_UNIQUE,
  RemarkRepository,
  type RemarkRecord,
} from '../../repositories/remark.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StudentRepository, type StudentRecord } from '../../repositories/student.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { fromDateString, yearClosed } from '../academics/academics.shared';
import { notAssignedOnDate, notAuthor } from '../access/access.errors';
import { PermissionsService } from '../access/permissions.service';
import type {
  CorrectRemarkDto,
  CreateRemarkDto,
  ListRemarksQueryDto,
  MyRemarkDto,
  MyRemarksQueryDto,
  RemarkDto,
} from './diary.dto';
import {
  rangeOf,
  requireStaffId,
  studentInCapacityScope,
  toMyRemarkDto,
  toRemarkDto,
  usableSubject,
} from './diary.shared';

// contracts/slice-13.md §3, §5, §6.4 (R139-R141, R143). A remark is never edited: a correction is
// a new row naming the one it replaces, whose superseded_at the database stamps. A remark hangs
// off the enrolment in force on its date, which the author's dated scope must cover.

const ENDPOINT = 'remarks';
/** A student who has left takes no new remark and no correction (decision 11). */
const LEFT: ReadonlySet<StudentStatus> = new Set(['withdrawn', 'transferred', 'alumni']);

export interface RemarkCreateOutcome {
  replayed: boolean;
  remark: RemarkDto;
}

const studentLeft = () =>
  new ApiException(409, ErrorCode.STUDENT_NOT_ACTIVE, 'The student has left the school.');

const remarkSuperseded = (supersededById: bigint | null) =>
  new ApiException(409, ErrorCode.REMARK_SUPERSEDED, 'This remark has already been corrected.', {
    supersededById: supersededById?.toString() ?? null,
  });

@Injectable()
export class RemarksService {
  constructor(
    private readonly context: SchoolContext,
    private readonly remarks: RemarkRepository,
    private readonly students: StudentRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly years: AcademicYearRepository,
    private readonly subjects: SubjectRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationService,
    private readonly permissions: PermissionsService,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------------ reads

  /** §5.1: staff see every visibility, across every enrolment of a student in today's scope. */
  async list(
    session: SchoolSessionContext,
    studentId: bigint,
    query: ListRemarksQueryDto,
  ): Promise<Page<RemarkDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const range = rangeOf(query);
    await this.requireStudent(schoolId, scope, studentId);
    const { rows, total } = await this.remarks.listForStudent(schoolId, scope, studentId, {
      ...range,
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.visibility === undefined ? {} : { visibilities: [query.visibility] }),
      includeSuperseded: query.includeSuperseded ?? false,
    });
    return toPage((await this.remarks.withNames(schoolId, rows)).map(toRemarkDto), query, total);
  }

  /**
   * §6.4: the capacity's visibilities in the query (an `internal` row does not exist here, not in
   * `total`), superseded rows included and marked (R141).
   */
  async listForCapacity(
    session: SchoolSessionContext,
    capacity: 'guardian' | 'student',
    studentId: bigint,
    query: MyRemarksQueryDto,
  ): Promise<Page<MyRemarkDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const range = rangeOf(query);
    if (!studentInCapacityScope(scope, studentId)) throw notFound();
    const { rows, total } = await this.remarks.listForStudent(schoolId, scope, studentId, {
      ...range,
      ...(query.category === undefined ? {} : { category: query.category }),
      visibilities: remarkVisibilitiesFor(capacity),
      includeSuperseded: true,
    });
    return toPage((await this.remarks.withNames(schoolId, rows)).map(toMyRemarkDto), query, total);
  }

  // ---------------------------------------------------------------------------------- create

  /** §5.2 with §3's pre-steps. */
  async create(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: CreateRemarkDto,
    rawKey: string | undefined,
  ): Promise<RemarkCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, studentId, dto, rawKey, (claim) =>
      this.createInTransaction(session, actor, studentId, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, remark: await this.get(session, id) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    studentId: bigint,
    dto: CreateRemarkDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    // Step 1.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'remark');
    const staffId = requireStaffId(session);

    // Step 2: in today's scope; not left (a suspended student may receive one).
    const student = await this.requireStudent(schoolId, scopeOf(session), studentId);
    if (LEFT.has(student.status)) throw studentLeft();

    // Step 3: not in the future; the enrolment in force on the date, its year open.
    const today = await this.clock.today(schoolId);
    const date = fromDateString(dto.date);
    if (date > today) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must be no later than today');
    }
    const enrolment = await this.enrolments.inForceOn(schoolId, scopeOf(session), studentId, date);
    if (!enrolment) {
      throw fieldRefused(
        'date',
        ErrorCode.INVALID_VALUE,
        'The student had no enrolment on this date.',
      );
    }
    const year = await this.years.findById(schoolId, enrolment.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();

    // Step 4: the enrolment's section in the caller's dated scope, any role (decision 9).
    const dated = await this.permissions.scopeOf(session, {
      capability: Capability.REMARK_WRITE,
      on: date,
    });
    if (dated === null) {
      throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');
    }
    if (dated.kind === 'sections' && !dated.sections.has(enrolment.sectionId)) {
      throw notAssignedOnDate();
    }

    // Step 5: the subject is a tag, not a right.
    const subjectId = dto.subjectId === undefined || dto.subjectId === null ? null : BigInt(dto.subjectId);
    if (subjectId !== null) await usableSubject(this.subjects, schoolId, subjectId);

    // Step 6.
    const settings = await this.settings.find(schoolId);
    const visibility: RemarkVisibility =
      dto.visibility ?? settings?.remarkDefaultVisibility ?? 'guardian';
    const row = await this.remarks.create(schoolId, {
      enrolmentId: enrolment.id,
      studentId,
      authorStaffId: staffId,
      subjectId,
      date,
      category: dto.category,
      text: dto.text,
      visibility,
      supersedesId: null,
      correctionReason: null,
    });
    await recordSubject(row.id);

    // Step 7 (R140): only when the school notifies and guardians can see it.
    const notified = (settings?.remarkNotifyGuardians ?? false) && visibility !== 'internal';
    if (notified) await this.notify(schoolId, row, student);

    // Step 8.
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'remark.created',
      subjectType: 'remark',
      subjectId: row.id,
      metadata: {
        studentId: studentId.toString(),
        enrolmentId: enrolment.id.toString(),
        date: dto.date,
        category: row.category,
        visibility: row.visibility,
        subjectId: subjectId?.toString() ?? null,
        notified,
      },
    });
    return row.id;
  }

  // ------------------------------------------------------------------------------- correct

  /** §5.3: a new row superseding `id`; the original is locked while it is still current. */
  async correct(session: SchoolSessionContext, id: bigint, dto: CorrectRemarkDto): Promise<RemarkDto> {
    const actor = this.context.actor();
    const newId = await recoverConstraint(
      REMARK_SUPERSEDES_UNIQUE,
      () => this.correctInTransaction(session, actor, id, dto),
      // The backstop: a concurrent correction committed between the read and the insert.
      async () => {
        const original = await this.remarks.findById(actor.schoolId, scopeOf(session), id);
        throw remarkSuperseded(original?.supersededById ?? null);
      },
    );
    return this.get(session, newId);
  }

  @Transactional()
  private async correctInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    id: bigint,
    dto: CorrectRemarkDto,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const scope = scopeOf(session);
    // Step 1: the remark's student in today's scope.
    const original = await this.remarks.findById(schoolId, scope, id);
    if (!original) throw notFound();
    // Step 2: the author, or a school-wide holder.
    const staffId = requireStaffId(session);
    if (original.authorStaffId !== staffId && scope.kind !== 'all') throw notAuthor();
    // Step 3, the retry-safety: locked only while current, so a second correction waits here
    // and then finds it superseded.
    if (!(await this.remarks.lockIfNotSuperseded(schoolId, id))) {
      const current = await this.remarks.findById(schoolId, scope, id);
      throw remarkSuperseded(current?.supersededById ?? null);
    }
    // Step 4.
    const year = await this.years.findById(schoolId, await this.yearOf(schoolId, scope, original));
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    const student = await this.requireStudent(schoolId, scope, original.studentId);
    if (LEFT.has(student.status)) throw studentLeft();

    // Step 5: the identity copied; the corrector is the author of the correction.
    const visibility = dto.visibility ?? original.visibility;
    const row = await this.remarks.create(schoolId, {
      enrolmentId: original.enrolmentId,
      studentId: original.studentId,
      authorStaffId: staffId,
      subjectId: original.subjectId,
      date: original.date,
      category: original.category,
      text: dto.text,
      visibility,
      supersedesId: original.id,
      correctionReason: dto.reason,
    });

    // Step 6: only when the correction first makes it guardian-visible (decision 10).
    const settings = await this.settings.find(schoolId);
    const notified =
      (settings?.remarkNotifyGuardians ?? false) &&
      original.visibility === 'internal' &&
      visibility !== 'internal';
    if (notified) await this.notify(schoolId, row, student);

    // Step 7.
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'remark.corrected',
      subjectType: 'remark',
      subjectId: row.id,
      reason: dto.reason,
      metadata: {
        studentId: original.studentId.toString(),
        originalId: original.id.toString(),
        visibilityFrom: original.visibility,
        visibilityTo: visibility,
        notified,
      },
    });
    return row.id;
  }

  // --------------------------------------------------------------------------------- helpers

  /** §5.4: every live guardian of the student; never the remark text, never to the student. */
  private async notify(schoolId: SchoolId, row: RemarkRecord, student: StudentRecord): Promise<void> {
    const guardianIds = await this.remarks.guardianRecipients(schoolId, row.studentId);
    await this.notifications.send(schoolId, {
      type: 'remark_posted',
      subject: { type: 'remark', id: row.id },
      recipients: guardianIds.map((guardianId) => ({ guardianId })),
      vars: { studentName: student.fullName, category: row.category, date: row.date },
    });
  }

  private async yearOf(schoolId: SchoolId, scope: Scope, remark: RemarkRecord): Promise<bigint> {
    const enrolment = await this.enrolments.findById(schoolId, scope, remark.enrolmentId);
    if (!enrolment) throw notFound();
    return enrolment.academicYearId;
  }

  private async requireStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<StudentRecord> {
    const student = await this.students.findById(schoolId, scope, studentId);
    if (!student) throw notFound();
    return student;
  }

  private async get(session: SchoolSessionContext, id: bigint): Promise<RemarkDto> {
    const schoolId = this.context.schoolId;
    const row = await this.remarks.findById(schoolId, scopeOf(session), id);
    if (!row) throw notFound();
    const [view] = await this.remarks.withNames(schoolId, [row]);
    if (!view) throw notFound();
    return toRemarkDto(view);
  }
}
