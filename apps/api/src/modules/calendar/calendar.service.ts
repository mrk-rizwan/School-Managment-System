import { Injectable } from '@nestjs/common';
import {
  isStaffWorkingDay,
  isTeachingDay,
  type SchoolCalendar,
} from '@asms/shared';
import { addDays } from '../../common/school-clock';
import { HolidayRepository, type PublishedHoliday } from '../../repositories/holiday.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';

// contracts/slice-10.md §3 (R116): the teaching-day questions, answered by the pure functions in
// @asms/shared over the school's weekly-off days and its PUBLISHED holidays. Nothing is stored.

/** How far nextTeachingDay looks before answering null (a school closed for over a year). */
const NEXT_TEACHING_DAY_HORIZON = 400;

/** The school's calendar for a range, with the published holiday rows behind it. */
export interface CalendarRange {
  weeklyOffDays: number[];
  holidays: PublishedHoliday[];
  /** The value the shared functions take. */
  value: SchoolCalendar;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly holidays: HolidayRepository,
    private readonly settings: SchoolSettingsRepository,
  ) {}

  /** Settings read plus one holiday query: published, overlapping `from..to`. */
  async calendar(schoolId: SchoolId, from: Date, to: Date): Promise<CalendarRange> {
    const weeklyOffDays = await this.settings.weeklyOffDays(schoolId);
    const holidays = await this.holidays.publishedOverlapping(schoolId, from, to);
    return {
      weeklyOffDays,
      holidays,
      value: {
        weeklyOffDays,
        holidays: holidays.map((h) => ({
          startsOn: toDateString(h.startsOn),
          endsOn: toDateString(h.endsOn),
          appliesToStaff: h.appliesToStaff,
        })),
      },
    };
  }

  /** R118 (slice 11), R129's deadline job. */
  async isTeachingDay(schoolId: SchoolId, date: Date): Promise<boolean> {
    const { value } = await this.calendar(schoolId, date, date);
    return isTeachingDay(toDateString(date), value);
  }

  /** R136 (slice 12): only holidays that apply to staff close the day. */
  async isStaffWorkingDay(schoolId: SchoolId, date: Date): Promise<boolean> {
    const { value } = await this.calendar(schoolId, date, date);
    return isStaffWorkingDay(toDateString(date), value);
  }

  /** The first teaching day after `after`, within 400 days; null beyond (the notice's "reopens"). */
  async nextTeachingDay(schoolId: SchoolId, after: Date): Promise<Date | null> {
    const from = addDays(after, 1);
    const to = addDays(after, NEXT_TEACHING_DAY_HORIZON);
    const { value } = await this.calendar(schoolId, from, to);
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (isTeachingDay(toDateString(day), value)) return day;
    }
    return null;
  }
}
