import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { CashHandoverRepository } from '../../repositories/cash-handover.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { PaymentAccountRepository } from '../../repositories/payment-account.repository';
import { PaymentAllocationRepository } from '../../repositories/payment-allocation.repository';
import { PaymentReversalRepository } from '../../repositories/payment-reversal.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import { ReceiptRepository } from '../../repositories/receipt.repository';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { Advances } from './advances';
import { CashHandoversService } from './cash-handovers.service';
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
 * statement's payments, R205). Slice 21 adds the deposit claims here. MessagingModule lends
 * NotificationService; PermissionsService and SchoolClock come from the global modules.
 */
@Module({
  imports: [MessagingModule],
  controllers: [
    PaymentAccountsController,
    MyPaymentAccountsController,
    PaymentsController,
    ReceiptsController,
    GuardianDuesController,
    CashHandoversController,
    MyCustodyController,
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
  ],
  exports: [Advances, PaymentsService],
})
export class PaymentsModule {}
