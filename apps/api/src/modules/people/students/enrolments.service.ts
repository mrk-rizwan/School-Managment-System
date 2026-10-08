import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, concurrentUpdate, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { recoverConstraint } from '../../../common/errors/prisma-errors';
import { readLocked } from '../../../common/locking';
import { toPage, type Page, type PageQueryDto } from '../../../common/pagination';
import { SchoolContext } from '../../../common/school-context';
import {
  AcademicYearRepository,
  type AcademicYearRecord,
} from '../../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { ClassRepository, type ClassRecord } from '../../../repositories/class.repository';
import {
  EnrolmentRepository,
  type EnrolmentRecord,
} from '../../../repositories/enrolment.repository';
import { SectionRepository, type SectionRecord } from '../../../repositories/section.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import type { Scope } from '../../../tenancy/scope';
import { addDays, SchoolClock } from '../../../common/school-clock';
import {
  classArchived,
  fromDateString,
  toDateString,
  yearClosed,
} from '../../academics/academics.shared';
import type {
  ChangeClassDto,
  ChangeSectionDto,
  EnrolmentDto,
  SectionChangeResultDto,
  UpdateEnrolmentDto,
} from './students.dto';
import { AttendanceHistoryProbe } from './attendance-history-probe';
import {
  assertNotFuture,
  enrolmentNotActive,
  ROLL_NO_UNIQUE,
  rollNoTaken,
} from './students.shared';
import { StudentsService, toEnrolmentDto } from './students.service';

// contracts/slice-6.md §5 (R37-R39), amended by contracts/slice-10.md §8 (R174). Every write locks the enrolment's student first (as every
// other student write does), then reads the enrolment again under that lock. A target section,
// class and year are locked in that order, the same order section archiving takes them, so a
// section or class cannot be archived, nor a year closed, under a new or moved enrolment.

const SUBJECT = 'enrolment';

/** A locked enrolment target: section of the class, class active, year not closed. */
export interface EnrolmentTarget {
  year: AcademicYearRecord;
  klass: ClassRecord;
  section: SectionRecord;
}

