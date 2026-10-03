import { Injectable } from '@nestjs/common';
import { EXTERNAL_CHANNELS, type DeliveryStatus, type MessageChannel } from '@asms/shared';
import { addDays, dayStart, hourIn, todayIn, yearMonthIn } from '../common/school-clock';
import { MessageDeliveryRepository } from '../repositories/message-delivery.repository';
import { MessageUsageRepository } from '../repositories/message-usage.repository';
// Named exception 6 (contracts/slice-9.md §7.11): the only writer of platform_delivery_health
// outside the platform module. Listed in NAMED_EXCEPTION_SITES (eslint.config.mjs).
import {
  DeliveryHealthRepository,
  type HealthCounts,
} from '../repositories/platform/delivery-health.repository';
import { SchoolMessagingRepository } from '../repositories/school-messaging.repository';
import { WhatsAppNumberRepository } from '../repositories/whatsapp-number.repository';
import type { SchoolId } from '../tenancy/school-id';

/** Yesterday is recomputed until 01:00 school time, so late reports land in it. */
const YESTERDAY_UNTIL_HOUR = 1;

/**
 * The per-school body of `delivery-health-rollup` (§7.11): today's (and until 01:00 yesterday's)
 * deliveries counted by channel and status, the month's SMS use and cap, and the WhatsApp
 * snapshot, upserted per (school, day, channel). Counts and statuses only (R114).
 */
@Injectable()
export class DeliveryHealthRollup {
  constructor(
    private readonly health: DeliveryHealthRepository,
    private readonly deliveries: MessageDeliveryRepository,
    private readonly usage: MessageUsageRepository,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly school: SchoolMessagingRepository,
  ) {}

  async run(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const settings = await this.school.find(schoolId);
    if (!settings) return 0;
    const tz = settings.timezone;
    const today = todayIn(tz, now);
    const days = hourIn(tz, now) < YESTERDAY_UNTIL_HOUR ? [today, addDays(today, -1)] : [today];
    const live = await this.numbers.findLive(schoolId);
    const yearMonth = yearMonthIn(tz, now);
    const snapshot = {
      whatsappStatus: live?.status ?? null,
      whatsappLastHealthyAt: live?.lastHealthyAt ?? null,
      whatsappLastErrorCode: live?.lastErrorCode ?? null,
      smsUsed: await this.usage.smsUsed(schoolId, yearMonth),
      smsCap: settings.smsMonthlyCap,
    };
    let written = 0;
    for (const day of days) {
      const counts = await this.deliveries.countByChannelAndStatus(
        schoolId,
        dayStart(tz, day),
        dayStart(tz, addDays(day, 1)),
      );
      for (const channel of EXTERNAL_CHANNELS) {
        await this.health.upsert(schoolId, day, channel, {
          ...tally(counts, channel),
          ...snapshot,
          computedAt: now,
        });
        written++;
      }
    }
    return written;
  }
}

function tally(
  counts: readonly { channel: MessageChannel; status: DeliveryStatus; count: number }[],
  channel: MessageChannel,
): HealthCounts {
  const of = (status: DeliveryStatus) =>
    counts.find((c) => c.channel === channel && c.status === status)?.count ?? 0;
  return {
    accepted: of('accepted'),
    delivered: of('delivered'),
    failed: of('failed'),
    suppressed: of('suppressed'),
  };
}

/** The rollup with its platform repository, so only this file imports it. */
export const DELIVERY_HEALTH_ROLLUP_PROVIDERS = [DeliveryHealthRollup, DeliveryHealthRepository];
