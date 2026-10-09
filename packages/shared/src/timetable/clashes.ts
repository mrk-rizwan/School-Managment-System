/**
 * Timetable clash detection (Phase 5 rule 33, phase-5-extended.md §1.1, §3.2, §3.3; R302). The
 * web and the app check a draft week before submitting; the API checks again with the other
 * sections' live slots; the database holds the same rules as exclusion constraints. One function,
 * so the three agree.
 */

/** A version has at most this many periods a day (`timetable_slots.period` 1-12). */
export const MAX_TIMETABLE_PERIODS = 12;

/** A slot's free-text room (§1.1): at most 40 characters, trimmed; clashes compare it lower-cased. */
export const TIMETABLE_ROOM_MAX = 40;

/** One slot of the week being drafted for a section. Ids are the API's string ids. */
export interface DraftSlot {
  /** 0 = Sunday ... 6 = Saturday, as `weekly_off_days`. */
  readonly weekday: number;
  /** 1-based. */
  readonly period: number;
  readonly staffId: string;
  readonly room?: string | null;
}

/** A live slot of another section whose date range overlaps the draft's (the caller selects them). */
export interface OtherSlot extends DraftSlot {
  readonly id: string;
  readonly sectionId: string;
}

export interface ClashContext {
  /** `school_settings.periods_per_day`. */
  readonly periodsPerDay: number;
  /** `school_settings.weekly_off_days`. */
  readonly weeklyOffDays: readonly number[];
  /** Other sections' live slots overlapping the draft's range; omit on the client. */
  readonly others?: readonly OtherSlot[];
}

/**
 * One problem with one draft slot, by its index in the draft. `section`: two slots of the draft
 * share a weekday and period. `teacher` / `room`: the teacher or room is already used in that
 * weekday and period, by another draft slot (`otherIndex`) or another section (`conflictingSlotId`).
 * `off_day`: the weekday is a weekly-off day. `period`: outside 1..periods_per_day, or not a
 * whole number; `weekday` likewise outside 0..6.
 */
export type TimetableClash =
  | {
      readonly kind: 'section' | 'teacher' | 'room';
      readonly index: number;
      readonly weekday: number;
      readonly period: number;
      readonly otherIndex: number;
      readonly conflictingSlotId?: undefined;
    }
  | {
      readonly kind: 'teacher' | 'room';
      readonly index: number;
      readonly weekday: number;
      readonly period: number;
      readonly otherIndex?: undefined;
      readonly conflictingSlotId: string;
    }
  | { readonly kind: 'off_day' | 'period' | 'weekday'; readonly index: number; readonly weekday: number; readonly period: number };

/** The room as the clash rule compares it (`lower(btrim(room))`), or null when there is none. */
export function roomKey(room: string | null | undefined): string | null {
  const key = room?.trim().toLowerCase() ?? '';
  return key === '' ? null : key;
}

/**
 * Every clash in a draft week, in draft order (each slot's problems in the order: weekday,
 * period, off day, section, teacher, room). A pair of clashing draft slots is reported once, on
 * the later slot. An empty list means the draft can be submitted.
 */
export function timetableClashes(slots: readonly DraftSlot[], ctx: ClashContext): TimetableClash[] {
  const clashes: TimetableClash[] = [];
  const periods = Math.min(ctx.periodsPerDay, MAX_TIMETABLE_PERIODS);
  slots.forEach((slot, index) => {
    const at = { index, weekday: slot.weekday, period: slot.period };
    if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) {
      clashes.push({ kind: 'weekday', ...at });
      return;
    }
    if (!Number.isInteger(slot.period) || slot.period < 1 || slot.period > periods) {
      clashes.push({ kind: 'period', ...at });
      return;
    }
    if (ctx.weeklyOffDays.includes(slot.weekday)) clashes.push({ kind: 'off_day', ...at });
    const room = roomKey(slot.room);
    const same = (other: DraftSlot) => other.weekday === slot.weekday && other.period === slot.period;
    const earlier = slots.slice(0, index);
    const sectionIndex = earlier.findIndex(same);
    if (sectionIndex >= 0) clashes.push({ kind: 'section', ...at, otherIndex: sectionIndex });
    const teacherIndex = earlier.findIndex((o) => same(o) && o.staffId === slot.staffId);
    if (teacherIndex >= 0) {
      clashes.push({ kind: 'teacher', ...at, otherIndex: teacherIndex });
    } else {
      const other = ctx.others?.find((o) => same(o) && o.staffId === slot.staffId);
      if (other) clashes.push({ kind: 'teacher', ...at, conflictingSlotId: other.id });
    }
    if (room !== null) {
      const roomIndex = earlier.findIndex((o) => same(o) && roomKey(o.room) === room);
      if (roomIndex >= 0) {
        clashes.push({ kind: 'room', ...at, otherIndex: roomIndex });
      } else {
        const other = ctx.others?.find((o) => same(o) && roomKey(o.room) === room);
        if (other) clashes.push({ kind: 'room', ...at, conflictingSlotId: other.id });
      }
    }
  });
  return clashes;
}
