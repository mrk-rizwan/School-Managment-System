import { Module } from '@nestjs/common';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { BILLING_STATUS_PROVIDERS, BillingStatusController } from './billing-status.controller';
import { SchoolSettingsController } from './school-settings.controller';
import { SchoolSettingsService } from './school-settings.service';

/** /api/v1/school/settings (contracts/slice-2.md §6) and /api/v1/school/billing-status (slice 26). */
@Module({
  controllers: [SchoolSettingsController, BillingStatusController],
  providers: [
    SchoolSettingsService,
    SchoolSettingsRepository,
    AuditLogRepository,
    // GET /school/billing-status (slice 26, A18): its repository, imported only there.
    ...BILLING_STATUS_PROVIDERS,
  ],
  // OwnSchoolRepository (smsMonthlyCap) is exported by the global TenancyModule.
})
export class SchoolSettingsModule {}
