import { Injectable } from '@nestjs/common';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
import type { SchoolId } from '../tenancy/school-id';

const DAY_MS = 86_400_000;

/** The calendar date of `now` in `timezone`, as a DATE value (midnight UTC of that day). */
export function todayIn(timezone: string, now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

/** A DATE value moved by whole days. */
export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

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
