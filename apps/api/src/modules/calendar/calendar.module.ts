import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { HolidayRepository } from '../../repositories/holiday.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { CalendarListenerRegistry } from './calendar-listener';
import { CalendarReadsService } from './calendar-reads.service';
import { CalendarController, MyCalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { HolidaysController } from './holidays.controller';
import { HolidaysService } from './holidays.service';

/**
 * Holidays and teaching-day arithmetic (Phase 2 slice 10, contracts/slice-10.md): the holiday
 * routes, GET /calendar/teaching-days and GET /me/calendar. Exports CalendarService (R116's
 * questions for slices 11 and 12) and the CalendarListenerRegistry (R167: attendance registers its
 * listener from onModuleInit; it imports this module, never the reverse). The pure teaching-day
 * functions are in @asms/shared (calendar.ts).
 */
@Module({
  imports: [MessagingModule],
  controllers: [HolidaysController, CalendarController, MyCalendarController],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    CalendarService,
    CalendarReadsService,
    CalendarListenerRegistry,
    HolidaysService,
    HolidayRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
  ],
  exports: [CalendarService, CalendarListenerRegistry],
})
export class CalendarModule {}
