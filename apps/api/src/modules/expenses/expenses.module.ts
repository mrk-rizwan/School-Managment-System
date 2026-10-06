import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { StorageModule } from '../../common/storage/storage.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { UserRepository } from '../../repositories/user.repository';
import { DocumentsModule } from '../documents/documents.module';
import { ExpenseFilesThrottleGuard, ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/**
 * Expenses (phase-3-financial.md slice 23): record, the approval threshold, decisions, voids and
 * the receipt image. DocumentsModule lends AttachmentFiles, so receipts stream and thumbnail like
 * the diary's attachments under the one re-encode limit.
 */
@Module({
  imports: [MessagingModule, DocumentsModule, StorageModule],
  controllers: [ExpensesController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    ExpenseFilesThrottleGuard,
    ExpensesService,
    ExpenseRepository,
    StagedUploadRepository,
    SchoolSettingsRepository,
    UserRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  // The Approvals read (slice 27) lists the pending queue through the service.
  exports: [ExpensesService],
})
export class ExpensesModule {}