@Injectable()
export class EnrolmentsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly enrolments: EnrolmentRepository,
    private readonly students: StudentsService,
    private readonly years: AcademicYearRepository,
    private readonly classes: ClassRepository,
    private readonly sections: SectionRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
    private readonly attendance: AttendanceHistoryProbe,
  ) {}

  async listForStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    query: PageQueryDto,
  ): Promise<Page<EnrolmentDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    await this.students.require(schoolId, scope, studentId);
    const { rows, total } = await this.enrolments.listForStudent(schoolId, scope, studentId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      (await this.enrolments.withNames(schoolId, rows)).map(toEnrolmentDto),
      query,
      total,
    );
  }

  /** R37. A roll number taken in the section is 409 ROLL_NO_TAKEN naming the holder. */
  async setRollNo(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateEnrolmentDto,
  ): Promise<EnrolmentDto> {
    return recoverConstraint(
      ROLL_NO_UNIQUE,
      () => this.setRollNoInTransaction(session, id, dto),
      (error) => this.rollNoConflict(error, scopeOf(session), id, dto.rollNo),
    );
  }

  /**
   * R174 (contracts/slice-10.md §8.2): close-old/open-new, never an edit. The old enrolment ends
   * on effectiveOn − 1 keeping its section and roll number; a new one opens on effectiveOn in the
   * target section without a roll number. Another class's section, or the current one, is 422.
   */
  @Transactional()
  async changeSection(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeSectionDto,
  ): Promise<SectionChangeResultDto> {
    const { schoolId, userId } = this.context.actor();
    const enrolment = await this.lockEnrolment(schoolId, scopeOf(session), id);
    if (enrolment.status !== 'active') throw enrolmentNotActive();
    const sectionId = BigInt(dto.sectionId);
    const target = await this.sections.findById(schoolId, sectionId);
    if (!target) {
      throw fieldRefused('sectionId', ErrorCode.REFERENCE_NOT_FOUND, 'No such section');
    }
    if (target.classId !== enrolment.classId) {
      throw fieldRefused(
        'sectionId',
        ErrorCode.INVALID_VALUE,
        'That section is of another class: use change-class',
      );
    }
    if (sectionId === enrolment.sectionId) {
      throw fieldRefused('sectionId', ErrorCode.INVALID_VALUE, 'Already in that section');
    }
    const effectiveOn = await this.assertEffectiveOn(schoolId, enrolment, dto.effectiveOn);
    const locked = await this.lockTarget(schoolId, enrolment.classId, sectionId);
    const result = await this.move(schoolId, enrolment, locked, effectiveOn);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'enrolment.section_changed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        fromSectionId: enrolment.sectionId.toString(),
        toSectionId: dto.sectionId,
        newEnrolmentId: result.opened.id,
        effectiveOn: dto.effectiveOn,
      },
    });
    return result;
  }

  /**
   * R38, R39, aligned with R174 (contracts/slice-10.md §8.3): in-year only; the old enrolment is
   * closed (`left`, ended on effectiveOn − 1) and a new one opened on effectiveOn, without a roll
   * number. Never an edit.
   */
  @Transactional()
  async changeClass(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeClassDto,
  ): Promise<SectionChangeResultDto> {
    const { schoolId, userId } = this.context.actor();
    const enrolment = await this.lockEnrolment(schoolId, scopeOf(session), id);
    if (enrolment.status !== 'active') throw enrolmentNotActive();
    const classId = BigInt(dto.classId);
    if (classId === enrolment.classId) {
      throw fieldRefused(
        'classId',
        ErrorCode.INVALID_VALUE,
        'That is the current class: use change-section',
      );
    }
    const klass = await this.classes.findById(schoolId, classId);
    if (!klass) throw fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class');
    if (klass.academicYearId !== enrolment.academicYearId) {
      throw new ApiException(
        409,
        ErrorCode.CLASS_IN_OTHER_YEAR,
        'A student moves only between classes of the same academic year.',
      );
    }
    const effectiveOn = await this.assertEffectiveOn(schoolId, enrolment, dto.effectiveOn);
    const target = await this.lockTarget(schoolId, classId, BigInt(dto.sectionId));
    const result = await this.move(schoolId, enrolment, target, effectiveOn);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'enrolment.class_changed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        newEnrolmentId: result.opened.id,
        toClassId: dto.classId,
        effectiveOn: dto.effectiveOn,
      },
    });
    return result;
  }

  /** effectiveOn: on or after the enrolment started, not in the future (422 on effectiveOn). */
  private async assertEffectiveOn(
    schoolId: SchoolId,
    enrolment: EnrolmentRecord,
    value: string,
  ): Promise<Date> {
    const effectiveOn = fromDateString(value);
    assertNotFuture(effectiveOn, await this.clock.today(schoolId), 'effectiveOn');
    if (effectiveOn < enrolment.startedOn) {
      throw fieldRefused(
        'effectiveOn',
        ErrorCode.INVALID_VALUE,
        'effectiveOn must be on or after the current enrolment started',
      );
    }
    return effectiveOn;
  }

  /**
   * The close/open of a section or class change (contracts/slice-10.md §8.1). No date belongs to
   * two enrolments: the old one ends on effectiveOn − 1 (zero-length when effectiveOn is its first
   * day: in force on no date, kept as history), the new one starts on effectiveOn. Refused when a
   * mark on the old enrolment is dated on or after effectiveOn (step 5). The old row is closed
   * before the insert (one active enrolment per student).
   */
  private async move(
    schoolId: SchoolId,
    enrolment: EnrolmentRecord,
    target: EnrolmentTarget,
    effectiveOn: Date,
  ): Promise<SectionChangeResultDto> {
    const lastRecordedOn = await this.attendance.lastRecordedOn(schoolId, enrolment.id);
    if (lastRecordedOn !== null && lastRecordedOn >= effectiveOn) {
      throw new ApiException(
        409,
        ErrorCode.ATTENDANCE_RECORDED_AFTER,
        'Attendance is recorded on or after that date: date the move after the last mark.',
        { lastRecordedOn: toDateString(lastRecordedOn) },
      );
    }
    const endedOn = addDays(effectiveOn, -1);
    // Under the student lock the row is still active, so exactly one row closes.
    if ((await this.enrolments.close(schoolId, enrolment.id, endedOn)) !== 1) {
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    const opened = await this.enrolments.create(schoolId, {
      studentId: enrolment.studentId,
      academicYearId: target.klass.academicYearId,
      classId: target.klass.id,
      sectionId: target.section.id,
      rollNo: null,
      startedOn: effectiveOn,
    });
    // The closed row as written (the target section may lie outside the caller's scope, so it is
    // not read back through it).
    const closed: EnrolmentRecord = { ...enrolment, status: 'left', endedOn };
    const [closedView, openedView] = await this.enrolments.withNames(schoolId, [closed, opened]);
    if (!closedView || !openedView) {
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    return { closed: toEnrolmentDto(closedView), opened: toEnrolmentDto(openedView) };
  }

  /**
   * Promotion apply (phase-4-academic.md slice 35, R297), batched for §7.2 (contracts/slice-35.md
   * §7): under the students' locks, closes the still-active enrolments among `items` as
   * `completed` on `endedOn` (the year's end) in one statement and, for promote and detain, opens
   * the next ones in their targets (locked by the caller with lockTarget) on `startedOn` with no
   * roll number (rule 30), in a second. Returns, per enrolment completed, the one it opened; an
   * enrolment no longer active (or outside the scope) is left out and the caller skips its row.
   */
  async completeYearMany(
    schoolId: SchoolId,
    scope: Scope,
    items: readonly { enrolmentId: bigint; next: { target: EnrolmentTarget; startedOn: Date } | null }[],
    endedOn: Date,
  ): Promise<Map<bigint, { opened: bigint | null }>> {
    if (items.length === 0) return new Map();
    const ids = items.map((i) => i.enrolmentId);
    const before = await this.enrolments.findManyByIds(schoolId, scope, ids);
    await this.students.lockMany(schoolId, before.map((e) => e.studentId));
    // Re-read under the locks: a change of class or an exit may have closed one meanwhile.
    const active = (await this.enrolments.findManyByIds(schoolId, scope, ids)).filter((e) => e.status === 'active');
    if ((await this.enrolments.completeMany(schoolId, active.map((e) => e.id), endedOn)) !== active.length) {
      throw concurrentUpdate();
    }
    const byId = new Map(items.map((i) => [i.enrolmentId, i.next]));
    const opening = active.flatMap((e) => {
      const next = byId.get(e.id);
      return next
        ? [
            {
              enrolmentId: e.id,
              row: {
                studentId: e.studentId,
                academicYearId: next.target.klass.academicYearId,
                classId: next.target.klass.id,
                sectionId: next.target.section.id,
                rollNo: null,
                startedOn: next.startedOn,
              },
            },
          ]
        : [];
    });
    const opened = await this.enrolments.createMany(schoolId, opening.map((o) => o.row));
    const studentOf = new Map(opening.map((o) => [o.enrolmentId, o.row.studentId]));
    return new Map(
      active.map((e) => {
        const studentId = studentOf.get(e.id);
        return [e.id, { opened: studentId === undefined ? null : (opened.get(studentId) ?? null) }];
      }),
    );
  }

  /**
   * Locks the section, its class and the class's year, in that order, and refuses a section of
   * another class (422 on sectionId), an archived section or class, or a closed year. For
   * admission and readmission too (slice 6B). Call inside a transaction.
   */
  async lockTarget(
    schoolId: SchoolId,
    classId: bigint,
    sectionId: bigint,
  ): Promise<EnrolmentTarget> {
    const section = await readLocked(
      () => this.sections.findById(schoolId, sectionId),
      (row) => this.sections.lockIfUnchanged(schoolId, row),
      () => fieldRefused('sectionId', ErrorCode.REFERENCE_NOT_FOUND, 'No such section'),
    );
    if (section.classId !== classId) {
      // An unknown class is named as such, not as a mismatch (a plain read: nothing to lock).
      if (!(await this.classes.findById(schoolId, classId))) {
        throw fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class');
      }
      throw fieldRefused('sectionId', ErrorCode.INVALID_VALUE, 'That section is of another class');
    }
    if (section.deletedAt !== null) {
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'That section is archived.');
    }
    const klass = await readLocked(
      () => this.classes.findById(schoolId, classId),
      (row) => this.classes.lockIfUnchanged(schoolId, row),
      () => fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class'),
    );
    if (klass.status === 'archived') throw classArchived();
    const year = await readLocked(
      () => this.years.findById(schoolId, klass.academicYearId),
      (row) => this.years.lockIfUnchanged(schoolId, row),
    );
    if (year.status === 'closed') throw yearClosed();
    return { year, klass, section };
  }

  @Transactional()
  private async setRollNoInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateEnrolmentDto,
  ): Promise<EnrolmentDto> {
    const { schoolId, userId } = this.context.actor();
    const enrolment = await this.lockEnrolment(schoolId, scopeOf(session), id);
    if (enrolment.status !== 'active') throw enrolmentNotActive();
    if (dto.rollNo === enrolment.rollNo) return this.dto(schoolId, enrolment);
    if (dto.rollNo !== null) {
      const holder = await this.enrolments.findActiveByRollNo(
        schoolId,
        enrolment.sectionId,
        dto.rollNo,
      );
      if (holder && holder.id !== id) throw rollNoTaken(holder.id);
    }
    const updated = await this.enrolments.update(schoolId, id, { rollNo: dto.rollNo });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'enrolment.roll_no_set',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { from: enrolment.rollNo, to: dto.rollNo },
    });
    return this.dto(schoolId, updated);
  }

  /**
   * Reads the enrolment in scope, locks its student, and reads the enrolment again under that
   * lock. Call inside a transaction.
   */
  private async lockEnrolment(
    schoolId: SchoolId,
    scope: Scope,
    id: bigint,
  ): Promise<EnrolmentRecord> {
    const enrolment = await this.enrolments.findById(schoolId, scope, id);
    if (!enrolment) throw notFound();
    await this.students.lock(schoolId, scope, enrolment.studentId);
    const current = await this.enrolments.findById(schoolId, scope, id);
    if (!current) throw notFound();
    return current;
  }

  /** The race loser of two writes of one roll number: the holder read in a fresh statement. */
  private async rollNoConflict(
    error: unknown,
    scope: Scope,
    id: bigint,
    rollNo: number | null,
  ): Promise<never> {
    if (rollNo === null) throw error;
    const schoolId = this.context.schoolId;
    const own = await this.enrolments.findById(schoolId, scope, id);
    const holder =
      own && (await this.enrolments.findActiveByRollNo(schoolId, own.sectionId, rollNo));
    throw holder ? rollNoTaken(holder.id) : error;
  }

  private async dto(schoolId: SchoolId, row: EnrolmentRecord): Promise<EnrolmentDto> {
    const [view] = await this.enrolments.withNames(schoolId, [row]);
    if (!view) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toEnrolmentDto(view);
  }
}
