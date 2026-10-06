import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { PayrollRunRepository } from '../../repositories/payroll-run.repository';
import { PayslipRepository } from '../../repositories/payslip.repository';
import { SalaryAdvanceRepository } from '../../repositories/salary-advance.repository';
import { SalaryStructureRepository } from '../../repositories/salary-structure.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { PayrollEngine } from './payroll-engine';
import { PayrollPrepare } from './payroll-prepare.job';
import { PayrollRunsService } from './payroll-runs.service';
import {
  MyPayrollController,
  PayrollRunsController,
  PayslipsController,
  SalaryAdvancesController,
  StaffSalaryController,
} from './payroll.controller';
import { SalaryAdvancesService } from './salary-advances.service';
import { SalaryStructuresService } from './salary-structures.service';

/**
 * Salary (phase-3-financial.md slice 25, contracts/slice-25.md): structures, advances, the monthly
 * run and payslips. Working days come from CalendarModule; PermissionsService and SchoolClock
 * from the global AccessModule. Exports PayrollPrepare, the pay-day job's body
 * (src/jobs/job-runner.ts).
 */
@Module({
  imports: [MessagingModule, CalendarModule],
  controllers: [
    StaffSalaryController,
    SalaryAdvancesController,
    PayrollRunsController,
    PayslipsController,
    MyPayrollController,
  ],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    SalaryStructuresService,
    SalaryAdvancesService,
    PayrollRunsService,
    PayrollEngine,
    PayrollPrepare,
    SalaryStructureRepository,
    SalaryAdvanceRepository,
    PayrollRunRepository,
    PayslipRepository,
    ExpenseRepository,
    StaffRepository,
    SchoolSettingsRepository,
    OwnSchoolRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  exports: [PayrollPrepare],
})
export class PayrollModule {}
