import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { FinanceReportRepository } from '../../repositories/finance-report.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import { FeeReminders } from './fee-reminders';
import {
  DuesClearanceController,
  FeeRemindersController,
  FeeRemindersSendThrottleGuard,
  FinanceReportsController,
  FinanceReportsThrottleGuard,
} from './finance-reports.controller';
import { FinanceReportsService } from './finance-reports.service';

/**
 * The finance reports, the fee reminders and the dues clearance (phase-3-financial.md §2, slice
 * 22). Read-only over the money tables except the reminders' messages and the override's audit
 * row. Exports FeeReminders for the worker's daily `fee-reminder` job. MessagingModule lends
 * NotificationService, the usage counter and the principals' ids; PermissionsService and
 * SchoolClock come from the global modules.
 */
@Module({
  imports: [MessagingModule],
  controllers: [FinanceReportsController, FeeRemindersController, DuesClearanceController],
  providers: [
    SchoolContext,
    FinanceReportsThrottleGuard,
    FeeRemindersSendThrottleGuard,
    FinanceReportsService,
    FeeReminders,
    FinanceReportRepository,
    AcademicYearRepository,
    ChargeRepository,
    PaymentRepository,
    AuditLogRepository,
  ],
  exports: [FeeReminders],
})
export class FinanceReportsModule {}
