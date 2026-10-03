import { Injectable } from '@nestjs/common';
import type { SchoolId } from '../../tenancy/school-id';

// The R167 seam (contracts/slice-10.md §4.8). Attendance (slice 11) registers a listener from its
// onModuleInit; it imports CalendarModule, never the reverse, so there is no cycle. Wave D ships
// the registry with no listener.

export interface HolidayRange {
  id: bigint;
  /** UTC midnight of the calendar date. */
  startsOn: Date;
  endsOn: Date;
  appliesToStaff: boolean;
}

export interface CalendarListener {
  /** Inside the publish transaction, after the status write, before the notice. */
  holidayPublished(schoolId: SchoolId, holiday: HolidayRange): Promise<void>;
  /** Inside the cancel transaction, only for published → cancelled. */
  holidayCancelled(schoolId: SchoolId, holiday: HolidayRange): Promise<void>;
}

/**
 * The registered listeners, run sequentially in registration order inside the caller's
 * transaction (no Promise.all: one connection). A throw rolls the publish or cancel back. Lock
 * order: the holiday row first, then whatever a listener locks; no listener may lock a holiday.
 */
@Injectable()
export class CalendarListenerRegistry {
  private readonly listeners: CalendarListener[] = [];

  register(listener: CalendarListener): void {
    this.listeners.push(listener);
  }

  async published(schoolId: SchoolId, holiday: HolidayRange): Promise<void> {
    for (const listener of this.listeners) await listener.holidayPublished(schoolId, holiday);
  }

  async cancelled(schoolId: SchoolId, holiday: HolidayRange): Promise<void> {
    for (const listener of this.listeners) await listener.holidayCancelled(schoolId, holiday);
  }
}
