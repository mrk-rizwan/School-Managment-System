import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Capability, INVOICE_STATUSES, type InvoiceStatus } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
// A18: the school's read of its own platform bill. eslint.config.mjs names this file and
// src/jobs/billing-notices.ts as the only importers of the repository.
import { OwnInvoicesRepository } from '../../repositories/own-invoices.repository';

export class BillingPlanDto {
  @ApiProperty()
  name: string;

  /** The school's SMS cap while on this plan, unless the platform set another. */
  @ApiProperty({ type: 'integer', minimum: 0 })
  smsAllowance: number;
}

export class CurrentInvoiceDto {
  /** `INV-YYYY-NNNNN`. */
  @ApiProperty()
  invoiceNo: string;

  /** The month billed, `YYYY-MM`. */
  @ApiProperty()
  yearMonth: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Whole rupees' })
  amount: number;

  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;

  @ApiProperty({ enum: INVOICE_STATUSES, enumName: 'InvoiceStatus' })
  status: InvoiceStatus;
}

export class BillingStatusDto {
  /** The school's live plan; null before its first one. */
  @ApiProperty({ type: BillingPlanDto, nullable: true })
  plan: BillingPlanDto | null;

  /** The latest non-void invoice; null before the first. */
  @ApiProperty({ type: CurrentInvoiceDto, nullable: true })
  currentInvoice: CurrentInvoiceDto | null;

  /** Some invoice is unpaid past its due date. */
  @ApiProperty()
  overdue: boolean;

  /**
   * When the oldest unpaid invoice became eligible for suspension; null when none has. The
   * platform decides a suspension by hand: nothing suspends a school automatically (R221).
   */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  suspensionEligibleAt: Date | null;
}

/**
 * `GET /school/billing-status` (phase-3-financial.md slice 26, A18): the school's own platform
 * bill on its settings page. Reads through OwnInvoicesRepository only, whose every tenant-keyed
 * predicate is the session's school (the plan row is read by the id from the school's own
 * subscription); the platform's other schools and tables are out of reach.
 */
@ApiTags('school settings')
@Controller('school/billing-status')
@RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
export class BillingStatusController {
  constructor(private readonly invoices: OwnInvoicesRepository) {}

  @Get()
  @ApiOkResponse({ type: BillingStatusDto })
  @ApiErrors(401, 403, 422)
  async get(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<BillingStatusDto> {
    const plan = await this.invoices.livePlan(session.schoolId);
    const latest = await this.invoices.latest(session.schoolId);
    const unpaid = await this.invoices.unpaid(session.schoolId);
    const eligible = unpaid.find((invoice) => invoice.suspensionEligibleAt !== null);
    return {
      plan,
      currentInvoice:
        latest === null
          ? null
          : {
              invoiceNo: latest.invoiceNo,
              yearMonth: latest.yearMonth,
              amount: latest.amount,
              dueOn: latest.dueOn.toISOString().slice(0, 10),
              status: latest.status,
            },
      overdue: unpaid.some((invoice) => invoice.overdueAt !== null),
      suspensionEligibleAt: eligible?.suspensionEligibleAt ?? null,
    };
  }
}

/** The controller's repository, so only this file imports it (the module spreads this). */
export const BILLING_STATUS_PROVIDERS = [OwnInvoicesRepository];
