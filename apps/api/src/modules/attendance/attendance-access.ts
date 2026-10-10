import { Injectable } from '@nestjs/common';
import { Capability, ErrorCode, type AttendanceMode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';
import { daysBetween } from '../../common/school-clock';
import type { RegisterSection } from '../../repositories/attendance-register.repository';
import { TimetableReadsRepository, type SubstituteAdmission } from '../../repositories/timetable-reads.repository';
import type { DatedScope, Scope } from '../../tenancy/scope';
import { PermissionsService, rowScope, rowScopeWith } from '../access/permissions.service';
import type { CallerRole } from './attendance.dto';

// contracts/slice-11.md §1.2, §1.3, §3.2 (R118-R125, R175): the dated, role-aware scope of a
// register's date, the amendment window, and the date and period rules. A section the caller can
// never see is 404. A section the caller is assigned to on some date but not on the register's
// is 403 not_assigned_on_date (main-thread ruling 2026-10-04, as slice 13 decision 13); a subject
// teacher in daily mode is 403 subject_teacher_daily_mode.

/** Who may write a section's register on a date (§1.2). */
export type WriteRole = Exclude<CallerRole, 'viewer'>;

/** The strongest role a dated scope gives in one section, or null when it gives none. */
function roleIn(scope: DatedScope | null, sectionId: bigint): WriteRole | null {
  if (scope === null) return null;
  if (scope.kind === 'all') return 'all';
  const roles = scope.sections.get(sectionId);
  if (!roles) return null;
  if (roles.classTeacher) return 'class_teacher';
  if (roles.cover) return 'cover';
  return roles.subjectIds.length > 0 ? 'subject_teacher' : null;
}

/** A subject teacher writes only in period mode (§1.2). */
const writesIn = (role: WriteRole, mode: AttendanceMode): boolean =>
  role !== 'subject_teacher' || mode === 'period';

/** Phase 5 R304: a subject teacher outside their timetabled periods once the section has one. */
const notTimetabledPeriod = (period: number): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'That period is not yours on the timetable.', {
    reason: 'not_timetabled_period',
    period,
  });

const subjectTeacherDaily = (): ApiException =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    'A subject teacher records attendance only for classes taken by period.',
    { reason: 'subject_teacher_daily_mode' },
  );

/** §1.3: `today − d ≤ attendance_amend_window_days` (0 = the day itself only). */
export const windowOpen = (date: Date, today: Date, windowDays: number): boolean =>
  daysBetween(date, today) <= windowDays;

export const attendanceLocked = (date: string, windowDays: number): ApiException =>
  new ApiException(
    409,
    ErrorCode.ATTENDANCE_LOCKED,
    'The amendment window for that date has closed. Ask the office or the principal.',
    { date, windowDays },
  );

export const notATeachingDay = (): ApiException =>
  new ApiException(409, ErrorCode.NOT_A_TEACHING_DAY, 'That date is not a teaching day.');

/** §3.2: not in the future, inside the class's academic year (422 on `date`). */
export function assertRegisterDate(date: Date, today: Date, section: RegisterSection): void {
  if (date > today) {
    throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
  }
  if (date < section.yearStartsOn || date > section.yearEndsOn) {
    throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date is outside the academic year');
  }
}

/** §3.2, writes only: daily mode takes period 1; period mode 1..periodsPerDay (422 on `period`). */
export function assertWritablePeriod(period: number, mode: AttendanceMode, periodsPerDay: number): void {
  if (mode === 'daily' && period !== 1) {
    throw fieldRefused('period', ErrorCode.INVALID_VALUE, 'a class taken daily records period 1 only');
  }
  if (mode === 'period' && period > periodsPerDay) {
    throw fieldRefused(
      'period',
      ErrorCode.INVALID_VALUE,
      `period must be at most ${periodsPerDay}, the school's periods per day`,
    );
  }
}

