import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { ExpensesModule } from '../expenses/expenses.module';
import { LeaveModule } from '../leave/leave.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { PaymentsModule } from '../payments/payments.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * GET /me/approvals (phase-3-financial.md slice 27): the four decision queues in one read, through
 * the owning modules' services. PermissionsService comes from the global AccessModule.
 */
@Module({
  imports: [PaymentsModule, ExpensesModule, LeaveModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, SchoolContext, MeReadsThrottleGuard],
})
export class ApprovalsModule {}
