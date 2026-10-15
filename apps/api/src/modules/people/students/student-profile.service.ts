import { Injectable } from '@nestjs/common';
import { Capability } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { addDays, SchoolClock } from '../../../common/school-clock';
import { AcademicYearRepository } from '../../../repositories/academic-year.repository';
import { toDateString } from '../../academics/academics.shared';
import { PermissionsService } from '../../access/permissions.service';
import { AttendanceReadsService } from '../../attendance/attendance-reads.service';
import { DocumentVerificationService } from '../../documents/verification.service';
import { FinanceReportsService } from '../../finance-reports/finance-reports.service';
import { ClassRankingService } from '../../results/class-ranking.service';
import { MyResultsService } from '../../results/my-results.service';
import { TransportAssignmentsService } from '../../transport/transport-assignments.service';
import type {
  ProfileAttendanceDto,
  ProfileDocumentsDto,
  ProfileDuesDto,
  ProfileResultDto,
  ProfileTransportDto,
  StudentProfileDto,
} from './student-profile.dto';
import { StudentsService } from './students.service';

/** The student attendance read takes at most 365 days. */
const ATTENDANCE_MAX_DAYS = 365;

/**
 * GET /students/:id/profile (Phase 5 rule 38, R334; contracts/slice-42.md §1.3, §2.3): one page
 * composed of reads the caller can already make, each through its owning service, in the caller's
 * student.view scope (outside it the student is 404, as every student read). Dues need
 * fee.statement.view and the documents document.view; without them those sections are null. A GET:
 * nothing is written.
 */
@Injectable()
export class StudentProfileService {
  constructor(
    private readonly students: StudentsService,
    private readonly attendance: AttendanceReadsService,
    private readonly results: MyResultsService,
    private readonly rankings: ClassRankingService,
    private readonly finance: FinanceReportsService,
    private readonly documents: DocumentVerificationService,
    private readonly transport: TransportAssignmentsService,
    private readonly years: AcademicYearRepository,
    private readonly permissions: PermissionsService,
    private readonly clock: SchoolClock,
  ) {}

  async profile(session: SchoolSessionContext, studentId: bigint): Promise<StudentProfileDto> {
    // The scope check (404 outside it) comes first: nothing else is read for a student out of scope.
    const student = await this.students.get(session, studentId);
    const today = await this.clock.today(session.schoolId);
    const holds = (capability: Capability): boolean => this.permissions.holds(session.access, capability);
    return {
      studentId: student.id,
      fullName: student.fullName,
      admissionNo: student.admissionNo,
      status: student.status,
      admittedOn: student.admittedOn,
      dateOfBirth: student.dateOfBirth,
      current:
        student.current === null
          ? null
          : {
              academicYearId: student.current.academicYearId,
              academicYearName: student.current.academicYearName,
              className: student.current.className,
              sectionName: student.current.sectionName,
              rollNo: student.current.rollNo,
            },
      attendance: student.current === null ? null : await this.attendanceOf(session, studentId, student.current.academicYearId, today),
      latestResult: await this.latestResult(session, studentId),
      dues: holds(Capability.FEE_STATEMENT_VIEW) ? await this.dues(studentId) : null,
      documents: holds(Capability.DOCUMENT_VIEW) ? await this.documentsOf(session, studentId) : null,
      transport: await this.transportOf(session, studentId),
      asOf: toDateString(today),
    };
  }

  /** The current year to date (at most its last 365 days); null before the year starts. */
  private async attendanceOf(
    session: SchoolSessionContext,
    studentId: bigint,
    academicYearId: string,
    today: Date,
  ): Promise<ProfileAttendanceDto | null> {
    const year = await this.years.findById(session.schoolId, BigInt(academicYearId));
    if (!year) return null;
    const to = year.endsOn < today ? year.endsOn : today;
    const earliest = addDays(to, -ATTENDANCE_MAX_DAYS);
    const from = year.startsOn > earliest ? year.startsOn : earliest;
    if (from > to) return null;
    const read = await this.attendance.forStaff(session, studentId, {
      dateFrom: toDateString(from),
      dateTo: toDateString(to),
    });
    return {
      dateFrom: read.dateFrom,
      dateTo: read.dateTo,
      percentage: read.percentage,
      countedDays: read.countedDays,
      present: read.present,
      absent: read.absent,
      late: read.late,
      onLeave: read.onLeave,
    };
  }

  /** The newest published, live result the caller's sheet scope reads, with its class position. */
  private async latestResult(session: SchoolSessionContext, studentId: bigint): Promise<ProfileResultDto | null> {
    const page = await this.results.ofStudent(session, studentId, { page: 1, limit: 1 });
    const result = page.data[0];
    if (!result) return null;
    const place = result.isFinal ? null : await this.rankings.livePositionOf(session.schoolId, BigInt(result.id));
    return {
      resultId: result.id,
      academicYearName: result.academicYearName,
      termName: result.termName,
      isFinal: result.isFinal,
      className: result.className,
      sectionName: result.sectionName,
      percentBp: result.percentBp,
      grade: result.grade,
      passed: result.passed,
      position: result.position,
      positionOf: result.positionOf,
      classPosition: place?.classPosition ?? null,
      classPositionOf: place?.positionOf ?? null,
      revised: result.revised,
      publishedAt: result.publishedAt,
    };
  }

  private async dues(studentId: bigint): Promise<ProfileDuesDto> {
    const clearance = await this.finance.clearance(studentId);
    return { outstanding: clearance.outstanding, advance: clearance.advance, cleared: clearance.cleared };
  }

  private async documentsOf(session: SchoolSessionContext, studentId: bigint): Promise<ProfileDocumentsDto> {
    const checklist = await this.documents.checklist(session, studentId);
    return { complete: checklist.complete, items: checklist.items.map((i) => ({ type: i.type, status: i.status })) };
  }

  private async transportOf(session: SchoolSessionContext, studentId: bigint): Promise<ProfileTransportDto | null> {
    const { current } = await this.transport.forStudent(session, studentId);
    if (current === null) return null;
    return {
      routeName: current.routeName,
      stopName: current.stopName,
      pickupTime: current.pickupTime,
      startsOn: current.startsOn,
    };
  }
}
