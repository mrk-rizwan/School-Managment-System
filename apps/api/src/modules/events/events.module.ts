import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EventRepository } from '../../repositories/event.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { AnnouncementsModule } from '../announcements/announcements.module';
import { FeesModule } from '../fees/fees.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { PaymentsModule } from '../payments/payments.module';
import { EventActivityService } from './event-activity.service';
import { EventDutiesController, EventsController, MyEventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventWritesThrottleGuard } from './events.throttle';
import { FinanceReportsThrottleGuard } from '../finance-reports/finance-reports.controller';

/**
 * Events and PTM (phase-5-extended.md slice 38, contracts/slice-38.md): events, duties,
 * participation, the collection duty's payments, the report and the family list. Owns
 * EventRepository (lint: importable only here). Money is written only through the fee and payment
 * services (CampaignsService, ChargesService, PaymentsService.recordForEvent) and the invitation
 * through AnnouncementsService (§2 boundaries). SchoolClock comes from the global AccessModule.
 */
@Module({
  imports: [FeesModule, PaymentsModule, AnnouncementsModule],
  controllers: [EventsController, EventDutiesController, MyEventsController],
  providers: [
    SchoolContext,
    // Phase 5 slice 42: the event report shares the finance-reports bucket (its CSV costs 5).
    FinanceReportsThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    EventWritesThrottleGuard,
    MeReadsThrottleGuard,
    EventsService,
    EventActivityService,
    EventRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  // B8: StaffStatusService ends a leaving member's live duties (StaffModule imports this module).
  exports: [EventsService],
})
export class EventsModule {}