@Injectable()
export class AttendanceAccess {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly timetable: TimetableReadsRepository,
  ) {}

  /**
   * Phase 5 R304, R306 (contracts/slice-37.md §2.5), period mode only: with a version live on the
   * date, a subject teacher keeps the period only when its slot names them or a live substitution
   * does ('denied' otherwise); a caller with no role in the section on the date gains the subject
   * teacher's write on a period a live substitution names them for (the lookup's SubstituteAdmission,
   * the only thing rowScopeWith accepts). Without a live
   * version, or for any other role, nothing changes ('unchanged': R120 stands).
   */
  private async byTimetable(
    session: SchoolSessionContext,
    sectionId: bigint,
    on: Date,
    period: number,
    role: WriteRole | null,
  ): Promise<'unchanged' | 'denied' | SubstituteAdmission> {
    if (role !== null && role !== 'subject_teacher') return 'unchanged';
    const staffId = session.access.staffId;
    if (staffId === null) return 'unchanged';
    const access = await this.timetable.periodAccess(session.schoolId, { sectionId, date: on, period, staffId });
    if (role === null) return access.substitute ?? 'unchanged';
    if (!access.live) return 'unchanged';
    return access.slotStaffId === staffId || access.substitute !== null ? 'unchanged' : 'denied';
  }

  /** The dated scope of the mark key, or null when it is not held. */
  private markScope(session: SchoolSessionContext, on: Date): Promise<DatedScope | null> {
    return this.permissions.scopeOf(session, { capability: Capability.ATTENDANCE_STUDENT_MARK, on });
  }

  /**
   * §1.2 read rule: the caller's role in the section on the date ('viewer' from the view-all key
   * alone); outside it 403 not_assigned_on_date or 404. The write role is reported separately so
   * the view can say `canSubmit`; `scope` is the row scope of the dated scope that admitted the
   * caller, for the view's student-linked reads (control 7).
   */
  async readRole(
    session: SchoolSessionContext,
    sectionId: bigint,
    on: Date,
    period?: { period: number; mode: AttendanceMode },
  ): Promise<{ callerRole: CallerRole; writeRole: WriteRole | null; scope: Scope }> {
    const mark = await this.markScope(session, on);
    const writeRole = roleIn(mark, sectionId);
    const tt =
      mark !== null && period?.mode === 'period'
        ? await this.byTimetable(session, sectionId, on, period.period, writeRole)
        : 'unchanged';
    if (mark !== null && typeof tt === 'object') {
      return { callerRole: 'subject_teacher', writeRole: 'subject_teacher', scope: rowScopeWith(mark, tt) };
    }
    if (mark !== null && writeRole !== null) {
      return { callerRole: writeRole, writeRole: tt === 'denied' ? null : writeRole, scope: rowScope(mark) };
    }
    const view = await this.permissions.scopeOf(session, {
      capability: Capability.ATTENDANCE_STUDENT_VIEW_ALL,
      on,
    });
    if (view === null || roleIn(view, sectionId) === null) return this.permissions.refuseOutsideDate(session, sectionId);
    return { callerRole: 'viewer', writeRole: null, scope: rowScope(view) };
  }

  /**
   * §1.2 write rule on the date: the role; outside it 403 not_assigned_on_date or 404; 403 for a
   * subject teacher in daily mode.
   */
  async writeRole(
    session: SchoolSessionContext,
    sectionId: bigint,
    on: Date,
    mode: AttendanceMode,
    period: number,
  ): Promise<WriteRole> {
    const mark = await this.markScope(session, on);
    let role = roleIn(mark, sectionId);
    if (mark !== null && mode === 'period') {
      const tt = await this.byTimetable(session, sectionId, on, period, role);
      if (tt === 'denied') throw notTimetabledPeriod(period);
      if (typeof tt === 'object') role = 'subject_teacher';
    }
    if (role === null) return this.permissions.refuseOutsideDate(session, sectionId);
    if (!writesIn(role, mode)) throw subjectTeacherDaily();
    return role;
  }

  /** Whether `writeRole` would admit the caller (the view's `canSubmit`). */
  canWrite(role: WriteRole | null, mode: AttendanceMode): boolean {
    return role !== null && writesIn(role, mode);
  }
}
