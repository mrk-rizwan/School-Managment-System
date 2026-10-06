import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { failureLog } from '../common/errors/failure-log';
import { MESSAGING_DRIVERS, type MessagingDrivers } from './drivers/types';
import { renderBillingTierMissing, type BillingTierMissingInput } from './templates';

/**
 * Platform-priority messages (no `messages` row, no tenant person): email to PLATFORM_ALERT_EMAIL.
 * The drivers are internal to src/messaging (plan rule 0.11), so code outside it that raises a
 * platform alert calls this. whatsapp_session_down keeps its own sender in whatsapp-health.ts.
 */
@Injectable()
export class PlatformAlerts {
  private readonly logger = new Logger('PlatformAlerts');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(MESSAGING_DRIVERS) private readonly drivers: MessagingDrivers,
  ) {}

  /**
   * billing_tier_missing (phase-3-financial.md §3.6, R220): the scheduled monthly run skipped
   * schools for want of a recent student count or a band. One email per run; never throws.
   */
  async billingTierMissing(input: BillingTierMissingInput): Promise<void> {
    if (input.skipped.length === 0) return;
    const to = this.env.PLATFORM_ALERT_EMAIL;
    if (to === undefined) {
      this.logger.warn({ yearMonth: input.yearMonth, skipped: input.skipped.length }, 'billing skipped schools; no PLATFORM_ALERT_EMAIL set');
      return;
    }
    const mail = renderBillingTierMissing(input);
    try {
      await this.drivers.email.send(to, mail.title, mail.body);
    } catch (error) {
      this.logger.error(failureLog(error), 'billing_tier_missing not sent');
    }
  }
}
