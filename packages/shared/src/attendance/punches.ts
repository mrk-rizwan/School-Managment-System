/**
 * Biometric staff attendance (Phase 5 rule 40, phase-5-extended.md §1.1 "Device token", §3.3;
 * R345). A device-agnostic punch carries an instant; these turn it into the school day it belongs
 * to and the mark the first punch of that day makes. The device-punch service decides everything
 * else (mapping, teaching day, an existing mark, duplicates).
 */

/** A punch is accepted from 7 days before receipt to 5 minutes after it (slice 44). */
export const PUNCH_WINDOW = { pastMs: 7 * 86_400_000, futureMs: 5 * 60_000 } as const;

/** `staff.device_user_id`: 1-40 printable ASCII characters, no spaces (§1.1). */
export const DEVICE_USER_ID_PATTERN = /^[!-~]{1,40}$/;

/** True when `punchedAt` lies outside the accepted window around `receivedAt`. */
export function punchOutsideWindow(punchedAt: Date, receivedAt: Date): boolean {
  const delta = punchedAt.getTime() - receivedAt.getTime();
  return delta < -PUNCH_WINDOW.pastMs || delta > PUNCH_WINDOW.futureMs;
}

/** `YYYY-MM-DD` and `HH:MM:SS` of an instant in the school's time zone (24-hour clock). */
function localParts(instant: Date, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}

/** The school day (`YYYY-MM-DD`, in the school's time zone) a punch belongs to. */
export function punchDay(punchedAt: Date, timezone: string): string {
  return localParts(punchedAt, timezone).day;
}

/** `HH:MM` or `HH:MM:SS` (a `time` column) as `HH:MM:SS`; throws on anything else. */
function asClock(time: string): string {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?$/.exec(time);
  if (match === null) throw new RangeError(`not a time of day: ${time}`);
  return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
}

/**
 * The mark the first punch of a school day makes (R345): `late` when the school sets
 * `staff_late_after` and the punch's local time is strictly after it, else `present`. A null
 * setting means nobody is ever marked late by a device.
 */
export function markFromPunch(
  firstPunchAt: Date,
  staffLateAfter: string | null,
  timezone: string,
): 'present' | 'late' {
  if (staffLateAfter === null) return 'present';
  return localParts(firstPunchAt, timezone).time > asClock(staffLateAfter) ? 'late' : 'present';
}
