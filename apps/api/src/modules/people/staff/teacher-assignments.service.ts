import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { readLocked } from '../../../common/locking';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { AcademicYearRepository } from '../../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { ClassRepository } from '../../../repositories/class.repository';
import { SectionRepository } from '../../../repositories/section.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { SubjectRepository } from '../../../repositories/subject.repository';
import {
  isActiveOn,
  TeacherAssignmentRepository,
  type NewTeacherAssignment,
  type TeacherAssignmentRecord,
} from '../../../repositories/teacher-assignment.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import {
  classArchived,
  fromDateString,
  toDateString,
  yearClosed,
} from '../../academics/academics.shared';
import { addDays, SchoolClock } from '../../../common/school-clock';
import type {
  CreateTeacherAssignmentDto,
  EndTeacherAssignmentDto,
  ListTeacherAssignmentsQueryDto,
  TeacherAssignmentDto,
} from './staff.dto';
import { selfForbidden, staffNotActive } from './staff.errors';
import { StaffService } from './staff.service';

// contracts/slice-4.md §4. "Today" is the school's (SchoolClock). Ending means "no longer counts
// from today"; voiding means "never counted" (a row that had not begun, or began today). Rows are
// never deleted (rule 4). Lock order: staff row -> class -> year -> assignment rows.

const SUBJECT = 'teacher_assignment';
const CLASS_TEACHER_EXCL = 'teacher_assignments_class_teacher_excl';

/** What ending one row did: nothing, a last day, or a void. */
type EndOutcome = { kind: 'unchanged' } | { kind: 'ended'; endsOn: Date } | { kind: 'voided' };

const maxDate = (a: Date, b: Date): Date => (a > b ? a : b);

/** The requested start, or by default today but never before the year begins. */
const resolveStartsOn = (dto: CreateTeacherAssignmentDto, today: Date, yearStartsOn: Date): Date =>
  dto.startsOn === undefined ? maxDate(today, yearStartsOn) : fromDateString(dto.startsOn);

export function toTeacherAssignmentDto(
  row: TeacherAssignmentRecord,
  today: Date,
): TeacherAssignmentDto {
  return {
    id: row.id.toString(),
    staffId: row.staffId.toString(),
    staffFullName: row.staffFullName,
    academicYearId: row.academicYearId.toString(),
    academicYearName: row.academicYearName,
    classId: row.classId.toString(),
    className: row.className,
    sectionId: row.sectionId?.toString() ?? null,
    sectionName: row.sectionName,
    subjectId: row.subjectId?.toString() ?? null,
    subjectName: row.subjectName,
    role: row.role,
    startsOn: toDateString(row.startsOn),
    endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
    voidedAt: row.voidedAt,
    activeToday: isActiveOn(row, today),
    createdAt: row.createdAt,
  };
}

const classTeacherExists = (conflicts: TeacherAssignmentRecord[]): ApiException =>
  new ApiException(
    409,
    ErrorCode.CLASS_TEACHER_EXISTS,
    'The section already has a class teacher for those dates.',
    {
      conflicts: conflicts.map((c) => ({
        assignmentId: c.id.toString(),
        staffId: c.staffId.toString(),
        staffFullName: c.staffFullName,
        startsOn: toDateString(c.startsOn),
        endsOn: c.endsOn === null ? null : toDateString(c.endsOn),
      })),
    },
  );

