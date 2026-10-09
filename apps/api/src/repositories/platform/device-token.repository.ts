import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';

/** The unbranded school a device token's hash names. */
export interface DeviceTokenSchoolRow {
  readonly id: bigint;
  readonly status: SchoolStatus;
}

/**
 * Device-token resolution (Phase 5 rule 40; CLAUDE.md named exception 4, widened by
 * phase-5-extended.md §3.1): a biometric device's punch carries the school's device token and
 * nothing else, so the token's hash is what establishes the tenant, as a session token's does.
 * One read of `schools` by the globally unique `device_token_hash` (partial unique index
 * schools_device_token_hash_key). It returns the row unbranded; the device-punch service
 * (src/modules/staff-attendance/device-punch.service.ts), the only file allowed to import this
 * one (eslint.config.mjs), refuses a terminated school and brands it with schoolIdFromDeviceToken.
 * Rotation writes the hash through OwnSchoolRepository, never here.
 */
@Injectable()
export class DeviceTokenRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findByTokenHash(hash: string): Promise<DeviceTokenSchoolRow | null> {
    return this.txHost.tx.school.findFirst({
      where: { deviceTokenHash: hash },
      select: { id: true, status: true },
    });
  }
}
