import { Injectable } from '@nestjs/common';
import {
  attendancePercentage,
  dayValue,
  ErrorCode,
  isTeachingDay,
  type AttendanceStatus,
  type DayStatus,
  type PercentageDay,
  type ValuedDay,
} from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { addDays, SchoolClock } from '../../common/school-clock';
import { AttendanceAlertRepository } from '../../repositories/attendance-alert.repository';
import { AttendanceMarkRepository } from '../../repositories/attendance-mark.repository';
import { AttendanceRegisterRepository } from '../../repositories/attendance-register.repository';
import { AttendanceReportRepository } from '../../repositories/attendance-report.repository';
import { StudentRepository } from '../../repositories/student.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { fromDateString, parseRange, toDateString } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import type {
  AbsenteeRowDto,
  AbsenteesQueryDto,
  DailySummaryDto,
  DailySummaryQueryDto,
  LateQueryDto,
  ListRegistersQueryDto,
  PercentageQueryDto,
  PercentageRowDto,
  SectionDayDto,
  StudentAttendanceDto,
  StudentAttendanceQueryDto,
} from './attendance.dto';
import { alertsByChildDay, alertSummary, childDayKey } from './attendance.mappers';
import { TimetablePeriods } from './timetable-periods';

// contracts/slice-11.md §10 (R128-R131, R165, R167): the console, the reports and a student's
// attendance. The calendar is applied at read (§7): nothing stored says whether a date is a
// teaching day, so a holiday declared after the fact is excluded here, with no stored change.

const SUMMARY_MAX_DAYS = 91;
const STUDENT_MAX_DAYS = 365;

interface Period {
  period: number;
  status: AttendanceStatus;
  arrivedAt: string | null;
}

const optionalId = (value: string | undefined): bigint | undefined =>
  value === undefined ? undefined : BigInt(value);

@Injectable()
export class AttendanceReadsService {
  constructor(
    private readonly registers: AttendanceRegisterRepository,
    private readonly reports: AttendanceReportRepository,
    private readonly marks: AttendanceMarkRepository,
    private readonly alerts: AttendanceAlertRepository,
    private readonly students: StudentRepository,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly clock: SchoolClock,
    private readonly timetablePeriods: TimetablePeriods,
  ) {}

