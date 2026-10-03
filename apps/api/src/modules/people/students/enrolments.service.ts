import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
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
import { SchoolClock } from '../../../common/school-clock';
import { classArchived, fromDateString, yearClosed } from '../../academics/academics.shared';
import type {
  ChangeClassDto,
  ChangeSectionDto,
  EnrolmentDto,
  UpdateEnrolmentDto,
} from './students.dto';
import {
  assertNotFuture,
  enrolmentNotActive,
  ROLL_NO_UNIQUE,
  rollNoTaken,
} from './students.shared';
import { StudentsService, toEnrolmentDto } from './students.service';

// contracts/slice-6.md §5 (R37-R39). Every write locks the enrolment's student first (as every
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
  ) {}

  async listForStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    query: PageQueryDto,
  ): Promise<Page<EnrolmentDto>> {
    const schoolId = this.context.schoolId;
    await this.students.require(schoolId, scopeOf(session), studentId);
    const { rows, total } = await this.enrolments.listForStudent(schoolId, studentId, {
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
    try {
      return await this.setRollNoInTransaction(session, id, dto);
    } catch (error) {
      throw await this.rollNoConflict(error, scopeOf(session), id, dto.rollNo);
    }
  }

  /**
   * In place (R37): the section changes and the roll number is cleared. Another class's section
   * is 422 (use change-class); the same section is an unchanged 200.
   */
  @Transactional()
  async changeSection(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeSectionDto,
  ): Promise<EnrolmentDto> {
    const { schoolId, userId } = this.context.actor();
    const enrolment = await this.lockEnrolment(schoolId, scopeOf(session), id);
    if (enrolment.status !== 'active') throw enrolmentNotActive();
    const sectionId = BigInt(dto.sectionId);
    if (sectionId === enrolment.sectionId) return this.dto(schoolId, enrolment);
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
    await this.lockTarget(schoolId, enrolment.classId, sectionId);

    const updated = await this.enrolments.update(schoolId, id, { sectionId, rollNo: null });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'enrolment.section_changed',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        fromSectionId: enrolment.sectionId.toString(),
        toSectionId: dto.sectionId,
      },
    });
    return this.dto(schoolId, updated);
  }

  /**
   * R38, R39: in-year only; the old enrolment is closed (`left`, ended on effectiveOn) and a new
   * one opened on the same date, without a roll number. Never an edit. Returns the new one.
   */
  @Transactional()
  async changeClass(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeClassDto,
  ): Promise<EnrolmentDto> {
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
    const effectiveOn = fromDateString(dto.effectiveOn);
    assertNotFuture(effectiveOn, await this.clock.today(schoolId), 'effectiveOn');
    if (effectiveOn < enrolment.startedOn) {
      throw fieldRefused(
        'effectiveOn',
        ErrorCode.INVALID_VALUE,
        'effectiveOn must be on or after the current enrolment started',
      );
    }
    const target = await this.lockTarget(schoolId, classId, BigInt(dto.sectionId));

    await this.enrolments.close(schoolId, id, effectiveOn);
    const created = await this.enrolments.create(schoolId, {
      studentId: enrolment.studentId,
      academicYearId: target.klass.academicYearId,
      classId,
      sectionId: target.section.id,
      rollNo: null,
      startedOn: effectiveOn,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'enrolment.class_changed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { newEnrolmentId: created.id.toString(), toClassId: dto.classId },
    });
    return this.dto(schoolId, created);
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
  ): Promise<unknown> {
    if (rollNo === null || summariseDatabaseError(error)?.constraint !== ROLL_NO_UNIQUE)
      return error;
    const schoolId = this.context.schoolId;
    const own = await this.enrolments.findById(schoolId, scope, id);
    const holder =
      own && (await this.enrolments.findActiveByRollNo(schoolId, own.sectionId, rollNo));
    return holder ? rollNoTaken(holder.id) : error;
  }

  private async dto(schoolId: SchoolId, row: EnrolmentRecord): Promise<EnrolmentDto> {
    const [view] = await this.enrolments.withNames(schoolId, [row]);
    if (!view) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toEnrolmentDto(view);
  }
}
