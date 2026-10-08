import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { PromotionRepository } from '../../repositories/promotion.repository';
import { FinanceReportsModule } from '../finance-reports/finance-reports.module';
import { StudentsModule } from '../people/students/students.module';
import { PromotionController, PromotionWritesThrottleGuard } from './promotion.controller';
import { PromotionService } from './promotion.service';

/**
 * Promotion and year end (phase-4-academic.md slice 35): the per-section promotion sheet, its
 * decisions and apply. Enrolments are written only through EnrolmentsService and statuses only
 * through StudentsService (StudentsModule exports both); dues are read only through
 * FinanceReportsService.clearance. PermissionsService and SchoolClock come from the global
 * AccessModule. The year-close guard (R299) lives in AcademicYearsService.
 */
@Module({
  imports: [StudentsModule, FinanceReportsModule],
  controllers: [PromotionController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    PromotionWritesThrottleGuard,
    PromotionService,
    PromotionRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
})
export class PromotionModule {}