  /** §10.1: the registers console, live, in today's scope. */
  async registersOn(session: SchoolSessionContext, query: ListRegistersQueryDto): Promise<Page<SectionDayDto>> {
    const { schoolId } = session;
    const date = await this.pastOrToday(schoolId, query.date);
    const { periodsPerDay } = await this.settings.read(schoolId);
    const teachingDay = await this.calendar.isTeachingDay(schoolId, date);
    const { rows, total } = await this.registers.sectionDays(schoolId, scopeOf(session), {
      date,
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.recorded === undefined ? {} : { recorded: query.recorded }),
      sort: query.sort ?? 'className',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    // Phase 5 (contracts/slice-37.md §3.2): the period-mode rows' periods, named from the timetable.
    const periodRows = rows.filter((r) => r.mode === 'period');
    const timetabled = await this.timetablePeriods.on(schoolId, periodRows, date);
    const recordedPeriods = await this.registers.periodsRecorded(schoolId, periodRows.map((r) => r.sectionId), date);
    const periodsOf = (sectionId: bigint) =>
      Array.from({ length: periodsPerDay }, (_, i) => {
        const slot = timetabled.get(sectionId)?.find((p) => p.period === i + 1);
        return {
          period: i + 1,
          subjectName: slot?.subjectName ?? null,
          teacherName: slot?.teacherName ?? null,
          recorded: recordedPeriods.get(sectionId)?.has(i + 1) ?? false,
        };
      });
    return toPage(
      rows.map((r) => ({
        sectionId: r.sectionId.toString(),
        sectionName: r.sectionName,
        classId: r.classId.toString(),
        className: r.className,
        academicYearId: r.academicYearId.toString(),
        date: query.date,
        mode: r.mode,
        rosterCount: r.rosterCount,
        registersExpected: r.mode === 'daily' ? 1 : periodsPerDay,
        registersRecorded: r.registersRecorded,
        recorded: r.registersRecorded > 0,
        submittedBy: r.submittedBy?.toString() ?? null,
        submittedByName: r.submittedByName,
        submittedAt: r.submittedAt,
        classTeacherStaffId: r.classTeacherStaffId?.toString() ?? null,
        classTeacherName: r.classTeacherName,
        coverStaffIds: r.coverStaffIds.map((id) => id.toString()),
        coverStaffName: r.coverStaffName,
        declaredHolidayAfter: r.registersRecorded > 0 && !teachingDay,
        periods: r.mode === 'period' ? periodsOf(r.sectionId) : [],
      })),
      query,
      total,
    );
  }

  /** §10.2: section summaries (R131), today's scope; `stale` rows show their computedAt. */
  async dailySummary(session: SchoolSessionContext, query: DailySummaryQueryDto): Promise<Page<DailySummaryDto>> {
    const { schoolId } = session;
    const { from, to } = parseRange(query.dateFrom, query.dateTo, SUMMARY_MAX_DAYS);
    const { value: calendar } = await this.calendar.calendar(schoolId, from, to);
    const { rows, total } = await this.reports.dailySummaries(schoolId, scopeOf(session), {
      from,
      to,
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      sort: query.sort ?? '-date',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((r) => ({
        sectionId: r.sectionId.toString(),
        sectionName: r.sectionName,
        classId: r.classId.toString(),
        className: r.className,
        date: toDateString(r.date),
        mode: r.mode,
        registersExpected: r.registersExpected,
        registersRecorded: r.registersRecorded,
        rosterCount: r.rosterCount,
        present: r.present,
        absent: r.absent,
        late: r.late,
        onLeave: r.onLeave,
        partial: r.partial,
        unrecorded: Math.max(0, r.rosterCount - (r.present + r.absent + r.late + r.onLeave + r.partial)),
        teachingDay: isTeachingDay(toDateString(r.date), calendar),
        computedAt: r.computedAt,
        stale: r.stale,
      })),
      query,
      total,
    );
  }

  /** §10.3: derived absent, partial and on-leave days of a date (filterable). */
  absentees(session: SchoolSessionContext, query: AbsenteesQueryDto): Promise<Page<AbsenteeRowDto>> {
    const statuses: DayStatus[] = query.status === undefined ? ['absent', 'partial', 'on_leave'] : [query.status];
    return this.dayList(session, query, statuses);
  }

  /** §10.3: derived late days of a date. */
  late(session: SchoolSessionContext, query: LateQueryDto): Promise<Page<AbsenteeRowDto>> {
    return this.dayList(session, query, ['late']);
  }

  /** §10.5: the percentage report, computed in SQL by the same rules as the shared function. */
  async percentage(schoolId: SchoolId, query: PercentageQueryDto): Promise<Page<PercentageRowDto>> {
    const { from, to } = parseRange(query.dateFrom, query.dateTo, STUDENT_MAX_DAYS);
    const settings = await this.settings.read(schoolId);
    const classId = optionalId(query.classId);
    const sectionId = optionalId(query.sectionId);
    const { rows, total } = await this.reports.percentage(schoolId, {
      from,
      to,
      weeklyOffDays: settings.weeklyOffDays,
      settings: settings.value,
      ...(classId === undefined ? {} : { classId }),
      ...(sectionId === undefined ? {} : { sectionId }),
      ...(query.below === undefined ? {} : { below: query.below }),
      sort: query.sort ?? 'percentage',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((r) => ({
        studentId: r.studentId.toString(),
        fullName: r.fullName,
        rollNo: r.rollNo,
        classId: r.classId?.toString() ?? null,
        className: r.className,
        sectionId: r.sectionId?.toString() ?? null,
        sectionName: r.sectionName,
        percentage: r.percentage,
        countedDays: r.countedDays,
        teachingDays: r.teachingDays,
      })),
      query,
      total,
    );
  }

  /** GET /students/:id/attendance: the student in today's student.view scope, else 404. */
  async forStaff(
    session: SchoolSessionContext,
    studentId: bigint,
    query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    const scope = scopeOf(session);
    const student = await this.students.findById(session.schoolId, scope, studentId);
    if (!student) throw notFound();
    return this.studentAttendance(session.schoolId, scope, studentId, query);
  }

  /** The /me routes: the student must be in the capacity scope (§1.4), else 404. */
  async forCapacity(
    session: SchoolSessionContext,
    studentId: bigint | null,
    query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    const scope = scopeOf(session);
    const id = studentId ?? (scope.kind === 'students' ? scope.ids[0] : undefined);
    if (id === undefined || scope.kind !== 'students' || !scope.ids.includes(id)) throw notFound();
    return this.studentAttendance(session.schoolId, scope, id, query);
  }

  /**
   * §10.4, §5.3: one entry per calendar date, built from attendance_day_status, the student's
   * enrolments and the calendar now; the periods listed per day. No note, teacher, other student
   * or alert state (R165).
   */
  private async studentAttendance(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    const { from, to } = parseRange(query.dateFrom, query.dateTo, STUDENT_MAX_DAYS);
    const settings = await this.settings.read(schoolId);
    const { value: calendar } = await this.calendar.calendar(schoolId, from, to);
    const enrolments = await this.registers.enrolmentsOverlapping(schoolId, scope, studentId, from, to);
    const dayRows = new Map(
      (await this.reports.studentDays(schoolId, scope, studentId, from, to)).map((r) => [toDateString(r.date), r]),
    );
    const periods = new Map<string, Period[]>();
    for (const p of await this.marks.periodsForStudent(schoolId, scope, studentId, from, to)) {
      const key = toDateString(p.date);
      periods.set(key, [...(periods.get(key) ?? []), { period: p.period, status: p.status, arrivedAt: p.arrivedAt }]);
    }

    const days: (PercentageDay & { periods: Period[] })[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const date = toDateString(d);
      const row = dayRows.get(date);
      const day: ValuedDay | null =
        row === undefined
          ? null
          : {
              status: row.status,
              counts: {
                recorded: row.recorded,
                present: row.present,
                late: row.late,
                absent: row.absent,
                leave: row.leave,
              },
              firstLateArrivedAt: row.firstLateArrivedAt,
            };
      days.push({
        date,
        teachingDay: isTeachingDay(date, calendar),
        enrolled: enrolments.some((e) => e.startedOn <= d && (e.endedOn === null || e.endedOn >= d)),
        day,
        periods: periods.get(date) ?? [],
      });
    }
    const summary = attendancePercentage(days, settings.value);
    return {
      studentId: studentId.toString(),
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      ...summary,
      days: days.map((d) => ({
        date: d.date,
        teachingDay: d.teachingDay,
        enrolled: d.enrolled,
        status: d.day?.status ?? null,
        value: d.teachingDay && d.enrolled && d.day !== null ? dayValue(d.day, settings.value) : null,
        periods: d.periods,
      })),
    };
  }

  private async dayList(
    session: SchoolSessionContext,
    query: LateQueryDto,
    statuses: DayStatus[],
  ): Promise<Page<AbsenteeRowDto>> {
    const { schoolId } = session;
    const date = await this.pastOrToday(schoolId, query.date);
    const { rows, total } = await this.reports.dayList(schoolId, {
      date,
      statuses,
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      sort: query.sort ?? 'className',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const alerts = alertsByChildDay(
      await this.alerts.listForChildDays(schoolId, scopeOf(session), rows.map((r) => r.studentId), date),
    );
    return toPage(
      rows.map((r) => ({
        studentId: r.studentId.toString(),
        fullName: r.fullName,
        rollNo: r.rollNo,
        enrolmentId: r.enrolmentId.toString(),
        classId: r.classId.toString(),
        className: r.className,
        sectionId: r.sectionId.toString(),
        sectionName: r.sectionName,
        status: r.status,
        arrivedAt: r.arrivedAt,
        alert: alertSummary(alerts.get(childDayKey(r.studentId, date)) ?? []),
      })),
      query,
      total,
    );
  }

  /** A required `date` not in the future (422 on date). */
  private async pastOrToday(schoolId: SchoolId, value: string): Promise<Date> {
    const date = fromDateString(value);
    if (date > (await this.clock.today(schoolId))) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
    }
    return date;
  }
}
