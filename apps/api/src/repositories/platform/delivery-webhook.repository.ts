import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { DeliveryErrorCode } from '@asms/shared';
import type { SchoolId } from '../../tenancy/school-id';
import { schoolIdFromDeliveryReport } from '../../tenancy/school-id.mint';
import type { PrismaTxAdapter } from '../prisma';

// Named exception 5 (contracts/slice-9.md §8.5): provider webhooks correlate a report with its row
// before any tenant is known, by a globally unique key (the hashed provider reference, the WAHA
// session, the Meta phone-number id). Exactly two statement shapes, tagged $queryRaw (listed in
// RAW_SQL_FILES), importable only from src/webhooks/** (eslint.config.mjs). Each returns the
// school of the row it touched, branded by schoolIdFromDeliveryReport (the only SchoolId it
// mints), so the webhook can enqueue a job that passes through fromQueuePayload. It never reads a
// body, a phone or a recipient. Forward-only: statement A matches a delivery only while it is
// still `accepted` (R108, R172).

export interface ReportedDelivery {
  schoolId: SchoolId;
  messageId: bigint;
  deliveryId: bigint;
}

export interface CountedInbound {
  schoolId: SchoolId;
  whatsappNumberId: bigint;
}

@Injectable()
export class DeliveryWebhookRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Statement A: an accepted WhatsApp delivery, by reference hash, moves to delivered | failed. */
  async reportWhatsApp(
    refHash: string,
    to: 'delivered' | 'failed',
    errorCode: DeliveryErrorCode | null,
  ): Promise<ReportedDelivery | null> {
    const rows = await this.txHost.tx.$queryRaw<
      { school_id: bigint; message_id: bigint; id: bigint }[]
    >`UPDATE message_deliveries
         SET status = ${to}::delivery_status,
             delivered_at = CASE WHEN ${to} = 'delivered' THEN now() ELSE NULL END,
             failed_at = CASE WHEN ${to} = 'failed' THEN now() ELSE NULL END,
             error_code = ${errorCode}::delivery_error_code
       WHERE channel = 'whatsapp'::message_channel
         AND provider_ref_hash = ${refHash}
         AND status = 'accepted'::delivery_status
   RETURNING school_id, message_id, id`;
    const [row] = rows;
    return row
      ? { schoolId: schoolIdFromDeliveryReport(row), messageId: row.message_id, deliveryId: row.id }
      : null;
  }

  /** Statement B, WAHA variant: counts `n` ignored inbound messages on a live session. */
  async countInboundByWahaSession(session: string, n: number): Promise<CountedInbound | null> {
    const rows = await this.txHost.tx.$queryRaw<{ school_id: bigint; id: bigint }[]>`
      UPDATE whatsapp_numbers
         SET inbound_ignored_count = inbound_ignored_count + ${n}
       WHERE waha_session = ${session}
         AND status <> 'disabled'::whatsapp_status
   RETURNING school_id, id`;
    const [row] = rows;
    return row ? { schoolId: schoolIdFromDeliveryReport(row), whatsappNumberId: row.id } : null;
  }

  /** Statement B, Meta variant: by the Cloud API phone-number id. */
  async countInboundByCloudPhoneNumberId(
    phoneNumberId: string,
    n: number,
  ): Promise<CountedInbound | null> {
    const rows = await this.txHost.tx.$queryRaw<{ school_id: bigint; id: bigint }[]>`
      UPDATE whatsapp_numbers
         SET inbound_ignored_count = inbound_ignored_count + ${n}
       WHERE cloud_phone_number_id = ${phoneNumberId}
         AND status <> 'disabled'::whatsapp_status
   RETURNING school_id, id`;
    const [row] = rows;
    return row ? { schoolId: schoolIdFromDeliveryReport(row), whatsappNumberId: row.id } : null;
  }
}
