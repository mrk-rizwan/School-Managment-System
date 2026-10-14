import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus, SmsProviderChoice, WhatsAppProviderChoice } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface OwnSchoolRecord {
  id: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
  /** Set by the platform (owner's item 18); read-only to the school (contracts/slice-9.md §4). */
  smsMonthlyCap: number;
  /** Set by the platform (contracts/slice-9.md §6.1); `platform_default` defers to platform_settings. */
  whatsappProvider: WhatsAppProviderChoice;
  smsProvider: SmsProviderChoice;
  /**
   * Phase 5 rule 40: when the biometric device token was last rotated, null while the school has
   * none (SchoolSettingsDto.deviceTokenRotatedAt). The token's hash is never read here.
   */
  deviceTokenRotatedAt: Date | null;
}

const SELECT = {
  id: true,
  name: true,
  shortCode: true,
  status: true,
  timezone: true,
  smsMonthlyCap: true,
  whatsappProvider: true,
  smsProvider: true,
  deviceTokenRotatedAt: true,
} as const;

/**
 * The school's own row, for tenant code (plan §3.2). Its only predicate is `id = schoolId`, so a
 * school can read nothing but itself.
 */
@Injectable()
export class OwnSchoolRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  find(schoolId: SchoolId): Promise<OwnSchoolRecord | null> {
    return this.txHost.tx.school.findFirst({ where: { id: schoolId }, select: SELECT });
  }

  /**
   * Rotation (contracts/slice-44.md §2.1, phase-5-extended.md §3.1): the new token's sha-256 and
   * the time in one write; the old hash is gone at commit, so the old token resolves nothing.
   */
  async setDeviceToken(schoolId: SchoolId, hash: string, rotatedAt: Date): Promise<void> {
    await this.txHost.tx.school.update({
      where: { id: schoolId },
      data: { deviceTokenHash: hash, deviceTokenRotatedAt: rotatedAt },
      select: { id: true },
    });
  }

  /**
   * Turning the device off (contracts/slice-44.md §2.1): the hash and its time go; at commit the
   * token resolves nothing (the same 401 as any unknown token). False when no token was set.
   */
  async clearDeviceToken(schoolId: SchoolId): Promise<boolean> {
    const { count } = await this.txHost.tx.school.updateMany({
      where: { id: schoolId, deviceTokenHash: { not: null } },
      data: { deviceTokenHash: null, deviceTokenRotatedAt: null },
    });
    return count === 1;
  }
}
