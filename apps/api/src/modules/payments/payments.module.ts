import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { PaymentAccountRepository } from '../../repositories/payment-account.repository';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { MyPaymentAccountsController, PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';

/**
 * The payment side (phase-3-financial.md §2): slice 18's school payment accounts. Slices 20-21
 * add payments, receipts, reversals, custody and claims here.
 */
@Module({
  controllers: [PaymentAccountsController, MyPaymentAccountsController],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    PaymentAccountsService,
    PaymentAccountRepository,
    AuditLogRepository,
  ],
})
export class PaymentsModule {}
