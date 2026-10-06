import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, isStaffWorkingDay, weekdayOf } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import {
  ApiException,
  concurrentUpdate,
  fieldRefused,
  notFound,
  type FieldError,
} from '../../common/errors/api-exception';
import { diffMarks } from '../../common/diff';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { toPage, type Page } from '../../common/pagination';
import { addDays, daysBetween, SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { LeaveRequestRepository } from '../../repositories/leave-request.repository';
import { LeaveTypeRepository } from '../../repositories/leave-type.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import {
  StaffAttendanceRepository,
  type NewStaffMark,
} from '../../repositories/staff-attendance.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import type { CalendarRangeQueryDto } from '../calendar/calendar.dto';
import { parseRange } from '../calendar/calendar-reads.service';
import { staleStatus } from '../access/access.errors';
import { CalendarService } from '../calendar/calendar.service';
import type {
  MyStaffAttendanceDto,
  StaffAmendDto,
  StaffAttendanceDto,
  StaffDayDto,
  StaffDayQueryDto,
  StaffMarkDto,
  StaffSubmitDto,
  StaffSubmitResultDto,
} from './staff-attendance.dto';
import { toStaffMarkDto } from './staff-attendance.mappers';

// contracts/slice-12.md (R133-R136). Lock order: staff_attendance rows only, in staff_id order;
// nothing else is locked. Rows are corrected in place, never deleted (rule 4); the history
// trigger records every change with the actor and reason set through ChangeContextRepository.

const NATURAL_KEY = 'staff_attendance_natural_key';
/** The typo guard on a write's date (§3): today − 366 days … today. */
const EARLIEST_DAYS = -366;

/** R134: the caller's own row is never marked, whoever the caller is. */
const selfForbidden = (staffId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'Nobody marks or amends their own attendance.',
    { staffId: staffId.toString() },
  );

/** On or after joined_on and, when set, on or before left_on (§2). */
const employedOn = (date: Date, staff: { joinedOn: Date | null; leftOn: Date | null }): boolean =>
  (staff.joinedOn === null || date >= staff.joinedOn) &&
  (staff.leftOn === null || date <= staff.leftOn);

@Injectable()
export class StaffAttendanceService {
  constructor(
    private readonly context: SchoolContext,
    private readonly marks: StaffAttendanceRepository,
    private readonly staff: StaffRepository,
    private readonly calendar: CalendarService,
    private readonly changeContext: ChangeContextRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
    private readonly leave: LeaveRequestRepository,
    private readonly leaveTypes: LeaveTypeRepository,
  ) {}

