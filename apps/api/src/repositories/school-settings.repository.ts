import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { readLocked } from '../common/locking';
import type { SchoolId } from '../tenancy/school-id';
import type { LateCountsAs, LeaveCountsAs, MessageType, RemarkVisibility } from '@asms/shared';
import type { PrismaTxAdapter } from './prisma';

export interface SchoolSettingsRecord {
  id: bigint;
  feeDueDay: number;
  studentLoginEnabled: boolean;
  // Phase 2 (contracts/slice-9.md §4). Times are TIME columns, read as 1970-01-01 UTC instants.
  periodsPerDay: number;
  weeklyOffDays: number[];
  attendanceAmendWindowDays: number;
  registerDeadlineTime: Date;
  absenceAlertTime: Date;
  lateAdviceEnabled: boolean;
  lateCountsAs: LateCountsAs;
  lateCutoffTime: Date | null;
  leaveCountsAs: LeaveCountsAs;
  smsAllowedTypes: MessageType[];
  remarkDefaultVisibility: RemarkVisibility;
  remarkNotifyGuardians: boolean;
  updatedAt: Date;
}

/** The writable attributes (contract slice-2 §6, slice-9 §4). */
export type SchoolSettingsChanges = Partial<
  Omit<SchoolSettingsRecord, 'id' | 'updatedAt'>
>;

const SELECT = {
  id: true,
  feeDueDay: true,
  studentLoginEnabled: true,
  periodsPerDay: true,
  weeklyOffDays: true,
  attendanceAmendWindowDays: true,
  registerDeadlineTime: true,
  absenceAlertTime: true,
  lateAdviceEnabled: true,
  lateCountsAs: true,
  lateCutoffTime: true,
  leaveCountsAs: true,
  smsAllowedTypes: true,
  remarkDefaultVisibility: true,
  remarkNotifyGuardians: true,
  updatedAt: true,
} as const;

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

  /** `weekly_off_days`, ascending (0 = Sunday); Sunday alone when the school has no row. */
  async weeklyOffDays(schoolId: SchoolId): Promise<number[]> {
    const row = await this.txHost.tx.schoolSettings.findFirst({
      where: { schoolId },
      select: { weeklyOffDays: true },
    });
    return [...(row?.weeklyOffDays ?? [0])].sort((a, b) => a - b);
  }

  /** `student_login_enabled` (students sign in only while it is on); false when the school has no row. */
  async studentLoginEnabled(schoolId: SchoolId): Promise<boolean> {
    const row = await this.txHost.tx.schoolSettings.findFirst({
      where: { schoolId },
      select: { studentLoginEnabled: true },
    });
    return row?.studentLoginEnabled ?? false;
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

  /** Plain attributes (contract slice-2 §6, slice-9 §4). */
  async update(schoolId: SchoolId, data: SchoolSettingsChanges): Promise<SchoolSettingsRecord> {
    await this.txHost.tx.schoolSettings.updateMany({ where: { schoolId }, data });
    const row = await this.find(schoolId);
    if (!row) throw new Error('school_settings row missing');
    return row;
  }
}
