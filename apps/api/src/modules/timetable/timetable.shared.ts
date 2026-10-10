// Pieces shared by the timetable services (contracts/slice-37.md).
import { ErrorCode, type TimetableClash } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { addDays } from '../../common/school-clock';
import { assignedOn, type SlotView, type SubjectAssignmentSpan } from '../../repositories/timetable-reads.repository';
import type { VersionRecord } from '../../repositories/timetable.repository';
import type { TimetableSlotDto, TimetableVersionStatus } from './timetable.dto';

/** The weekday of a DATE value (UTC midnight): 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (d: Date): number => d.getUTCDay();

/** The Monday of the week holding `d`. */
export const mondayOf = (d: Date): Date => addDays(d, -((d.getUTCDay() + 6) % 7));

/** The week holding `d`: Monday to Sunday. */
export function weekOf(d: Date): { days: Date[]; monday: Date; sunday: Date } {
  const monday = mondayOf(d);
  return { days: Array.from({ length: 7 }, (_, i) => addDays(monday, i)), monday, sunday: addDays(monday, 6) };
}

/** A version's status against today (contracts/slice-37.md §2.1). */
export function versionStatus(
  v: { effectiveFrom: Date; effectiveTo: Date | null; voidedAt: Date | null },
  today: Date,
): TimetableVersionStatus {
  if (v.voidedAt !== null) return 'voided';
  if (v.effectiveFrom > today) return 'future';
  if (v.effectiveTo !== null && v.effectiveTo < today) return 'past';
  return 'live';
}

/** A slot as staff see it, with "no assigned teacher" read on `on` (R303). */
export function toSlotDto(
  slot: SlotView,
  assignments: readonly SubjectAssignmentSpan[],
  on: Date,
): TimetableSlotDto {
  return {
    id: slot.id.toString(),
    weekday: slot.weekday,
    period: slot.period,
    classSubjectId: slot.classSubjectId.toString(),
    subjectName: slot.subjectName,
    staffId: slot.staffId.toString(),
    teacherName: slot.staffName,
    room: slot.room,
    assignedTeacher: assignedOn(assignments, slot, on),
  };
}

/** The day a version's "assigned teacher" is read on: its first day, or today while it runs. */
export function assignmentDayOf(v: Pick<VersionRecord, 'effectiveFrom' | 'effectiveTo'>, today: Date): Date {
  if (v.effectiveFrom >= today) return v.effectiveFrom;
  if (v.effectiveTo !== null && v.effectiveTo < today) return v.effectiveTo;
  return today;
}

/** The API refusal of the first clash the shared function found (§2.2 step 2). */
export function clashRefusal(clash: TimetableClash): ApiException {
  if (clash.kind === 'off_day') {
    return new ApiException(409, ErrorCode.TIMETABLE_OFF_DAY, 'A slot cannot fall on a weekly-off day.', {
      weekday: clash.weekday,
      index: clash.index,
    });
  }
  if (clash.kind === 'period' || clash.kind === 'weekday') {
    return new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
      fields: [
        {
          path: `slots[${clash.index}].${clash.kind}`,
          code: ErrorCode.INVALID_VALUE,
          message:
            clash.kind === 'period'
              ? "period must be within the school's periods per day"
              : 'weekday must be 0-6',
        },
      ],
    });
  }
  const message = {
    section: 'Two slots share a weekday and period.',
    teacher: 'The teacher is already timetabled in that period.',
    room: 'The room is already booked in that period.',
  }[clash.kind];
  return new ApiException(409, ErrorCode.TIMETABLE_SLOT_CLASH, message, {
    kind: clash.kind,
    weekday: clash.weekday,
    period: clash.period,
    index: clash.index,
    conflictingSlotId: 'conflictingSlotId' in clash ? (clash.conflictingSlotId ?? null) : null,
  });
}

