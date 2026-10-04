import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
import type { SchoolId } from '../tenancy/school-id';
import { fieldRefused } from './errors/api-exception';

const DAY_MS = 86_400_000;

/** The calendar date of `now` in `timezone`, as a DATE value (midnight UTC of that day). */
export function todayIn(timezone: string, now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

/** A DATE value moved by whole days. */
export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

/** Whole days from `from` to `to` (DATE values; negative when `to` is earlier). */
export const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * `to` on or after `from` and at most `maxDays` after it, else 422 on `field` (the range's end).
 * One rule for every bounded range the API takes: list filters, reports, holiday spans.
 */
export function assertRange(
  from: Date,
  to: Date,
  maxDays: number,
  names: { field: string; from: string } = { field: 'dateTo', from: 'dateFrom' },
): void {
  const days = daysBetween(from, to);
  if (days < 0 || days > maxDays) {
    throw fieldRefused(
      names.field,
      ErrorCode.INVALID_VALUE,
      `${names.field} must be on or after ${names.from} and at most ${maxDays} days after it`,
    );
  }
}

/** The instant a calendar date (a DATE value) starts in `timezone`. */
export function dayStart(timezone: string, day: Date): Date {
  // The zone's offset at that day's UTC midnight, applied once (exact for fixed-offset zones such
  // as Asia/Karachi, and off by at most a DST shift elsewhere).
  const local = new Date(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .format(day)
      .replace(' ', 'T') + 'Z',
  );
  return new Date(day.getTime() - (local.getTime() - day.getTime()));
}

/** The hour (0-23) of `now` in `timezone`. */
export function hourIn(timezone: string, now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
}

/** `YYYY-MM` of `now` in `timezone` (message_usage.year_month). */
export function yearMonthIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .format(now)
    .slice(0, 7);
}

/** The first day of the month after `now`'s month in `timezone`, as a DATE value. */
export function nextMonthStart(timezone: string, now: Date): Date {
  const [year, month] = yearMonthIn(timezone, now).split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, month ?? 1, 1));
}

/**
 * "Today" for a school: the date in the school's own time zone (R53), which is what teacher
 * scope and assignment dates are measured against. One injectable so tests can move the clock.
 */
@Injectable()
export class SchoolClock {
  constructor(private readonly school: OwnSchoolRepository) {}

  now(): Date {
    return new Date();
  }

  async today(schoolId: SchoolId): Promise<Date> {
    const row = await this.school.find(schoolId);
    if (!row) throw new Error('school row missing for a resolved tenant');
    return todayIn(row.timezone, this.now());
  }
}
