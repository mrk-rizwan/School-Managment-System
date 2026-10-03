import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { readLocked } from '../common/locking';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface SchoolSettingsRecord {
  id: bigint;
  feeDueDay: number;
  studentLoginEnabled: boolean;
  updatedAt: Date;
}

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
    // Wrapped so an absent row comes back as null instead of readLocked's 404.
    const { row } = await readLocked(
      async () => ({ row: await this.find(schoolId) }),
      ({ row }) => (row === null ? Promise.resolve(true) : this.lockIfUnchanged(schoolId, row)),
    );
    return row;
  }

  private async lockIfUnchanged(schoolId: SchoolId, row: SchoolSettingsRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.schoolSettings.updateMany({
      where: { schoolId, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
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
