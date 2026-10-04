import type { AlertRecord } from '../../repositories/attendance-alert.repository';
import type { MarkRecord } from '../../repositories/attendance-mark.repository';
import type { RegisterSection, RegisterView } from '../../repositories/attendance-register.repository';
import { toDateString } from '../academics/academics.shared';
import type { AlertSummaryDto, AttendanceMarkDto, RegisterDto } from './attendance.dto';

// Row → DTO for the attendance routes (contracts/slice-11.md §2.2). Ids travel as strings.

export function toMarkDto(mark: MarkRecord): AttendanceMarkDto {
  return {
    id: mark.id.toString(),
    registerId: mark.registerId.toString(),
    enrolmentId: mark.enrolmentId.toString(),
    studentId: mark.studentId.toString(),
    date: toDateString(mark.date),
    period: mark.period,
    status: mark.status,
    arrivedAt: mark.arrivedAt,
    note: mark.note,
    amended: mark.amended,
  };
}

export function toRegisterDto(
  register: RegisterView,
  section: Pick<RegisterSection, 'name' | 'className'>,
  teachingDay: boolean,
): RegisterDto {
  return {
    id: register.id.toString(),
    sectionId: register.sectionId.toString(),
    sectionName: section.name,
    classId: register.classId.toString(),
    className: section.className,
    academicYearId: register.academicYearId.toString(),
    date: toDateString(register.date),
    period: register.period,
    mode: register.mode,
    teachingDay,
    submittedBy: register.submittedBy.toString(),
    submittedByName: register.submittedByName,
    submittedAt: register.submittedAt,
    lastAmendedBy: register.lastAmendedBy?.toString() ?? null,
    lastAmendedByName: register.lastAmendedByName,
    lastAmendedAt: register.lastAmendedAt,
    source: register.source,
  };
}

/**
 * A child-day's alert state (§2.2) from its alert rows, or null when it has none.
 * `correctionsCapped` is true once a fourth absence or corrected notice was due and refused (a row
 * carries `cappedAt`), not merely when three exist.
 */
export function alertSummary(rows: readonly AlertRecord[]): AlertSummaryDto | null {
  if (rows.length === 0) return null;
  const bySeq = (a: AlertRecord, b: AlertRecord) => a.seq - b.seq;
  const absence = rows.filter((r) => r.kind === 'absence').sort(bySeq).at(-1);
  const late = rows.find((r) => r.kind === 'late');
  const corrections = rows.filter((r) => r.kind === 'corrected').length;
  return {
    absence: absence?.status ?? null,
    absenceCancelReason: absence?.cancelReason ?? null,
    absenceDueAt: absence?.status === 'pending' ? absence.dueAt : null,
    absenceResolvedAt: absence && absence.status !== 'pending' ? absence.updatedAt : null,
    lateAdvice: late?.status ?? null,
    corrections,
    correctionsCapped: rows.some((r) => r.cappedAt !== null),
  };
}

/** Alert rows grouped by `studentId|YYYY-MM-DD`. */
export function alertsByChildDay(rows: readonly AlertRecord[]): Map<string, AlertRecord[]> {
  const map = new Map<string, AlertRecord[]>();
  for (const row of rows) {
    const key = childDayKey(row.studentId, row.date);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export const childDayKey = (studentId: bigint, date: Date): string =>
  `${studentId}|${toDateString(date)}`;
