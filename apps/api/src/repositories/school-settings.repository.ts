import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../common/errors/api-exception';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface SchoolSettingsRecord {
  id: bigint;
  feeDueDay: number;
  studentLoginEnabled: boolean;
  updatedAt: Date;
}

/** Reads before giving up when the row keeps changing between the read and the lock. */
const LOCK_ATTEMPTS = 3;

const SELECT = { id: true, feeDueDay: true, studentLoginEnabled: true, updatedAt: true } as const;

/** The school's one settings row (tenant table school_settings). */
@Injectable()
export class SchoolSettingsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Written once, in the transaction that creates the school. Student login starts off. */
  create(schoolId: SchoolId, data: { feeDueDay: number }): Promise<SchoolSettingsRecord> {
    return this.txHost.tx.schoolSettings.create({
      data: { schoolId, feeDueDay: data.feeDueDay, studentLoginEnabled: false },
      select: SELECT,
    });
  }

  find(schoolId: SchoolId): Promise<SchoolSettingsRecord | null> {
    return this.txHost.tx.schoolSettings.findFirst({ where: { schoolId }, select: SELECT });
  }

  /**
   * Locks the school's settings row for the rest of the transaction (plan §3.3, R73): every
   * operation that could remove the last principal takes it, so they serialise. The lock is a
   * compare-and-set UPDATE that rewrites updated_at with the value just read, so it changes
   * nothing visible; if another transaction changed the row in between, it matches nothing and
   * the row is read again (an unconditional rewrite would put the older updated_at back).
   * Returns the row as read under the lock; null if the school has none.
   */
  async lock(schoolId: SchoolId): Promise<SchoolSettingsRecord | null> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const current = await this.find(schoolId);
      if (!current) return null;
      const { count } = await this.txHost.tx.schoolSettings.updateMany({
        where: { schoolId, updatedAt: current.updatedAt },
        data: { updatedAt: current.updatedAt },
      });
      if (count === 1) return current;
    }
    throw new ApiException(
      409,
      ErrorCode.CONCURRENT_UPDATE,
      'The record changed while this request ran. Reload and try again.',
    );
  }

  /** Plain attributes (contract slice-2 §6). */
  async update(
    schoolId: SchoolId,
    data: { feeDueDay?: number; studentLoginEnabled?: boolean },
  ): Promise<SchoolSettingsRecord> {
    await this.txHost.tx.schoolSettings.updateMany({ where: { schoolId }, data });
    const row = await this.find(schoolId);
    if (!row) throw new Error('school_settings row missing');
    return row;
  }
}