  /** §4.1: the day's sheet. */
  async day(query: StaffDayQueryDto): Promise<Page<StaffDayDto>> {
    const schoolId = this.context.schoolId;
    const date = fromDateString(query.date);
    if (date > (await this.clock.today(schoolId))) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
    }
    const { rows, total } = await this.marks.daySheet(schoolId, {
      date,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'fullName',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const leave = await this.approvedLeaveOn(schoolId, date, rows.map((row) => row.staffId));
    return toPage(
      rows.map((row) => ({
        staffId: row.staffId.toString(),
        fullName: row.fullName,
        designation: row.designation,
        staffStatus: row.staffStatus,
        mark: row.mark && toStaffMarkDto(row.mark),
        approvedLeave: leave.get(row.staffId) ?? null,
      })),
      query,
      total,
    );
  }

  /**
   * §4.2. The losing insert of two concurrent first marks for one member fails the natural key;
   * the transaction is rolled back and the answer is 409 CONCURRENT_UPDATE (a resubmit lands as
   * a replay or an amendment).
   */
  async submit(session: SchoolSessionContext, dto: StaffSubmitDto): Promise<StaffSubmitResultDto> {
    return recoverConstraint(
      NATURAL_KEY,
      () => this.submitInTransaction(session, dto),
      () => Promise.reject(concurrentUpdate()),
    );
  }

  /** §4.3: one mark, with the status the client last saw. */
  @Transactional()
  async amend(session: SchoolSessionContext, id: bigint, dto: StaffAmendDto): Promise<StaffMarkDto> {
    const { schoolId, userId } = this.context.actor();
    const found = await this.marks.findById(schoolId, id);
    if (!found) throw notFound();
    if (found.staffId === session.access.staffId) throw selfForbidden(found.staffId);
    const row = await this.marks.lock(schoolId, id);
    if (!row) throw notFound();

    const note = dto.note === undefined ? row.note : dto.note;
    if (dto.status === row.status && note === row.note) return toStaffMarkDto(row);
    if (dto.fromStatus !== row.status) throw staleStatus(row.status);

    await this.changeContext.setChangeContext(userId, dto.reason);
    await this.marks.update(schoolId, id, { status: dto.status, note });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff_attendance_mark.amended',
      subjectType: 'staff_attendance',
      subjectId: id,
      reason: dto.reason,
      metadata: {
        staffId: row.staffId.toString(),
        date: toDateString(row.date),
        from: row.status,
        to: dto.status,
        noteChanged: note !== row.note,
        afterWindow: await this.afterWindow(schoolId, row.date),
      },
    });
    const updated = await this.marks.findById(schoolId, id);
    if (!updated) throw new Error('staff mark vanished');
    return toStaffMarkDto(updated);
  }

  /** GET /staff/:id/attendance (§4.4): any staff row of the school, any status. */
  async history(staffId: bigint, query: CalendarRangeQueryDto): Promise<StaffAttendanceDto> {
    return this.read(staffId, query);
  }

  /** GET /me/staff/attendance (§4.4, R135): the caller's own, without note and marker. */
  async myHistory(
    session: SchoolSessionContext,
    query: CalendarRangeQueryDto,
  ): Promise<MyStaffAttendanceDto> {
    const staffId = session.access.staffId;
    // @RequireStaff() admits only an active staff capacity, which needs a staff row (R59).
    if (staffId === null) throw notFound();
    const { days, ...totals } = await this.read(staffId, query);
    return {
      ...totals,
      days: days.map(({ date, workingDay, employed, status, amended }) => ({
        date,
        workingDay,
        employed,
        status,
        amended,
      })),
    };
  }

  @Transactional()
  private async submitInTransaction(
    session: SchoolSessionContext,
    dto: StaffSubmitDto,
  ): Promise<StaffSubmitResultDto> {
    const { schoolId, userId } = this.context.actor();

    // 1. Shape: one item per member.
    const staffIds = dto.marks.map((m) => BigInt(m.staffId));
    const seen = new Set<bigint>();
    staffIds.forEach((id, i) => {
      if (seen.has(id)) {
        throw fieldRefused(`marks[${i}].staffId`, ErrorCode.INVALID_VALUE, 'staffId is repeated');
      }
      seen.add(id);
    });

    // 2. Date rules (§3).
    const date = fromDateString(dto.date);
    await this.assertWritableDate(schoolId, date);

    // 3. R134: the whole payload is refused when it names the caller.
    const own = session.access.staffId;
    if (own !== null && seen.has(own)) throw selfForbidden(own);

    // 4. Every member markable on the date, all or nothing.
    const markable = await this.marks.markable(schoolId, date, staffIds);
    const unknown: FieldError[] = staffIds.flatMap((id, i) =>
      markable.has(id)
        ? []
        : [
            {
              path: `marks[${i}].staffId`,
              code: ErrorCode.REFERENCE_NOT_FOUND,
              message: 'No active staff member with that id who had joined by the date',
            },
          ],
    );
    if (unknown.length > 0) {
      throw new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
        fields: unknown,
      });
    }

    // 5. The existing rows, locked in staff_id order.
    const existing = new Map(
      (await this.marks.lockDay(schoolId, date, staffIds)).map((row) => [row.staffId, row]),
    );

    // 6. Diff.
    const planned = diffMarks(
      dto.marks.map((m): NewStaffMark => ({ staffId: BigInt(m.staffId), status: m.status, note: m.note ?? null })),
      existing,
      (item) => item.staffId,
      (item, row) => row.status === item.status && row.note === item.note,
    );
    const outcomes = planned.map((p) => p.outcome);
    const created = planned.flatMap((p) => (p.outcome === 'created' ? [p.item] : []));
    const amended = planned.flatMap(({ item, outcome, existing: row }) =>
      outcome === 'amended' && row ? [{ row, status: item.status, note: item.note }] : [],
    );
    if (amended.length > 0 && dto.reason === undefined) {
      throw new ApiException(
        409,
        ErrorCode.AMENDMENT_REASON_REQUIRED,
        'Some marks change an existing record: give a reason.',
        {
          amendments: amended.map(({ row, status, note }) => ({
            staffId: row.staffId.toString(),
            markId: row.id.toString(),
            from: row.status,
            to: status,
            noteChanged: note !== row.note,
          })),
        },
      );
    }

    // 7. Write (nothing on an identical replay).
    if (created.length > 0 || amended.length > 0) {
      await this.changeContext.setChangeContext(userId, dto.reason ?? null);
      await this.marks.create(schoolId, date, userId, created);
      for (const { row, status, note } of amended) {
        await this.marks.update(schoolId, row.id, { status, note });
      }

      // 8. Audit.
      const allCreated = amended.length === 0;
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: allCreated ? 'staff_attendance.recorded' : 'staff_attendance.amended',
        subjectType: 'user',
        subjectId: userId,
        ...(dto.reason === undefined ? {} : { reason: dto.reason }),
        metadata: {
          date: dto.date,
          created: created.length,
          ...(allCreated
            ? {}
            : {
                amended: amended.length,
                afterWindow: await this.afterWindow(schoolId, date),
              }),
          staffIds: [...created.map((m) => m.staffId), ...amended.map((a) => a.row.staffId)]
            .map(String)
            .join(','),
        },
      });
    }

    const after = new Map(
      (await this.marks.marksOn(schoolId, date, staffIds)).map((row) => [row.staffId, row]),
    );
    return {
      date: dto.date,
      workingDay: true,
      marks: staffIds.map((staffId, i) => {
        const row = after.get(staffId);
        if (!row) throw new Error('staff mark vanished');
        return { ...toStaffMarkDto(row), outcome: outcomes[i] ?? 'unchanged' };
      }),
      summary: await this.marks.daySummary(schoolId, date),
    };
  }

  /** Slice 24: each member's approved (or ended-early, as taken) leave covering `date`. */
  private async approvedLeaveOn(
    schoolId: SchoolId,
    date: Date,
    staffIds: bigint[],
  ): Promise<Map<bigint, { leaveRequestId: string; typeName: string }>> {
    const rows = await this.leave.takenOn(schoolId, date, staffIds);
    const types = new Map(
      (await this.leaveTypes.findByIds(schoolId, rows.map((r) => r.leaveTypeId))).map((t) => [t.id, t.name]),
    );
    return new Map(
      rows.map((r) => [r.staffId, { leaveRequestId: r.id.toString(), typeName: types.get(r.leaveTypeId) ?? '' }]),
    );
  }

  /** §3: not in the future, within the typo guard, and a staff working day (R136). */
  private async assertWritableDate(schoolId: SchoolId, date: Date): Promise<void> {
    const today = await this.clock.today(schoolId);
    if (date > today) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
    }
    if (date < addDays(today, EARLIEST_DAYS)) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must be within the last 366 days');
    }
    const { value } = await this.calendar.calendar(schoolId, date, date);
    const day = toDateString(date);
    if (!isStaffWorkingDay(day, value)) {
      throw new ApiException(409, ErrorCode.NOT_A_TEACHING_DAY, 'Not a working day for staff.', {
        reason: value.weeklyOffDays.includes(weekdayOf(day)) ? 'weekly_off' : 'staff_holiday',
      });
    }
  }

  /** Past attendance_amend_window_days (slice-11 §1.3): audited, never refused (decision 2). */
  private async afterWindow(schoolId: SchoolId, date: Date): Promise<boolean> {
    const settings = await this.settings.find(schoolId);
    const windowDays = settings?.attendanceAmendWindowDays ?? 0;
    return daysBetween(date, await this.clock.today(schoolId)) > windowDays;
  }

  /** The §4.4 history: the member's rows and the calendar over the range, both read now. */
  private async read(staffId: bigint, query: CalendarRangeQueryDto): Promise<StaffAttendanceDto> {
    const schoolId = this.context.schoolId;
    const { from, to } = parseRange(query);
    const member = await this.staff.findById(schoolId, staffId);
    if (!member) throw notFound();
    const rows = new Map(
      (await this.marks.history(schoolId, staffId, from, to)).map((row) => [
        toDateString(row.date),
        row,
      ]),
    );
    const { value } = await this.calendar.calendar(schoolId, from, to);

    const totals = { workingDays: 0, present: 0, absent: 0, late: 0, onLeave: 0 };
    const days: StaffAttendanceDto['days'] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const day = toDateString(date);
      const workingDay = isStaffWorkingDay(day, value);
      const employed = employedOn(date, member);
      const row = rows.get(day);
      if (workingDay && employed) {
        totals.workingDays += 1;
        if (row) totals[row.status === 'on_leave' ? 'onLeave' : row.status] += 1;
      }
      days.push({
        date: day,
        workingDay,
        employed,
        status: row?.status ?? null,
        note: row?.note ?? null,
        markedByName: row?.markedByName ?? null,
        amended: row !== undefined && row.lastAmendedAt !== null,
      });
    }
    const marked = totals.present + totals.absent + totals.late + totals.onLeave;
    return {
      staffId: staffId.toString(),
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      ...totals,
      unrecorded: Math.max(0, totals.workingDays - marked),
      days,
    };
  }
}