@Injectable()
export class TeacherAssignmentsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly assignments: TeacherAssignmentRepository,
    private readonly staffService: StaffService,
    private readonly staff: StaffRepository,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly sections: SectionRepository,
    private readonly subjects: SubjectRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  async list(
    staffId: bigint,
    query: ListTeacherAssignmentsQueryDto,
  ): Promise<Page<TeacherAssignmentDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.staff.findById(schoolId, staffId))) throw notFound();
    const today = await this.clock.today(schoolId);
    const { rows, total } = await this.assignments.listForStaff(schoolId, staffId, {
      includeEnded: query.includeEnded ?? false,
      today,
      ...(query.academicYearId === undefined
        ? {}
        : { academicYearId: BigInt(query.academicYearId) }),
      sort: query.sort ?? '-startsOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((row) => toTeacherAssignmentDto(row, today)),
      query,
      total,
    );
  }

  /**
   * R23 race: the exclusion constraint aborted the transaction, so the conflicting rows are read
   * here, in a fresh statement, and answered as the in-transaction check would have.
   */
  async create(
    session: SchoolSessionContext,
    staffId: bigint,
    dto: CreateTeacherAssignmentDto,
  ): Promise<TeacherAssignmentDto> {
    const actor = this.context.actor();
    assertShape(dto);
    try {
      return await this.createInTransaction(actor, session, staffId, dto);
    } catch (error) {
      if (summariseDatabaseError(error)?.constraint !== CLASS_TEACHER_EXCL || !dto.sectionId) {
        throw error;
      }
      // The default start depends on the class's year, so it is resolved as the transaction did.
      const klass = await this.classes.findById(actor.schoolId, BigInt(dto.classId));
      const year = klass && (await this.years.findById(actor.schoolId, klass.academicYearId));
      if (!year) throw error;
      const today = await this.clock.today(actor.schoolId);
      const startsOn = resolveStartsOn(dto, today, year.startsOn);
      const endsOn = dto.endsOn ? fromDateString(dto.endsOn) : null;
      const conflicts = await this.assignments.findClassTeacherConflicts(
        actor.schoolId,
        BigInt(dto.sectionId),
        startsOn,
        endsOn,
      );
      throw conflicts.length > 0 ? classTeacherExists(conflicts) : error;
    }
  }

  async end(id: bigint, dto: EndTeacherAssignmentDto): Promise<TeacherAssignmentDto> {
    const actor = this.context.actor();
    await this.endInTransaction(actor, id, dto);
    const row = await this.assignments.findById(actor.schoolId, id);
    if (!row) throw notFound();
    return toTeacherAssignmentDto(row, await this.clock.today(actor.schoolId));
  }

  /**
   * R17: a staff member leaving ends every row not yet ended, as §4.4 with no endsOn. The caller
   * holds the staff row lock. Returns how many rows changed.
   */
  async endAllForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    actorUserId: bigint,
    now: Date,
    today: Date,
  ): Promise<number> {
    let changed = 0;
    for (const row of await this.assignments.findNotEndedForStaff(schoolId, staffId, today)) {
      const locked = await this.lockRow(schoolId, row.id);
      const outcome = await this.endRow(schoolId, locked, actorUserId, now, today, undefined);
      if (outcome.kind !== 'unchanged') changed++;
    }
    return changed;
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    session: SchoolSessionContext,
    staffId: bigint,
    dto: CreateTeacherAssignmentDto,
  ): Promise<TeacherAssignmentDto> {
    const { schoolId, userId } = actor;
    const staff = await this.staffService.lock(schoolId, staffId);
    // R74 (§4.3): a teacher's row scope comes from their own assignments and class.manage is
    // delegable, so assigning yourself would widen your own scope. Only a role.manage holder
    // (a principal) may. Ending your own row only narrows it, so §4.4 does not refuse it.
    if (staff.userId === userId && !session.access.capabilities.has(Capability.ROLE_MANAGE)) {
      throw selfForbidden();
    }

    // References, each a 422 when not in this school (the year is the class's, never input).
    // The class and its year are locked first, as the academics module locks them, so a class
    // or section archive, a year move or a year close cannot interleave with this insert; the
    // section is read under the class lock.
    const classId = BigInt(dto.classId);
    const klass = await readLocked(
      () => this.classes.findById(schoolId, classId),
      (row) => this.classes.lockIfUnchanged(schoolId, row),
      () => fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class'),
    );
    const year = await readLocked(
      () => this.years.findById(schoolId, klass.academicYearId),
      (row) => this.years.lockIfUnchanged(schoolId, row),
    );
    const section = dto.sectionId
      ? await this.sections.findById(schoolId, BigInt(dto.sectionId))
      : null;
    if (dto.sectionId && (!section || section.classId !== classId)) {
      throw fieldRefused('sectionId', ErrorCode.REFERENCE_NOT_FOUND, 'No such section in the class');
    }
    const subject = dto.subjectId
      ? await this.subjects.findById(schoolId, BigInt(dto.subjectId))
      : null;
    if (dto.subjectId && !subject) {
      throw fieldRefused('subjectId', ErrorCode.REFERENCE_NOT_FOUND, 'No such subject');
    }

    // Dates: never before today (no backdated scope), within the year.
    const today = await this.clock.today(schoolId);
    const startsOn = resolveStartsOn(dto, today, year.startsOn);
    if (startsOn < today) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, 'startsOn must not be before today');
    }
    if (startsOn < year.startsOn || startsOn > year.endsOn) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, 'startsOn must be within the academic year');
    }
    const endsOn = dto.endsOn ? fromDateString(dto.endsOn) : null;
    if (endsOn && (endsOn < startsOn || endsOn > year.endsOn)) {
      throw fieldRefused(
        'endsOn',
        ErrorCode.INVALID_VALUE,
        'endsOn must be on or after startsOn and within the academic year',
      );
    }

    // State refusals, in contract order.
    if (staff.status !== 'active') throw staffNotActive();
    if (year.status === 'closed') throw yearClosed();
    if (klass.status === 'archived') throw classArchived();
    if (section?.deletedAt) {
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'An archived section cannot be assigned.');
    }
    if (subject?.deletedAt) {
      throw new ApiException(409, ErrorCode.SUBJECT_ARCHIVED, 'An archived subject cannot be assigned.');
    }

    const data: NewTeacherAssignment = {
      staffId,
      academicYearId: klass.academicYearId,
      classId,
      sectionId: section?.id ?? null,
      subjectId: subject?.id ?? null,
      role: dto.role,
      startsOn,
      endsOn,
    };
    // Retry-safety: under the staff lock, the same live assignment is a pointer, not a duplicate.
    const same = await this.assignments.findSameOverlapping(schoolId, data);
    if (same !== null) {
      throw new ApiException(
        409,
        ErrorCode.ASSIGNMENT_EXISTS,
        'This assignment already exists for those dates.',
        { assignmentId: same.toString() },
      );
    }

    // R23: one class teacher per section at any date; replacing ends or voids the current one.
    const replaced: { row: TeacherAssignmentRecord; outcome: EndOutcome }[] = [];
    if (dto.role === 'class_teacher' && section) {
      const conflicts = await this.assignments.findClassTeacherConflicts(
        schoolId,
        section.id,
        startsOn,
        endsOn,
      );
      if (conflicts.length > 0 && dto.replaceCurrent !== true) throw classTeacherExists(conflicts);
      const now = new Date();
      for (const conflict of conflicts) {
        const row = await this.lockRow(schoolId, conflict.id);
        if (row.voidedAt !== null) continue;
        // Ended the day before the new row starts if it began earlier, otherwise voided. It
        // overlaps the new row, so that day is before its own last day.
        const outcome =
          row.startsOn < startsOn
            ? await this.applyEnd(schoolId, row, addDays(startsOn, -1))
            : await this.applyVoid(schoolId, row, userId, now);
        replaced.push({ row, outcome });
      }
    }

    const created = await this.assignments.create(schoolId, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'teacher_assignment.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      metadata: {
        staffId: staffId.toString(),
        role: data.role,
        classId: classId.toString(),
        sectionId: data.sectionId?.toString() ?? null,
        subjectId: data.subjectId?.toString() ?? null,
        startsOn: toDateString(startsOn),
        endsOn: endsOn === null ? null : toDateString(endsOn),
      },
    });
    for (const { row, outcome } of replaced) {
      await this.auditEnded(schoolId, userId, row.id, outcome, undefined, created.id);
    }
    return toTeacherAssignmentDto(created, today);
  }

  @Transactional()
  private async endInTransaction(
    actor: Actor,
    id: bigint,
    dto: EndTeacherAssignmentDto,
  ): Promise<void> {
    const { schoolId, userId } = actor;
    const found = await this.assignments.findById(schoolId, id);
    if (!found) throw notFound();
    await this.staffService.lock(schoolId, found.staffId);
    const row = await this.lockRow(schoolId, id);
    const today = await this.clock.today(schoolId);
    const endsOn = dto.endsOn === undefined ? undefined : fromDateString(dto.endsOn);
    const outcome = await this.endRow(schoolId, row, userId, new Date(), today, endsOn);
    if (outcome.kind !== 'unchanged') {
      await this.auditEnded(schoolId, userId, id, outcome, dto.reason, undefined);
    }
  }

  /**
   * §4.4 on a locked row. Already voided or ended before today: unchanged. No `endsOn`: begun
   * before today → last day yesterday, otherwise voided. With `endsOn` (a planned last day): it
   * must be today or later, not before the row's start, and not after its current last day.
   */
  private async endRow(
    schoolId: SchoolId,
    row: TeacherAssignmentRecord,
    actorUserId: bigint,
    now: Date,
    today: Date,
    endsOn: Date | undefined,
  ): Promise<EndOutcome> {
    if (row.voidedAt !== null || (row.endsOn !== null && row.endsOn < today)) {
      return { kind: 'unchanged' };
    }
    if (endsOn === undefined) {
      return row.startsOn < today
        ? this.applyEnd(schoolId, row, addDays(today, -1))
        : this.applyVoid(schoolId, row, actorUserId, now);
    }
    if (endsOn < today || endsOn < row.startsOn || (row.endsOn !== null && endsOn > row.endsOn)) {
      throw fieldRefused(
        'endsOn',
        ErrorCode.INVALID_VALUE,
        'endsOn must be today or later, on or after the start, and not after the current last day',
      );
    }
    return this.applyEnd(schoolId, row, endsOn);
  }

  private async applyEnd(
    schoolId: SchoolId,
    row: TeacherAssignmentRecord,
    endsOn: Date,
  ): Promise<EndOutcome> {
    if (row.endsOn !== null && row.endsOn.getTime() === endsOn.getTime()) return { kind: 'unchanged' };
    await this.assignments.setEndsOn(schoolId, row.id, endsOn);
    return { kind: 'ended', endsOn };
  }

  private async applyVoid(
    schoolId: SchoolId,
    row: TeacherAssignmentRecord,
    actorUserId: bigint,
    now: Date,
  ): Promise<EndOutcome> {
    await this.assignments.void(schoolId, row.id, actorUserId, now);
    return { kind: 'voided' };
  }

  private async auditEnded(
    schoolId: SchoolId,
    actorUserId: bigint,
    id: bigint,
    outcome: EndOutcome,
    reason: string | undefined,
    replacedBy: bigint | undefined,
  ): Promise<void> {
    if (outcome.kind === 'unchanged') return;
    await this.audit.record(schoolId, {
      actorUserId,
      action: 'teacher_assignment.ended',
      subjectType: SUBJECT,
      subjectId: id,
      ...(reason === undefined ? {} : { reason }),
      metadata: {
        ...(outcome.kind === 'ended' ? { endsOn: toDateString(outcome.endsOn) } : { voided: true }),
        ...(replacedBy === undefined ? {} : { replacedBy: replacedBy.toString() }),
      },
    });
  }

  private lockRow(schoolId: SchoolId, id: bigint): Promise<TeacherAssignmentRecord> {
    return readLocked(
      () => this.assignments.findById(schoolId, id),
      (row) => this.assignments.lockIfUnchanged(schoolId, row),
    );
  }
}

/** Role-dependent presence (contract §4.3), before any database read. */
function assertShape(dto: CreateTeacherAssignmentDto): void {
  if (dto.role === 'class_teacher') {
    if (!dto.sectionId) {
      throw fieldRefused('sectionId', ErrorCode.INVALID_VALUE, 'A class teacher needs a section');
    }
    if (dto.subjectId) {
      throw fieldRefused('subjectId', ErrorCode.INVALID_VALUE, 'A class teacher has no subject');
    }
    return;
  }
  if (!dto.subjectId) {
    throw fieldRefused('subjectId', ErrorCode.INVALID_VALUE, 'A subject teacher needs a subject');
  }
  if (dto.replaceCurrent !== undefined) {
    throw fieldRefused(
      'replaceCurrent',
      ErrorCode.INVALID_VALUE,
      'replaceCurrent applies to a class teacher only',
    );
  }
}
