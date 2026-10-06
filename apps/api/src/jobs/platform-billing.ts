import { Injectable, Logger } from '@nestjs/common';
import { failureLog } from '../common/errors/failure-log';
import { BillingRunService } from '../modules/platform/billing/billing-run.service';

/**
 * The scheduled body of `platform-billing` (daily 04:00 Asia/Karachi; phase-3-financial.md §3.7):
 * non-tenant, so it runs no school context and fans out over nothing. On the 1st the month is
 * issued, every day the overdue and eligibility stamps are written (BillingRunService.daily).
 * eslint.config.mjs lets this file import the billing repositories and no other platform one; the
 * work itself lives in the billing module.
 */
@Injectable()
export class PlatformBillingJob {
  private readonly logger = new Logger('PlatformBillingJob');

  constructor(private readonly billing: BillingRunService) {}

  async run(plannedAt: Date): Promise<void> {
    try {
      const result = await this.billing.daily(plannedAt);
      this.logger.log({ overdue: result.overdue, eligible: result.eligible }, 'platform billing stamps written');
    } catch (error) {
      this.logger.error(failureLog(error), 'platform billing run failed');
    }
  }
}
