import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AuditMetadataValue } from '../audit-metadata';
import type { PrismaTxAdapter } from '../prisma';

export interface PlatformAuditEntry {
  /** Null only for the seed and login_failure_spike rows (CHECK platform_audit_log_actor_check). */
  actorPlatformUserId: bigint | null;
  schoolId: bigint | null;
  /** e.g. `school.created`; the list is contracts/slice-1.md §6. */
  action: string;
  subjectType: string;
  subjectId: bigint | null;
  reason?: string;
  metadata?: Record<string, AuditMetadataValue>;
}

/**
 * Appends to platform_audit_log (append-only, enforced by trigger). Writes through the ambient
 * transaction, so the row commits or rolls back with the change it records.
 */
@Injectable()
export class PlatformAuditRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async record(entry: PlatformAuditEntry): Promise<void> {
    await this.txHost.tx.platformAuditLog.create({
      data: {
        actorPlatformUserId: entry.actorPlatformUserId,
        schoolId: entry.schoolId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        metadata: entry.metadata ?? {},
      },
    });
  }

  /**
   * R220 (phase-3-financial.md §1.1): whether the school left trial at or after `since`. Nothing
   * returns to trial (contracts/slice-1.md §4.5), so its one `school.status_changed` row from
   * `trial` is when it became billable; a school turning active mid-month is free until the next
   * 1st. A school created active (never in trial) has no such row and is billable.
   */
  async leftTrialSince(schoolId: bigint, since: Date): Promise<boolean> {
    const row = await this.txHost.tx.platformAuditLog.findFirst({
      where: {
        schoolId,
        action: 'school.status_changed',
        metadata: { path: ['from'], equals: 'trial' },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    return row !== null;
  }
}
