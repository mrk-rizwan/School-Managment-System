import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { TimetableReadsRepository } from '../../repositories/timetable-reads.repository';
import { TimetableRepository } from '../../repositories/timetable.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  MyTimetableController,
  SectionTimetableController,
  TimetableGridController,
  TimetableSubstitutionsController,
  TimetableVersionsController,
  TimetableWritesThrottleGuard,
} from './timetable.controller';
import { TimetableViewsService } from './timetable-views.service';
import { TimetableService } from './timetable.service';

/**
 * The period timetable (phase-5-extended.md slice 37, contracts/slice-37.md): versions, slots,
 * substitutions, the section week, the family and own-week views and the grid. Owns
 * TimetableRepository (lint: importable only here); attendance and leave read the timetable
 * through TimetableReadsRepository. CalendarModule lends the teaching-day reads; SchoolClock comes
 * from the global AccessModule.
 */
@Module({
  imports: [CalendarModule],
  controllers: [
    SectionTimetableController,
    TimetableVersionsController,
    TimetableSubstitutionsController,
    TimetableGridController,
    MyTimetableController,
  ],
  providers: [
    SchoolContext,
    SchoolSettingsReader,
    IdempotencyKeyGuard,
    IdempotentRequests,
    TimetableWritesThrottleGuard,
    MeReadsThrottleGuard,
    TimetableService,
    TimetableViewsService,
    TimetableRepository,
    TimetableReadsRepository,
    IdempotencyKeyRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
  ],
})
export class TimetableModule {}
