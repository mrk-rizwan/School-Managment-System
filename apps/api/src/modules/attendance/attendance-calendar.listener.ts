import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AttendanceAlertRepository } from '../../repositories/attendance-alert.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { CalendarListenerRegistry, type CalendarListener, type HolidayRange } from '../calendar/calendar-listener';

/**
 * R167 (contracts/slice-11.md §7): a holiday published over recorded days cancels their pending
 * alerts, inside the publish transaction, after the holiday row (lock order: holiday → alerts).
 * Nothing else is written: registers and marks are kept (rule 4), and nothing stored depends on
 * the calendar — the exclusion from every percentage and the console flag are computed at read.
 * Cancelling a holiday writes nothing: its days are teaching days again at the next read.
 */
@Injectable()
export class AttendanceCalendarListener implements CalendarListener, OnModuleInit {
  constructor(
    private readonly registry: CalendarListenerRegistry,
    private readonly alerts: AttendanceAlertRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async holidayPublished(schoolId: SchoolId, holiday: HolidayRange): Promise<void> {
    await this.alerts.cancelPendingForHoliday(schoolId, holiday.startsOn, holiday.endsOn, new Date());
  }

  holidayCancelled(_schoolId: SchoolId, _holiday: HolidayRange): Promise<void> {
    return Promise.resolve();
  }
}
