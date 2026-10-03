import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, READMISSIBLE_STATUSES } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../../repositories/enrolment.repository';
import { StudentGuardianRepository } from '../../../repositories/student-guardian.repository';
import { StudentStatusChangeRepository } from '../../../repositories/student-status-change.repository';
import { StudentRepository } from '../../../repositories/student.repository';
import { SchoolClock } from '../../../common/school-clock';
import { EnrolmentsService } from '../students/enrolments.service';
import { StudentsService } from '../students/students.service';
import type { StudentDetailDto } from '../students/students.dto';
import {
  assertNotFuture,
  feePayerRequired,
  illegalTransition,
  primaryContactRequired,
  ROLL_NO_UNIQUE,
  rollNoTaken,
} from '../students/students.shared';
import type { ReadmitDto } from './admissions.dto';
import { fieldRefused } from '../../../common/errors/api-exception';
import { fromDateString } from '../../academics/academics.shared';

/**
 * POST /students/:id/readmit (contracts/slice-6.md §3.7, R26): a former student (withdrawn,
 * transferred, alumni) becomes active again with a new enrolment; the admission number and the
 * live guardian links are kept. Decided under the student's row lock, so a resubmit finds the
 * student active and is refused (409 ILLEGAL_STATUS_TRANSITION), never a second enrolment.
 */
@Injectable()
export class ReadmissionService {
  constructor(
    private readonly context: SchoolContext,
    private readonly studentsService: StudentsService,
    private readonly students: StudentRepository,
    private readonly enrolmentsService: EnrolmentsService,
    private readonly enrolments: EnrolmentRepository,
    private readonly links: StudentGuardianRepository,
    private readonly statusChanges: StudentStatusChangeRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  async readmit(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReadmitDto,
  ): Promise<StudentDetailDto> {
    try {
      return await this.readmitInTransaction(session, id, dto);
    } catch (error) {
      throw await this.rollNoConflict(error, dto);
    }
  }

  /**
   * A roll number taken by a concurrent write since the in-transaction check (the insert hit the
   * unique index; the transaction is rolled back): the same 409, naming the holder read afresh.
   */
  private async rollNoConflict(error: unknown, dto: ReadmitDto): Promise<unknown> {
    const rollNo = dto.rollNo ?? null;
    if (rollNo === null || summariseDatabaseError(error)?.constraint !== ROLL_NO_UNIQUE) {
      return error;
    }
    const schoolId = this.context.schoolId;
    const sectionId = BigInt(dto.sectionId);
    const holder = await this.enrolments.findActiveByRollNo(schoolId, sectionId, rollNo);
    return holder ? rollNoTaken(holder.id) : error;
  }

  @Transactional()
  private async readmitInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReadmitDto,
  ): Promise<StudentDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const student = await this.studentsService.lock(schoolId, scopeOf(session), id);
    if (!READMISSIBLE_STATUSES.includes(student.status)) {
      throw illegalTransition(
        { from: student.status, to: 'active' },
        'Only a withdrawn, transferred or alumni student can be readmitted.',
      );
    }

    const today = await this.clock.today(schoolId);
    const readmittedOn = dto.readmittedOn === undefined ? today : fromDateString(dto.readmittedOn);
    assertNotFuture(readmittedOn, today, 'readmittedOn');
    const last = await this.statusChanges.latestForStudent(schoolId, id);
    const earliest =
      last && last.effectiveOn > student.admittedOn ? last.effectiveOn : student.admittedOn;
    if (readmittedOn < earliest) {
      throw fieldRefused(
        'readmittedOn',
        ErrorCode.INVALID_VALUE,
        'readmittedOn must be on or after the student left',
      );
    }

    const classId = BigInt(dto.classId);
    const sectionId = BigInt(dto.sectionId);
    const { klass } = await this.enrolmentsService.lockTarget(schoolId, classId, sectionId);

    // R28 and R29 must still hold over the kept links; the office fixes the links first.
    const live = await this.links.liveForStudent(schoolId, scopeOf(session), id);
    if (live.filter((link) => link.isPrimaryContact).length !== 1) throw primaryContactRequired();
    if (!live.some((link) => link.isFeePayer)) throw feePayerRequired();

    const rollNo = dto.rollNo ?? null;
    if (rollNo !== null) {
      const holder = await this.enrolments.findActiveByRollNo(schoolId, sectionId, rollNo);
      if (holder) throw rollNoTaken(holder.id);
    }

    const updated = await this.students.update(schoolId, id, { status: 'active' });
    const enrolment = await this.enrolments.create(schoolId, {
      studentId: id,
      academicYearId: klass.academicYearId,
      classId,
      sectionId,
      rollNo,
      startedOn: readmittedOn,
    });
    await this.statusChanges.record(schoolId, {
      studentId: id,
      fromStatus: student.status,
      toStatus: 'active',
      reason: dto.reason,
      changedBy: userId,
      effectiveOn: readmittedOn,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'student.readmitted',
      subjectType: 'student',
      subjectId: id,
      reason: dto.reason,
      metadata: {
        enrolmentId: enrolment.id.toString(),
        classId: dto.classId,
        sectionId: dto.sectionId,
        fromStatus: student.status,
      },
    });
    return this.studentsService.toDetailDto(schoolId, session, updated);
  }
}
