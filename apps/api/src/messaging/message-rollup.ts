import { Injectable } from '@nestjs/common';
import { MessageDeliveryRepository } from '../repositories/message-delivery.repository';
import { MessageRepository } from '../repositories/message.repository';
import type { SchoolId } from '../tenancy/school-id';
import { legState } from './legs';
import { OutboxDispatcher } from './outbox-dispatcher';
import { isAfterFailureSms } from './routing';

/**
 * The `message-rollup` job (contracts/slice-9.md §7.6): a report moved one of a `sent` message's
 * deliveries. `sent -> delivered` after a delivered report; `sent -> queued` when the accepted
 * WhatsApp leg was reported failed and its after-failure SMS leg is now due (the processor then
 * applies the allow list and the cap); `sent -> failed` when every accepted leg was later
 * reported failed and nothing remains. Any other status: nothing to do.
 */
@Injectable()
export class MessageRollup {
  constructor(
    private readonly messages: MessageRepository,
    private readonly deliveries: MessageDeliveryRepository,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async run(
    schoolId: SchoolId,
    messageId: bigint,
    now: Date = new Date(),
  ): Promise<'delivered' | 'queued' | 'failed' | 'unchanged'> {
    const message = await this.messages.find(schoolId, messageId);
    if (message?.status !== 'sent') return 'unchanged';
    const rows = await this.deliveries.listForMessage(schoolId, messageId);
    if (rows.some((r) => r.status === 'delivered')) {
      return (await this.messages.moveFromSent(schoolId, messageId, 'delivered', now)) === 1
        ? 'delivered'
        : 'unchanged';
    }
    const plan = message.channelPlan;
    const smsIndex = plan.indexOf('sms');
    const whatsapp = legState('whatsapp', rows);
    const smsPending =
      smsIndex >= 0 &&
      isAfterFailureSms(message.priority, plan, smsIndex) &&
      whatsapp.finished &&
      !whatsapp.succeeded &&
      !rows.some((r) => r.channel === 'sms');
    if (smsPending) {
      if ((await this.messages.moveFromSent(schoolId, messageId, 'queued', now)) !== 1) {
        return 'unchanged';
      }
      await this.outbox.messages(schoolId, [{ id: messageId, round: rows.length }]);
      return 'queued';
    }
    if (!rows.some((r) => r.status === 'accepted')) {
      return (await this.messages.moveFromSent(schoolId, messageId, 'failed', now)) === 1
        ? 'failed'
        : 'unchanged';
    }
    // Still `sent` (another leg is accepted): mark it rolled up, so the sweep leaves it be.
    await this.messages.touchSent(schoolId, messageId, now);
    return 'unchanged';
  }
}
