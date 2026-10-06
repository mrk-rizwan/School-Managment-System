import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { ReasonDto } from '../fees/fees.dto';
import {
  CollectionsQueryDto,
  CollectionsReportDto,
  ConcessionsQueryDto,
  ConcessionsReportDto,
  DailyCashQueryDto,
  DailyCashReportDto,
  DefaulterDto,
  DefaultersQueryDto,
  DuesClearanceDto,
  ExpensesQueryDto,
  ExpensesReportDto,
  OutstandingQueryDto,
  OutstandingReportDto,
  PayrollQueryDto,
  PayrollReportDto,
  RemindersSentDto,
  SendRemindersDto,
} from './finance-reports.dto';
import { FinanceReportsService } from './finance-reports.service';

// phase-3-financial.md slice 22 (contracts/slice-22.md §1). Common to every route: 401
// AUTH_REQUIRED, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429. Teachers reach none of it (R234).
const COMMON = [401, 403, 429];

/** §5 named throttle: every finance report, 30/min and 300/h per user. */
export const FinanceReportsThrottleGuard = perUserThrottle('finance-reports', 30, 300);

/** A manual reminder send writes a message per family: 5/min and 30/h per user. */
export const FeeRemindersSendThrottleGuard = perUserThrottle('fee-reminders-send', 5, 30);

@ApiTags('finance-reports')
@Controller('finance-reports')
@RequireCapability(Capability.FINANCE_REPORT_VIEW)
@UseGuards(FinanceReportsThrottleGuard)
export class FinanceReportsController {
  constructor(private readonly reports: FinanceReportsService) {}

  @Get('defaulters')
  @ApiPaginated(DefaulterDto)
  @ApiErrors(...COMMON, 422)
  defaulters(@Query() query: DefaultersQueryDto): Promise<Page<DefaulterDto>> {
    return this.reports.defaulters(query);
  }

  @Get('collections')
  @ApiOkResponse({ type: CollectionsReportDto })
  @ApiErrors(...COMMON, 422)
  collections(@Query() query: CollectionsQueryDto): Promise<CollectionsReportDto> {
    return this.reports.collections(query);
  }

  @Get('outstanding')
  @ApiOkResponse({ type: OutstandingReportDto })
  @ApiErrors(...COMMON, 422)
  outstanding(@Query() query: OutstandingQueryDto): Promise<OutstandingReportDto> {
    return this.reports.outstanding(query);
  }

  @Get('daily-cash')
  @ApiOkResponse({ type: DailyCashReportDto })
  @ApiErrors(...COMMON, 422)
  dailyCash(@Query() query: DailyCashQueryDto): Promise<DailyCashReportDto> {
    return this.reports.dailyCash(query);
  }

  @Get('concessions')
  @ApiOkResponse({ type: ConcessionsReportDto })
  @ApiErrors(...COMMON, 422)
  concessions(@Query() query: ConcessionsQueryDto): Promise<ConcessionsReportDto> {
    return this.reports.concessions(query);
  }

  @Get('expenses')
  @ApiOkResponse({ type: ExpensesReportDto })
  @ApiErrors(...COMMON, 422)
  expenses(@Query() query: ExpensesQueryDto): Promise<ExpensesReportDto> {
    return this.reports.expenses(query);
  }

  @Get('payroll')
  @ApiOkResponse({ type: PayrollReportDto })
  @ApiErrors(...COMMON, 422)
  payroll(@Query() query: PayrollQueryDto): Promise<PayrollReportDto> {
    return this.reports.payroll(query);
  }
}

@ApiTags('finance-reports')
@Controller('fee-reminders')
@UseGuards(FeeRemindersSendThrottleGuard)
export class FeeRemindersController {
  constructor(private readonly reports: FinanceReportsService) {}

  /** The fee-reminder job on demand (R202): the same caps, R107 keeps a retry from sending twice. */
  @Post('send')
  @HttpCode(200)
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiOkResponse({ type: RemindersSentDto })
  @ApiErrors(...COMMON, 422)
  send(@Body() body: SendRemindersDto, @Query() _query: NoQueryDto): Promise<RemindersSentDto> {
    return this.reports.sendReminders(body);
  }
}

@ApiTags('finance-reports')
@Controller('students')
export class DuesClearanceController {
  constructor(private readonly reports: FinanceReportsService) {}

  @Get(':id/dues-clearance')
  @RequireCapability(Capability.FEE_STATEMENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: DuesClearanceDto })
  @ApiErrors(...COMMON, 404, 422)
  clearance(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<DuesClearanceDto> {
    return this.reports.clearance(id);
  }

  /** R204: certificate.issue + principal (R233); the audit row is the override. */
  @Post(':id/dues-clearance/override')
  @HttpCode(200)
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @ApiIdParam()
  @ApiOkResponse({ type: DuesClearanceDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  override(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<DuesClearanceDto> {
    return this.reports.override(session, id, body);
  }
}
