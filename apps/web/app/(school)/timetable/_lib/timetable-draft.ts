import { ApiError, ErrorCode, timetableClashes, type OtherSlot } from '@asms/shared';
import type {
  OffDayDetails,
  SlotClashDetails,
  TeacherNotAssignedDetails,
  TimetableSlotInput,
} from '../../../../lib/api/school-timetable-contract';
import { WEEKDAY_ORDER } from '../../settings/_lib/settings-ui';

// The week-grid editor's draft (contracts/slice-37.md §7): one cell per weekday and period, each
// with a class-subject, a teacher and an optional room. Pure functions, so the clash highlighting
// and the mapping of a server refusal onto the cells are tested without a browser
// (e2e/timetable.spec.ts). Relative imports only: the spec imports this file directly.

export type CellDraft = { classSubjectId: string; staffId: string; room: string };
/** Keyed by `cellKey(weekday, period)`; an absent key is an empty cell. */
export type Draft = Readonly<Record<string, CellDraft>>;
/** The problems of each cell, by its key; a cell with none is absent. */
export type CellProblems = Record<string, string[]>;

export const EMPTY_CELL: CellDraft = { classSubjectId: '', staffId: '', room: '' };

export const cellKey = (weekday: number, period: number) => `${weekday}:${period}`;

/** A version's slots as a draft (the editor's prefill from the live version). */
export function draftFromSlots(
  slots: readonly { weekday: number; period: number; classSubjectId: string; staffId: string; room: string | null }[],
): Draft {
  const draft: Record<string, CellDraft> = {};
  for (const s of slots) {
    draft[cellKey(s.weekday, s.period)] = { classSubjectId: s.classSubjectId, staffId: s.staffId, room: s.room ?? '' };
  }
  return draft;
}

const isBlank = (cell: CellDraft) => cell.classSubjectId === '' && cell.staffId === '' && cell.room.trim() === '';
const isComplete = (cell: CellDraft) => cell.classSubjectId !== '' && cell.staffId !== '';

/**
 * The request's slots from the complete cells, Monday first then period order, and the cell key
 * of each slot (the API names a slot by its index).
 */
export function slotsFromDraft(draft: Draft): { slots: TimetableSlotInput[]; keys: string[] } {
  const entries = Object.entries(draft)
    .map(([key, cell]) => {
      const [weekday, period] = key.split(':').map(Number) as [number, number];
      return { key, cell, weekday, period };
    })
    .filter((e) => isComplete(e.cell))
    .sort(
      (a, b) =>
        WEEKDAY_ORDER.indexOf(a.weekday as (typeof WEEKDAY_ORDER)[number]) -
          WEEKDAY_ORDER.indexOf(b.weekday as (typeof WEEKDAY_ORDER)[number]) || a.period - b.period,
    );
  return {
    slots: entries.map(({ cell, weekday, period }) => ({
      weekday,
      period,
      classSubjectId: cell.classSubjectId,
      staffId: cell.staffId,
      room: cell.room.trim() === '' ? null : cell.room.trim(),
    })),
    keys: entries.map((e) => e.key),
  };
}

/** Another section's live slot, with the section's label ("Class 5 B") for the message. */
export type OtherCell = OtherSlot & { label: string };

const add = (problems: CellProblems, key: string, message: string) => {
  (problems[key] ??= []).push(message);
};

/**
 * Every problem the editor shows before submitting: a half-filled cell, and the shared
 * `timetableClashes` over the complete cells against the other sections' live slots.
 */
export function cellProblems(
  draft: Draft,
  ctx: { periodsPerDay: number; weeklyOffDays: readonly number[]; others: readonly OtherCell[] },
): CellProblems {
  const problems: CellProblems = {};
  for (const [key, cell] of Object.entries(draft)) {
    if (!isBlank(cell) && !isComplete(cell)) add(problems, key, 'Choose both a subject and a teacher.');
  }
  const { slots, keys } = slotsFromDraft(draft);
  const labels = new Map(ctx.others.map((o) => [o.id, o.label]));
  for (const clash of timetableClashes(slots, ctx)) {
    const key = keys[clash.index]!;
    switch (clash.kind) {
      case 'weekday':
      case 'period':
        add(problems, key, "Outside the school's periods per day.");
        break;
      case 'off_day':
        add(problems, key, 'This is a weekly-off day.');
        break;
      case 'section':
        add(problems, key, 'Two lessons share this period.');
        break;
      case 'teacher':
      case 'room': {
        const where =
          clash.conflictingSlotId !== undefined
            ? (labels.get(clash.conflictingSlotId) ?? 'another section')
            : 'this section';
        add(
          problems,
          key,
          clash.kind === 'teacher'
            ? `The teacher is already timetabled in ${where} in this period.`
            : `The room is already booked by ${where} in this period.`,
        );
        if (clash.otherIndex !== undefined) add(problems, keys[clash.otherIndex]!, 'Clashes with another lesson in this period.');
        break;
      }
    }
  }
  return problems;
}

const FIELD_MESSAGES: Record<string, string> = {
  period: "Outside the school's periods per day.",
  classSubjectId: "Not a subject of this section's class.",
  staffId: 'Not an active member of staff.',
  room: 'The room is not valid.',
};

/**
 * A refusal of the submit, on the cells it names: a clash (by the slot's index), an off day (every
 * cell of the weekday), a teacher without the assignment (every cell with that teacher and
 * subject) or a field error on `slots[i].…`. Null when the refusal names no cell.
 */
export function serverProblems(error: unknown, submitted: { slots: TimetableSlotInput[]; keys: string[] }): CellProblems | null {
  if (!(error instanceof ApiError)) return null;
  const problems: CellProblems = {};
  const details = (error.details ?? {}) as Record<string, unknown>;
  if (error.code === ErrorCode.TIMETABLE_SLOT_CLASH) {
    const d = details as SlotClashDetails;
    const index =
      typeof d.index === 'number'
        ? d.index
        : submitted.slots.findIndex((s) => s.weekday === d.weekday && s.period === d.period);
    const key = submitted.keys[index];
    if (key === undefined) return null;
    add(
      problems,
      key,
      d.kind === 'teacher'
        ? 'The teacher is already timetabled elsewhere in this period.'
        : d.kind === 'room'
          ? 'The room is already booked in this period.'
          : 'Two lessons share this period.',
    );
  } else if (error.code === ErrorCode.TIMETABLE_OFF_DAY) {
    const { weekday } = details as OffDayDetails;
    submitted.slots.forEach((s, i) => {
      if (s.weekday === weekday) add(problems, submitted.keys[i]!, 'This is a weekly-off day.');
    });
  } else if (error.code === ErrorCode.TIMETABLE_TEACHER_NOT_ASSIGNED) {
    const d = details as TeacherNotAssignedDetails;
    submitted.slots.forEach((s, i) => {
      if (s.staffId === d.staffId && s.classSubjectId === d.classSubjectId) {
        add(problems, submitted.keys[i]!, 'This teacher does not teach this subject in this section on the start date.');
      }
    });
  } else {
    for (const field of error.fieldErrors) {
      const match = /^slots\[(\d+)\]\.(\w+)$/.exec(field.path);
      const key = match ? submitted.keys[Number(match[1])] : undefined;
      if (key !== undefined) add(problems, key, FIELD_MESSAGES[match![2]!] ?? field.message);
    }
  }
  return Object.keys(problems).length > 0 ? problems : null;
}
