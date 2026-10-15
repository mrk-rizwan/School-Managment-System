import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { ImportRepository } from '../../repositories/import.repository';
import { AssessmentsModule } from '../assessments/assessments.module';
import { FeesModule } from '../fees/fees.module';
import { ResultsModule } from '../results/results.module';
import { ImportFileInterceptor } from './import-upload';
import { ImportsController, ImportWritesThrottleGuard } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Commencement imports (phase-5-extended.md rule 39, slice 43; contracts/slice-43.md): past
 * results and opening balances, previewed then committed. Owns ImportRepository (lint: importable
 * only here and from the staged-upload sweep, which expires previews). Writes marks only through
 * AssessmentsService.importExamMarks, sheets and results only through ResultImportService, and
 * charges only through ChargesService, so it imports no assessment, result or money repository.
 * SchoolClock and PermissionsService come from the global AccessModule.
 */
@Module({
  imports: [AssessmentsModule, ResultsModule, FeesModule],
  controllers: [ImportsController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    ImportWritesThrottleGuard,
    ImportFileInterceptor,
    ImportsService,
    ImportRepository,
    AcademicYearRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
})
export class ImportsModule {}
