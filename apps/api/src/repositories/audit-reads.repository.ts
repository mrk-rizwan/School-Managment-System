import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { userNames } from './name-reads';
import { escapeLike, type PrismaTxAdapter } from './prisma';

// The audit screen's read of audit_log (Phase 5 rule 40, R354; contracts/slice-46.md). Read-only:
// no method writes (the screen's own `audit.viewed` row goes through AuditLogRepository).
// Importable only from src/modules/audit/** (eslint auditReadsRepository).

/**
 * The access-management family (§1.1 "Audit screen"): never listed, never served by id. These
 * rows would say who still signs in with the default password (a CNIC). The real action families
 * in the code: `user.*` (logins issued, resets, password and email changes, the rule-24 refusal
 * `user.default_password_blocked`, `user.login_on_default_password`), `user_role.*`,
 * `custom_role.*`, `capability_grant.*` (the plan's `role.*`, `grant.*` and `default_password.*`).
 */
export const AUDIT_EXCLUDED_ACTION_PREFIXES = ['user.', 'user_role.', 'custom_role.', 'capability_grant.'] as const;

export interface AuditReadFilter {
  actorUserId?: bigint;
  subject?: { type: string; id: bigint };
  /** Half-open instant range [from, to). */
  createdRange?: { from: Date; to: Date };
  /** Prefix of `action` (LIKE 'x%', the varchar_pattern_ops index). */
  actionPrefix?: string;
}

/** A stored metadata value (JSON), as the screen reads it. */
export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditJsonValue[]
  | { readonly [key: string]: AuditJsonValue | undefined };

export interface AuditReadRow {
  id: bigint;
  createdAt: Date;
  action: string;
  subjectType: string;
  subjectId: bigint | null;
  actorUserId: bigint | null;
  actorPlatformUserId: bigint | null;
  /** The acting school user's display name; '' when the user has no staff or guardian record. */
  actorName: string | null;
  reason: string | null;
  metadata: AuditJsonValue;
}

const SELECT = {
  id: true,
  createdAt: true,
  action: true,
  subjectType: true,
  subjectId: true,
  actorUserId: true,
  actorPlatformUserId: true,
  reason: true,
  metadata: true,
} as const;

// Prisma passes a startsWith value into LIKE unescaped, so `_` would match any character
// (`user_role.` would hide `userxrole.*`, `pay_ent` would find `payment.*`): every prefix is escaped.
const notExcluded: Prisma.AuditLogWhereInput = {
  NOT: AUDIT_EXCLUDED_ACTION_PREFIXES.map((prefix) => ({ action: { startsWith: escapeLike(prefix) } })),
};

@Injectable()
export class AuditReadsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** One page, newest first (`-createdAt`, then id), and the filter's total. */
  async page(
    schoolId: SchoolId,
    filter: AuditReadFilter,
    skip: number,
    take: number,
  ): Promise<{ rows: AuditReadRow[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      schoolId,
      AND: [
        notExcluded,
        ...(filter.actorUserId === undefined ? [] : [{ actorUserId: filter.actorUserId }]),
        ...(filter.subject === undefined
          ? []
          : [{ subjectType: filter.subject.type, subjectId: filter.subject.id }]),
        ...(filter.createdRange === undefined
          ? []
          : [{ createdAt: { gte: filter.createdRange.from, lt: filter.createdRange.to } }]),
        ...(filter.actionPrefix === undefined ? [] : [{ action: { startsWith: escapeLike(filter.actionPrefix) } }]),
      ],
    };
    const rows = await this.txHost.tx.auditLog.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    const total = await this.txHost.tx.auditLog.count({ where });
    return { rows: await this.withNames(schoolId, rows), total };
  }

  /** One row of this school outside the excluded family, or null. */
  async find(schoolId: SchoolId, id: bigint): Promise<AuditReadRow | null> {
    const row = await this.txHost.tx.auditLog.findFirst({
      where: { schoolId, id, AND: [notExcluded] },
      select: SELECT,
    });
    return row === null ? null : ((await this.withNames(schoolId, [row]))[0] ?? null);
  }

  private async withNames(
    schoolId: SchoolId,
    rows: readonly Omit<AuditReadRow, 'actorName'>[],
  ): Promise<AuditReadRow[]> {
    const names = await userNames(
      this.txHost.tx,
      schoolId,
      rows.flatMap((r) => (r.actorUserId === null ? [] : [r.actorUserId])),
    );
    return rows.map((r) => ({ ...r, actorName: r.actorUserId === null ? null : (names.get(r.actorUserId) ?? '') }));
  }
}
