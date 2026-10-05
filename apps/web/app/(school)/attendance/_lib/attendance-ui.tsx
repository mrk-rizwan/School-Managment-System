'use client';

import { ATTENDANCE_STATUS_LABELS, ErrorCode, type AttendanceStatus, type DayStatus } from '@asms/shared';
import { useId } from 'react';
import { ApiError, NOT_ASSIGNED_ON_DATE, refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type {
  AlertSummaryDto,
  ArrivalNotAbsentDetails,
  AttendanceLockedDetails,
  StaleStatusDetails,
} from '@/lib/api/school-attendance-contract';
import type { MeDto } from '@/lib/api/school-contract';
import { formatDay, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

// Pieces shared by the attendance screens: the register, the registers console, the reports, the
// student and staff attendance tabs and the staff day sheet (contracts/slice-11.md §13,
// slice-12.md §8).

export const attendanceKeys = {
  all: ['school', 'attendance'] as const,
  register: (sectionId: string, date: string, period: number) =>
    ['school', 'attendance', 'register', sectionId, date, period] as const,
  registers: ['school', 'attendance', 'registers'] as const,
  summary: ['school', 'attendance', 'summary'] as const,
  reports: ['school', 'attendance', 'reports'] as const,
  changes: (markId: string) => ['school', 'attendance', 'changes', markId] as const,
  student: (studentId: string) => ['school', 'attendance', 'student', studentId] as const,
  staffDay: ['school', 'attendance', 'staff-day'] as const,
  staff: (staffId: string) => ['school', 'attendance', 'staff', staffId] as const,
  mine: ['school', 'attendance', 'mine'] as const,
};

/** The four mark values, in the order the buttons show them. Student and staff share them. */
export const MARK_STATUSES = ['present', 'absent', 'late', 'on_leave'] as const satisfies readonly AttendanceStatus[];

export const STATUS_LABELS: Record<DayStatus, string> = { ...ATTENDANCE_STATUS_LABELS, partial: 'Part of the day' };
/** The one-letter label on a status button and a heat-map cell. */
export const STATUS_LETTER: Record<DayStatus, string> = {
  present: 'P',
  absent: 'A',
  late: 'L',
  on_leave: 'O',
  partial: '½',
};
/**
 * Keyboard shortcuts on the register and the staff sheet. The contract names P/A/L/O; V (for
 * leave, "vacation") is accepted too, as the brief asked for it.
 */
export const STATUS_KEYS: Record<string, AttendanceStatus> = {
  p: 'present',
  a: 'absent',
  l: 'late',
  o: 'on_leave',
  v: 'on_leave',
};

/** Restrained fills for a status: the selected button and the heat-map cell. */
export const STATUS_FILL: Record<DayStatus, string> = {
  present: 'bg-primary text-primary-foreground',
  absent: 'bg-destructive text-white',
  late: 'bg-amber-700 text-white',
  on_leave: 'bg-slate-500 text-white',
  partial: 'bg-amber-200 text-amber-950',
};

/** The P/A/L/O buttons of one row. Read-only rows show the value only. */
export function StatusButtons({
  value,
  onChange,
  disabled,
  label,
  inRow = false,
}: {
  value: AttendanceStatus | null;
  onChange: (status: AttendanceStatus) => void;
  disabled?: boolean;
  /** Who the row is for, so each button has a full accessible name. */
  label: string;
  /** In a keyboard-driven row (the row takes P/A/L/O), the buttons are not tab stops. */
  inRow?: boolean;
}) {
  const groupId = useId();
  return (
    <div role="radiogroup" aria-label={`Attendance for ${label}`} id={groupId} className="inline-flex gap-1">
      {MARK_STATUSES.map((status) => {
        const selected = value === status;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={STATUS_LABELS[status]}
            title={`${STATUS_LABELS[status]} (${STATUS_LETTER[status]})`}
            tabIndex={inRow ? -1 : undefined}
            disabled={disabled}
            onClick={() => onChange(status)}
            className={cn(
              'size-8 rounded-md border text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed',
              selected ? cn(STATUS_FILL[status], 'border-transparent') : 'bg-background text-muted-foreground hover:bg-muted',
              disabled && !selected && 'opacity-50',
            )}
          >
            {STATUS_LETTER[status]}
          </button>
        );
      })}
    </div>
  );
}

// ---- Times. Instants are shown in Pakistan time (CLAUDE.md: Asia/Karachi for every school). ----

/** Now as `HH:MM` in the school's time zone (the arrival dialog's default). */
export const nowInSchool = () => formatTime(new Date().toISOString());

/** `HH:MM`, 00:00–23:59 (the API's pattern). */
export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ---- Alert state (contract §13, the reports' and the register's alert column) ----

/** One short phrase per alert fact, e.g. "told 09:31", "pending 09:30", "corrected ×2". */
export function alertPhrases(alert: AlertSummaryDto | null): string[] {
  if (!alert) return [];
  const phrases: string[] = [];
  if (alert.absence === 'sent') {
    phrases.push(alert.absenceResolvedAt ? `told ${formatTime(alert.absenceResolvedAt)}` : 'told');
  } else if (alert.absence === 'pending') {
    phrases.push(alert.absenceDueAt ? `pending ${formatTime(alert.absenceDueAt)}` : 'pending');
  } else if (alert.absence === 'cancelled') {
    phrases.push(
      alert.absenceCancelReason === 'backdated'
        ? 'backdated'
        : alert.absenceCancelReason === 'holiday'
          ? 'cancelled: holiday'
          : alert.absenceCancelReason === 'link_ended'
            ? 'cancelled: no guardian to tell'
            : 'cancelled: arrived',
    );
  }
  if (alert.lateAdvice === 'sent') phrases.push('late advice sent');
  else if (alert.lateAdvice === 'pending') phrases.push('late advice pending');
  if (alert.corrections > 0) phrases.push(`corrected ×${alert.corrections}`);
  // Only when a further notice was due and refused (a fourth), not merely when three were sent.
  if (alert.correctionsCapped) phrases.push('corrections capped');
  return phrases;
}

export function AlertCell({ alert }: { alert: AlertSummaryDto | null }) {
  const phrases = alertPhrases(alert);
  if (phrases.length === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs text-muted-foreground">{phrases.join(' · ')}</span>;
}

// ---- Refusals (contracts/slice-11.md §11.1, slice-12.md §5) ----

const ATTENDANCE_REFUSALS: RefusalMessages = {
  [ErrorCode.ATTENDANCE_LOCKED]: (details) => {
    const { date, windowDays } = details as Partial<AttendanceLockedDetails>;
    const window = windowDays === undefined ? '' : ` (${windowDays} day${windowDays === 1 ? '' : 's'})`;
    return `The amendment window${window} has closed${date ? ` for ${formatDay(date)}` : ''}. Ask the principal to make this change.`;
  },
  [`${ErrorCode.NOT_A_TEACHING_DAY}:weekly_off`]: 'This is a weekly day off, so attendance is not recorded.',
  [`${ErrorCode.NOT_A_TEACHING_DAY}:staff_holiday`]: 'This is a holiday for staff, so attendance is not recorded.',
  [ErrorCode.NOT_A_TEACHING_DAY]: 'This is not a teaching day, so attendance is not recorded.',
  [ErrorCode.STALE_STATUS]: (details) => {
    const { currentStatus } = details as Partial<StaleStatusDetails>;
    return `Someone else changed this mark${currentStatus ? ` to ${STATUS_LABELS[currentStatus]}` : ''} after you loaded it. Check it and try again.`;
  },
  [ErrorCode.ROSTER_INCOMPLETE]: 'Mark every child on the register before saving it for the first time.',
  [ErrorCode.CONCURRENT_UPDATE]: 'Someone else saved at the same moment. Reload and try again.',
  [ErrorCode.SELF_ACTION_FORBIDDEN]: 'You cannot mark your own attendance. Another member of staff records it.',
  [`${ErrorCode.PERMISSION_DENIED}:subject_teacher_daily_mode`]:
    'This class records attendance once a day: its class teacher marks the register, not a subject teacher.',
  [`${ErrorCode.PERMISSION_DENIED}:not_assigned_on_date`]: NOT_ASSIGNED_ON_DATE,
};

/** One sentence for an attendance refusal; anything else is `describeApiError`. */
export const attendanceErrorMessage = (error: unknown): string => refusalMessage(error, ATTENDANCE_REFUSALS);

/** 409 ARRIVAL_NOT_ABSENT, in the gate's words (contract §13). */
export function arrivalRefusal(error: unknown, studentName: string): string {
  if (error instanceof ApiError && error.code === ErrorCode.ARRIVAL_NOT_ABSENT) {
    const { status } = (error.details ?? {}) as Partial<ArrivalNotAbsentDetails>;
    if (!status) return `No register has been recorded for ${studentName} today. The register comes first.`;
    return `${studentName} is marked ${STATUS_LABELS[status].toLowerCase()} today — amend the register instead.`;
  }
  return attendanceErrorMessage(error);
}

// ---- The caller's sections (GET /me assignments) ----

export type MySection = {
  sectionId: string;
  sectionName: string;
  classId: string;
  className: string;
  roles: MeDto['assignments'][number]['role'][];
  subjectIds: string[];
};

/** The sections the caller is assigned to today, one entry each with every role they hold there. */
export function mySections(me: MeDto | undefined, today: string): MySection[] {
  const bySection = new Map<string, MySection>();
  for (const a of me?.assignments ?? []) {
    if (!a.sectionId || a.startsOn > today || (a.endsOn !== null && a.endsOn < today)) continue;
    const entry = bySection.get(a.sectionId) ?? {
      sectionId: a.sectionId,
      sectionName: a.sectionName ?? '',
      classId: a.classId,
      className: a.className,
      roles: [],
      subjectIds: [],
    };
    if (!entry.roles.includes(a.role)) entry.roles.push(a.role);
    if (a.subjectId && !entry.subjectIds.includes(a.subjectId)) entry.subjectIds.push(a.subjectId);
    bySection.set(a.sectionId, entry);
  }
  return [...bySection.values()].sort(
    (x, y) => x.className.localeCompare(y.className) || x.sectionName.localeCompare(y.sectionName),
  );
}
