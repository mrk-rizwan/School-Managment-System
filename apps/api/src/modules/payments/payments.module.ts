import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { StorageModule } from '../../common/storage/storage.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { CashHandoverRepository } from '../../repositories/cash-handover.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { PaymentAccountRepository } from '../../repositories/payment-account.repository';
import { PaymentClaimRepository } from '../../repositories/payment-claim.repository';
import { PaymentAllocationRepository } from '../../repositories/payment-allocation.repository';
import { PaymentReversalRepository } from '../../repositories/payment-reversal.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import { ReceiptRepository } from '../../repositories/receipt.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { UserRepository } from '../../repositories/user.repository';
import { DocumentsModule } from '../documents/documents.module';
import { UploadsService } from '../documents/uploads.service';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { Advances } from './advances';
import { CashHandoversService } from './cash-handovers.service';
import {
  ClaimWritesThrottleGuard,
  GuardianUploadDayGuard,
  MyChildFeesController,
  MyReceiptsController,
  MyUploadsController,
  PaymentClaimsController,
} from './claims.controller';
import { ClaimsService } from './claims.service';
import { MyFeesService } from './my-fees.service';
import { MyPaymentAccountsController, PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentReversalsService } from './payment-reversals.service';
import {
  CashHandoversController,
  GuardianDuesController,
  MyCustodyController,
  PaymentPreviewThrottleGuard,
  PaymentsController,
  ReceiptsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * The payment side (phase-3-financial.md §2): slice 18's school payment accounts; slice 20's
 * payments, allocations, receipts, reversals, custody and handovers. Exports Advances (the fee
 * side's insert paths and credits move advances through it, R189, A6) and PaymentsService (the
 * statement's payments, R205). Slice 21's deposit claims, the guardian's dues and receipts and the
 * guardian's upload (UploadsService, with DocumentsModule's re-encode limit and AttachmentFiles);
 * it exports ClaimsService for the claim-image-sweep job. MessagingModule lends
 * NotificationService; PermissionsService and SchoolClock come from the global modules.
 */
@Module({
  imports: [MessagingModule, DocumentsModule, StorageModule],
  controllers: [
    PaymentAccountsController,
    MyPaymentAccountsController,
    PaymentsController,
    ReceiptsController,
    GuardianDuesController,
    CashHandoversController,
    MyCustodyController,
    PaymentClaimsController,
    MyChildFeesController,
    MyReceiptsController,
    MyUploadsController,
  ],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    PaymentPreviewThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    PaymentAccountsService,
    PaymentsService,
    PaymentReversalsService,
    CashHandoversService,
    Advances,
    PaymentAccountRepository,
    PaymentRepository,
    PaymentAllocationRepository,
    ReceiptRepository,
    PaymentReversalRepository,
    CashHandoverRepository,
    ChargeRepository,
    FeeHeadRepository,
    ExpenseRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
    ChangeContextRepository,
    // Slice 21.
    ClaimsService,
    MyFeesService,
    UploadsService,
    ClaimWritesThrottleGuard,
    GuardianUploadDayGuard,
    PaymentClaimRepository,
    StagedUploadRepository,
    SchoolSettingsRepository,
    UserRepository,
  ],
  exports: [Advances, PaymentsService, ClaimsService],
})
export class PaymentsModule {}
