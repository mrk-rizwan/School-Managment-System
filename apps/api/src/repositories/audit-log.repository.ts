import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';
import type { AuditMetadataValue } from './audit-metadata';

export interface AuditEntry {
  /** The school user acting. Null only when a platform admin acts (actorPlatformUserId set). */
  actorUserId: bigint | null;
  /** Set only for the platform's operations inside a school (CLAUDE.md exception 1). */
  actorPlatformUserId?: bigint;
  /** e.g. `user.password_reset`; each slice's contract lists its actions. */
  action: string;
  subjectType: string;
  subjectId: bigint | null;
  reason?: string;
  /** No identity numbers and no epoch milliseconds (both refused by CHECK). */
  metadata?: Record<string, AuditMetadataValue>;
}

/**
 * Appends to the school's audit_log (append-only by trigger). Written explicitly by the service
 * that makes the change, through the ambient transaction, so the row commits or rolls back with
 * that change (plan §3.7).
 */
@Injectable()
export class AuditLogRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async record(schoolId: SchoolId, entry: AuditEntry): Promise<void> {
    await this.recordReturningId(schoolId, entry);
  }

  /**
   * A job's row (phase-3-financial.md A19): no actor, the job named in `metadata.job`
   * (audit_log_actor_check admits an actorless row only then). Written in the job's transaction,
   * so it commits or rolls back with the work it records.
   */
  async recordSystem(
    schoolId: SchoolId,
    entry: {
      action: string;
      subjectType: string;
      subjectId: bigint | null;
      metadata: { job: string } & Record<string, AuditMetadataValue>;
    },
  ): Promise<void> {
    await this.txHost.tx.auditLog.create({
      select: { id: true },
      data: {
        schoolId,
        actorUserId: null,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        metadata: entry.metadata,
      },
    });
  }

  /** Whether the user has an `action` row at or after `since` (R225's once-per-day refusal row). */
  async existsForActorSince(
    schoolId: SchoolId,
    actorUserId: bigint,
    action: string,
    since: Date,
  ): Promise<boolean> {
    const row = await this.txHost.tx.auditLog.findFirst({
      where: { schoolId, actorUserId, action, createdAt: { gte: since } },
      select: { id: true },
    });
    return row !== null;
  }

  /** Several school-user rows in one statement (a batch that records one row per subject). */
  async recordMany(schoolId: SchoolId, entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.txHost.tx.auditLog.createMany({
      data: entries.map((entry) => ({
        schoolId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        metadata: entry.metadata ?? {},
      })),
    });
  }

  /** As record, returning the new row's id (a messaging test's subject id, slice-9 §5.1). */
  async recordReturningId(schoolId: SchoolId, entry: AuditEntry): Promise<bigint> {
    const { id } = await this.txHost.tx.auditLog.create({
      select: { id: true },
      data: {
        schoolId,
        actorUserId: entry.actorUserId,
        ...(entry.actorPlatformUserId === undefined
          ? {}
          : { actorPlatformUserId: entry.actorPlatformUserId }),
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        metadata: entry.metadata ?? {},
      },
    });
    return id;
  }
}
