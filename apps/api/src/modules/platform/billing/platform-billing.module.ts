import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../messaging/messaging.module';
import { InvoiceRepository } from '../../../repositories/platform/invoice.repository';
import { PlanRepository } from '../../../repositories/platform/plan.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformPaymentRepository } from '../../../repositories/platform/platform-payment.repository';
import { PlatformSettingsRepository } from '../../../repositories/platform/platform-settings.repository';
import { SchoolMetricsRepository } from '../../../repositories/platform/school-metrics.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { SubscriptionRepository } from '../../../repositories/platform/subscription.repository';
import { BillingRunService } from './billing-run.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { SchoolBillingController } from './school-billing.controller';
import { SchoolBillingService } from './school-billing.service';

/**
 * Platform billing (phase-3-financial.md slice 26, §3.7, R219-R224): plans, subscriptions,
 * invoices, platform payments and the monthly run. Platform code on non-tenant tables only: lint
 * refuses any tenant repository here (R222), and the five billing repositories are importable
 * from nowhere else but src/jobs/platform-billing.ts and (metrics, write) the per-school rollup.
 * BillingRunService is exported for the scheduled job.
 */
@Module({
  imports: [MessagingModule],
  controllers: [PlansController, InvoicesController, SchoolBillingController],
  providers: [
    PlansService,
    InvoicesService,
    SchoolBillingService,
    BillingRunService,
    PlanRepository,
    SubscriptionRepository,
    SchoolMetricsRepository,
    InvoiceRepository,
    PlatformPaymentRepository,
    PlatformSettingsRepository,
    PlatformAuditRepository,
    SchoolRepository,
  ],
  exports: [BillingRunService],
})
export class PlatformBillingModule {}
