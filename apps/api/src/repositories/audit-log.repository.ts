import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';
import type { AuditMetadataValue } from './platform/platform-audit.repository';

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
    await this.txHost.tx.auditLog.create({
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
  }
}
