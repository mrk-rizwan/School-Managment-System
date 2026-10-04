// The derived day status and the attendance percentage (contracts/slice-11.md §5, R127, R128):
// pure functions over plain values, so the API (the rollup, every read), the web heat map and the
// app compute the same answer. Nothing here knows about the database or the calendar: a caller
// says whether a date is a teaching day, evaluated NOW against the current calendar (R116, R167).
import type { AttendanceStatus, DayStatus, LateCountsAs, LeaveCountsAs } from './attendance';

/** What a submit did to one mark (contracts/slice-11.md §2.1). */
export const MARK_OUTCOMES = ['created', 'amended', 'unchanged'] as const;
export type MarkOutcome = (typeof MARK_OUTCOMES)[number];

/** The automatic reason of a gate arrival (R168), stored on the change row. */
export const ARRIVAL_REASON = (arrivedAt: string): string => `Arrived at ${arrivedAt}`;

/** `HH:MM`, 00:00-23:59. */
export const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** One recorded period of an enrolment-day. Unrecorded periods are simply absent from the list. */
export interface RecordedPeriod {
  readonly period: number;
  readonly status: AttendanceStatus;
}

export interface DayCounts {
  readonly recorded: number;
  readonly present: number;
  readonly late: number;
  readonly absent: number;
  readonly leave: number;
}

export interface DerivedDay {
  readonly status: DayStatus;
  readonly counts: DayCounts;
}

/**
 * R127, first match wins (§5.1): every period on leave → on_leave; every period absent → absent;
 * any absent or on-leave period among others → partial; the first recorded period late and every
 * other present or late → late; otherwise present. `[present, late]` is `present`: a late to a
 * later period is not a late day. Daily mode is the one-period case. At least one period.
 */
export function deriveDayStatus(periods: readonly RecordedPeriod[]): DerivedDay {
  if (periods.length === 0) throw new RangeError('deriveDayStatus: no recorded period');
  const ordered = [...periods].sort((a, b) => a.period - b.period);
  const count = (status: AttendanceStatus) => ordered.filter((p) => p.status === status).length;
  const counts: DayCounts = {
    recorded: ordered.length,
    present: count('present'),
    late: count('late'),
    absent: count('absent'),
    leave: count('on_leave'),
  };
  let status: DayStatus;
  if (counts.leave === counts.recorded) status = 'on_leave';
  else if (counts.absent === counts.recorded) status = 'absent';
  else if (counts.absent + counts.leave > 0) status = 'partial';
  else if (ordered[0]?.status === 'late') status = 'late';
  else status = 'present';
  return { status, counts };
}

/** The school settings the day value reads (`school_settings`, plan §4.5). */
export interface AttendanceValueSettings {
  readonly lateCountsAs: LateCountsAs;
  /** `HH:MM`; required by the settings screen while lateCountsAs is absent_after_cutoff. */
  readonly lateCutoffTime: string | null;
  readonly leaveCountsAs: LeaveCountsAs;
}

export interface ValuedDay extends DerivedDay {
  /** `HH:MM` of the lowest-period late mark, or null (unknown or not late). */
  readonly firstLateArrivedAt: string | null;
}

/**
 * R128 (§5.2): a counted day's value, or null when the day is excluded from the denominator
 * (on leave under `excused`). A late day under absent_after_cutoff counts 0 only when its arrival
 * is known and after the cutoff: an unknown arrival time is not penalised. A partial day is the
 * share of its recorded periods present or late; an on-leave period inside it counts as not
 * present whatever leaveCountsAs says.
 */
export function dayValue(day: ValuedDay, settings: AttendanceValueSettings): number | null {
  switch (day.status) {
    case 'present':
      return 1;
    case 'absent':
      return 0;
    case 'late':
      if (settings.lateCountsAs === 'present') return 1;
      if (settings.lateCountsAs === 'half_day') return 0.5;
      return day.firstLateArrivedAt !== null &&
        settings.lateCutoffTime !== null &&
        day.firstLateArrivedAt > settings.lateCutoffTime
        ? 0
        : 1;
    case 'on_leave':
      return settings.leaveCountsAs === 'absent' ? 0 : null;
    case 'partial':
      return (day.counts.present + day.counts.late) / day.counts.recorded;
  }
}

/** One calendar date of the requested range (§5.3). */
export interface PercentageDay {
  readonly date: string;
  /** Evaluated now, against the current weekly-off days and published holidays. */
  readonly teachingDay: boolean;
  /** An enrolment of the student was in force on the date. */
  readonly enrolled: boolean;
  /** The derived day when anything was recorded, else null. */
  readonly day: ValuedDay | null;
}

export interface AttendancePercentage {
  /** One decimal, half-up; null when nothing is counted ("no recorded days", never 100 or NaN). */
  readonly percentage: number | null;
  readonly countedDays: number;
  /** Teaching days on which the student had an enrolment in force. */
  readonly teachingDays: number;
  /** Counted days by derived status. */
  readonly present: number;
  readonly absent: number;
  readonly late: number;
  readonly onLeave: number;
  readonly partial: number;
  /** On-leave days left out of the denominator under `excused`. */
  readonly excludedLeaveDays: number;
  /** teachingDays − countedDays − excludedLeaveDays. */
  readonly unrecorded: number;
}

/** Half-up to one decimal, done once at the end. The epsilon absorbs binary-fraction error. */
export const roundPercentage = (value: number): number => Math.round(value * 10 + 1e-9) / 10;

/**
 * R128 (§5.3): the day is the unit in both modes. Countable days are teaching days on which the
 * student was enrolled and something was recorded; a countable day with a null value (excused
 * leave) leaves the denominator. A holiday declared after the fact is simply not a teaching day.
 */
export function attendancePercentage(
  days: readonly PercentageDay[],
  settings: AttendanceValueSettings,
): AttendancePercentage {
  let teaching = 0;
  let counted = 0;
  let excluded = 0;
  let sum = 0;
  const byStatus = { present: 0, absent: 0, late: 0, on_leave: 0, partial: 0 };
  for (const d of days) {
    if (!d.teachingDay || !d.enrolled) continue;
    teaching += 1;
    if (d.day === null) continue;
    const value = dayValue(d.day, settings);
    if (value === null) {
      excluded += 1;
      continue;
    }
    counted += 1;
    sum += value;
    byStatus[d.day.status] += 1;
  }
  return {
    percentage: counted === 0 ? null : roundPercentage((sum / counted) * 100),
    countedDays: counted,
    teachingDays: teaching,
    present: byStatus.present,
    absent: byStatus.absent,
    late: byStatus.late,
    onLeave: byStatus.on_leave,
    partial: byStatus.partial,
    excludedLeaveDays: excluded,
    unrecorded: teaching - counted - excluded,
  };
}
