import { ApiError, ErrorCode } from '@asms/shared';
import type { DailySummaryDto, SectionDayDto, TeacherAssignmentDto } from '../api/contracts';

// Today (slice-16 §7.1), pure: the unrecorded rows' words, the summary lines, and the cover
// sheet's outcomes. No student name ever appears here — Today is not a secure screen.

export const sectionLabel = (row: { className: string; sectionName: string }) =>
  `${row.className} ${row.sectionName}`.trim();

export function unrecordedDetail(row: SectionDayDto): string[] {
  return [
    row.classTeacherName ?? 'No class teacher',
    ...(row.coverStaffName ? [`Cover: ${row.coverStaffName}`] : []),
    `${row.rosterCount} ${row.rosterCount === 1 ? 'student' : 'students'} · ${
      row.mode === 'daily' ? 'Daily register' : 'Period register'
    }`,
  ];
}

/** "A: 28 P · 2 A · 1 L · 0 O · 1 partly · 2 not recorded"; the caveats when not computed. */
export function summaryLine(row: DailySummaryDto): string {
  if (row.registersExpected === 0) return `${row.sectionName}: not yet computed`;
  const counts = `${row.present} P · ${row.absent} A · ${row.late} L · ${row.onLeave} O · ${row.partial} partly · ${row.unrecorded} not recorded`;
  return `${row.sectionName}: ${counts}${row.stale ? ' (updating…)' : ''}`;
}

/** The summary rows grouped by class, in the server's order. */
export function byClass(rows: readonly DailySummaryDto[]): [string, DailySummaryDto[]][] {
  const groups = new Map<string, DailySummaryDto[]>();
  for (const row of rows) groups.set(row.className, [...(groups.get(row.className) ?? []), row]);
  return [...groups];
}

/** Every summary row says not a teaching day (an empty summary says nothing). */
export const notTeachingDay = (rows: readonly DailySummaryDto[]) =>
  rows.length > 0 && rows.every((r) => !r.teachingDay);

/** The live class-teacher row of the section, whose id the cover row names (slice-10 §6). */
export function coveredAssignment(
  assignments: readonly TeacherAssignmentDto[],
  sectionId: string,
): TeacherAssignmentDto | null {
  return (
    assignments.find(
      (a) =>
        a.role === 'class_teacher' &&
        a.sectionId === sectionId &&
        a.activeToday &&
        a.voidedAt === null,
    ) ?? null
  );
}

/** Thirteen digits typed into the staff search: it searches names only. */
export const looksLikeIdentity = (text: string) => /\d{13}/.test(text.replace(/[\s-]/g, ''));

export const isIsoDate = (text: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));

export type CoverOutcome = { done: boolean; message: string };

/** What the cover sheet says after POST /staff/:id/teacher-assignments (slice-16 §7.1). */
export function coverOutcome(error: unknown, staffName: string): CoverOutcome {
  if (!(error instanceof ApiError)) {
    return { done: false, message: 'No connection. Arranging cover needs a connection.' };
  }
  switch (error.code) {
    case ErrorCode.CAPABILITY_NOT_HELD:
      return { done: false, message: `${staffName} cannot mark registers.` };
    case ErrorCode.SELF_ACTION_FORBIDDEN:
      return { done: false, message: 'You already hold every class.' };
    case ErrorCode.ASSIGNMENT_EXISTS:
      return { done: true, message: `${staffName} already covers this section.` };
    default:
      return { done: false, message: error.fieldErrors[0]?.message ?? error.message };
  }
}
