import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { FeeStructureRepository } from '../../repositories/fee-structure.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { FeeHeadsController, FeeStructuresController } from './fees.controller';
import { FeeHeadsService } from './fee-heads.service';
import { FeeStructuresService } from './fee-structures.service';

/**
 * The receivable side (phase-3-financial.md §2): slice 18's fee heads and fee structures. Slice 19
 * adds charges, concessions, runs and campaigns here.
 */
@Module({
  controllers: [FeeHeadsController, FeeStructuresController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    FeeHeadsService,
    FeeStructuresService,
    FeeHeadRepository,
    FeeStructureRepository,
    AcademicYearRepository,
    ClassRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
})
export class FeesModule {}
