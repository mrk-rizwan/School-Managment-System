import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { MessageChannel } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table message_usage (contracts/slice-9.md §7.7, R109): the month's sends per
// channel; SMS counts segments (the billing unit), other channels accepted legs. The SMS cap is
// enforced by a conditional increment: Postgres re-evaluates an UPDATE's WHERE on the locked row,
// so two concurrent reservations can never both pass `sent_count + n <= cap`. No explicit lock.

export interface UsageRow {
  yearMonth: string;
  channel: MessageChannel;
  sentCount: number;
}

@Injectable()
export class MessageUsageRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The month's row exists afterwards (ON CONFLICT DO NOTHING). */
  private async ensure(schoolId: SchoolId, yearMonth: string, channel: MessageChannel): Promise<void> {
    await this.txHost.tx.messageUsage.createMany({
      data: [{ schoolId, yearMonth, channel, sentCount: 0 }],
      skipDuplicates: true,
    });
  }

  /**
   * Reserves `segments` SMS units against `cap` for the month. False when the reservation would
   * exceed the cap: nothing is counted and the leg is `suppressed: cap_reached`.
   */
  async reserveSms(
    schoolId: SchoolId,
    yearMonth: string,
    segments: number,
    cap: number,
  ): Promise<boolean> {
    if (segments > cap) return false;
    await this.ensure(schoolId, yearMonth, 'sms');
    const { count } = await this.txHost.tx.messageUsage.updateMany({
      where: { schoolId, yearMonth, channel: 'sms', sentCount: { lte: cap - segments } },
      data: { sentCount: { increment: segments } },
    });
    return count === 1;
  }

  /** An accepted push, WhatsApp or email leg: one more, no cap. */
  async increment(schoolId: SchoolId, yearMonth: string, channel: MessageChannel): Promise<void> {
    await this.ensure(schoolId, yearMonth, channel);
    await this.txHost.tx.messageUsage.updateMany({
      where: { schoolId, yearMonth, channel },
      data: { sentCount: { increment: 1 } },
    });
  }

  forMonths(schoolId: SchoolId, yearMonths: readonly string[]): Promise<UsageRow[]> {
    return this.txHost.tx.messageUsage.findMany({
      where: { schoolId, yearMonth: { in: [...yearMonths] } },
      select: { yearMonth: true, channel: true, sentCount: true },
      orderBy: [{ yearMonth: 'desc' }, { channel: 'asc' }],
    });
  }

  async smsUsed(schoolId: SchoolId, yearMonth: string): Promise<number> {
    const row = await this.txHost.tx.messageUsage.findFirst({
      where: { schoolId, yearMonth, channel: 'sms' },
      select: { sentCount: true },
    });
    return row?.sentCount ?? 0;
  }
}
