import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { WhatsAppErrorCode, WhatsAppProvider, WhatsAppStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table whatsapp_numbers (contracts/slice-9.md §5.3-§5.6, §7.8): the school's own
// number, one live row per school (partial unique whatsapp_numbers_school_id_live_key). Status is
// written only by the school routes and the health job, never by a webhook. Lock order:
// school_settings -> ... -> whatsapp_numbers (§1.7).

export const WHATSAPP_LIVE_UNIQUE = 'whatsapp_numbers_school_id_live_key';
export const WHATSAPP_CLOUD_ID_UNIQUE = 'whatsapp_numbers_cloud_phone_number_id_key';

export interface WhatsAppNumberRecord {
  id: bigint;
  phone: string;
  provider: WhatsAppProvider;
  wahaSession: string | null;
  cloudPhoneNumberId: string | null;
  /** AES-256-GCM `v1:...`; decrypted only by the Cloud API driver path. */
  cloudAccessToken: string | null;
  status: WhatsAppStatus;
  lastHealthyAt: Date | null;
  lastErrorCode: WhatsAppErrorCode | null;
  inboundIgnoredCount: number;
  pairedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  phone: true,
  provider: true,
  wahaSession: true,
  cloudPhoneNumberId: true,
  cloudAccessToken: true,
  status: true,
  lastHealthyAt: true,
  lastErrorCode: true,
  inboundIgnoredCount: true,
  pairedAt: true,
  createdAt: true,
} as const;

/** What a health check writes on a transition (§7.8). */
export interface HealthWrite {
  status: 'connected' | 'down';
  lastHealthyAt?: Date;
  lastErrorCode?: WhatsAppErrorCode | null;
  pairedAt?: Date;
}

/** The WAHA session name of a row: derived from its id, set once, never reused. */
export const wahaSessionName = (id: bigint): string => `asms_${id}`;

@Injectable()
export class WhatsAppNumberRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The live row (status other than `disabled`), or null. */
  findLive(schoolId: SchoolId): Promise<WhatsAppNumberRecord | null> {
    return this.txHost.tx.whatsAppNumber.findFirst({
      where: { schoolId, status: { not: 'disabled' } },
      select: SELECT,
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<WhatsAppNumberRecord | null> {
    return this.txHost.tx.whatsAppNumber.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /**
   * Locks the live row for the rest of the transaction and returns it as read under the lock, or
   * null. A no-op UPDATE takes the row lock without raw SQL.
   */
  async lockLive(schoolId: SchoolId): Promise<WhatsAppNumberRecord | null> {
    const [row] = await this.txHost.tx.whatsAppNumber.updateManyAndReturn({
      where: { schoolId, status: { not: 'disabled' } },
      data: { updatedAt: new Date() },
      select: SELECT,
    });
    return row ?? null;
  }

  /** First pairing (§5.4): a `pending` WAHA row; its session name is set from its id. */
  async createWaha(
    schoolId: SchoolId,
    data: { phone: string; pairedBy: bigint },
  ): Promise<WhatsAppNumberRecord> {
    const { id } = await this.txHost.tx.whatsAppNumber.create({
      data: { schoolId, phone: data.phone, provider: 'waha', status: 'pending', pairedBy: data.pairedBy },
      select: { id: true },
    });
    const [row] = await this.txHost.tx.whatsAppNumber.updateManyAndReturn({
      where: { schoolId, id },
      data: { wahaSession: wahaSessionName(id) },
      select: SELECT,
    });
    if (!row) throw new Error('whatsapp number vanished after insert');
    return row;
  }

  /** Re-pairing a `pending` or `down` WAHA row (§5.4). Caller holds the lock. */
  async restartPairing(schoolId: SchoolId, id: bigint, pairedBy: bigint): Promise<void> {
    await this.txHost.tx.whatsAppNumber.updateMany({
      where: { schoolId, id, status: { in: ['pending', 'down'] } },
      data: { status: 'pending', pairedBy },
    });
  }

  /** Cloud API connect (§5.5): `connected` at once; the token is already encrypted. */
  async createCloud(
    schoolId: SchoolId,
    data: { phone: string; phoneNumberId: string; accessToken: string; pairedBy: bigint; now: Date },
  ): Promise<WhatsAppNumberRecord> {
    return this.txHost.tx.whatsAppNumber.create({
      data: {
        schoolId,
        phone: data.phone,
        provider: 'cloud_api',
        cloudPhoneNumberId: data.phoneNumberId,
        cloudAccessToken: data.accessToken,
        status: 'connected',
        pairedBy: data.pairedBy,
        pairedAt: data.now,
        lastHealthyAt: data.now,
      },
      select: SELECT,
    });
  }

  /** Cloud API reconnect of a `pending|down` row: the token replaced. Caller holds the lock. */
  async reconnectCloud(
    schoolId: SchoolId,
    id: bigint,
    data: { accessToken: string; pairedBy: bigint; pairedAt: Date | null; now: Date },
  ): Promise<void> {
    await this.txHost.tx.whatsAppNumber.updateMany({
      where: { schoolId, id, status: { in: ['pending', 'down'] } },
      data: {
        cloudAccessToken: data.accessToken,
        status: 'connected',
        pairedBy: data.pairedBy,
        pairedAt: data.pairedAt ?? data.now,
        lastHealthyAt: data.now,
        lastErrorCode: null,
      },
    });
  }

  /** §5.6: terminal for the row. Caller holds the lock. */
  async disable(
    schoolId: SchoolId,
    id: bigint,
    data: { by: bigint; reason: string; now: Date },
  ): Promise<void> {
    await this.txHost.tx.whatsAppNumber.updateMany({
      where: { schoolId, id, status: { not: 'disabled' } },
      data: { status: 'disabled', disabledAt: data.now, disabledBy: data.by, disabledReason: data.reason },
    });
  }

  /**
   * A health-check result (§7.8), applied only while the row is still in `from`: a concurrent
   * disable or re-pair wins. Returns rows changed (0 or 1).
   */
  async recordHealth(
    schoolId: SchoolId,
    id: bigint,
    from: WhatsAppStatus,
    write: HealthWrite,
  ): Promise<number> {
    const { count } = await this.txHost.tx.whatsAppNumber.updateMany({
      where: { schoolId, id, status: from },
      data: {
        status: write.status,
        ...(write.lastHealthyAt === undefined ? {} : { lastHealthyAt: write.lastHealthyAt }),
        ...(write.lastErrorCode === undefined ? {} : { lastErrorCode: write.lastErrorCode }),
        ...(write.pairedAt === undefined ? {} : { pairedAt: write.pairedAt }),
      },
    });
    return count;
  }
}
