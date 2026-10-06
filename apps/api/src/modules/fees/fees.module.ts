import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeCampaignRepository } from '../../repositories/charge-campaign.repository';
import { ChargeGenerationRepository } from '../../repositories/charge-generation.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { ChargeRunRepository } from '../../repositories/charge-run.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { ConcessionRepository } from '../../repositories/concession.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { FeeStructureRepository } from '../../repositories/fee-structure.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { AdmissionFees } from './admission-fees';
import { CampaignsService } from './campaigns.service';
import { ChargeGeneration } from './charge-generation';
import {
  CampaignsController,
  ChargesController,
  ConcessionsController,
  FeeStatementController,
} from './charges.controller';
import { ChargesService } from './charges.service';
import { ConcessionsService } from './concessions.service';
import { FeeHeadsController, FeeStructuresController } from './fees.controller';
import { FeeHeadsService } from './fee-heads.service';
import { FeeStructuresService } from './fee-structures.service';

/**
 * The receivable side (phase-3-financial.md §2): slice 18's fee heads and fee structures, slice
 * 19's charges, concessions, charge runs and campaigns. Exports AdmissionFees for admission and
 * readmission (R239) and ChargeGeneration for the worker's jobs. MessagingModule lends
 * NotificationService, the outbox and the principals' ids; PermissionsService and SchoolClock come
 * from the global modules.
 */
@Module({
  imports: [MessagingModule],
  controllers: [
    FeeHeadsController,
    FeeStructuresController,
    ChargesController,
    FeeStatementController,
    ConcessionsController,
    CampaignsController,
  ],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    FeeHeadsService,
    FeeStructuresService,
    ChargesService,
    ConcessionsService,
    CampaignsService,
    ChargeGeneration,
    AdmissionFees,
    FeeHeadRepository,
    FeeStructureRepository,
    ChargeRepository,
    ChargeRunRepository,
    ChargeGenerationRepository,
    ChargeCampaignRepository,
    ConcessionRepository,
    AcademicYearRepository,
    ClassRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  exports: [AdmissionFees, ChargeGeneration],
})
export class FeesModule {}
