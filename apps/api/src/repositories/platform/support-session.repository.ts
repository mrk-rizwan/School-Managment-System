import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SupportSessionEnd } from '@asms/shared';
import type { SchoolId } from '../../tenancy/school-id';
import {
  expiredSupportSessionRecord,
  supportSessionRecord,
  type ExpiredSupportSessionRecord,
  type SupportSessionRecord,
} from '../../tenancy/school-id.mint';
import type { AuditMetadataValue } from '../audit-metadata';
import type { Prisma, SchoolStatus } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';
import { activePrincipalStaffIds } from '../name-reads';

// Exception 7 (phase-5-extended.md §3.1, contracts/slice-45.md): the platform_support_sessions rows
// (non-tenant, like platform_audit_log) and the support module's two writes into a school: the
// school's audit_log row beside every platform_audit_log row, and the active principals a notice
// goes to. Importable only from src/modules/platform/support/** (eslint.config.mjs, R353).
//
// The database holds the rules (migration 20261016120000): one open session per school, at most
// three open per platform user (counting every row with closed_at null, so the service expires
// stale rows before it opens), a session born open, the end columns set once. Every write here is
// conditional on closed_at IS NULL, so a lost race changes nothing and the caller reads the winner.

export interface SupportSessionRow {
  id: bigint;
  platformUserId: bigint;
  schoolId: bigint;
  reason: string;
  ticketRef: string;
  openedAt: Date;
  expiresAt: Date;
  closedAt: Date | null;
  endKind: SupportSessionEnd | null;
  closeReason: string | null;
  revokedAt: Date | null;
  revokedBy: bigint | null;
  revokeReason: string | null;
}

/**
 * A row this repository branded open and the caller's own: the only input
 * schoolIdFromSupportSession takes.
 */
export type BrandedSupportSession = SupportSessionRow & SupportSessionRecord;

/**
 * A row expireDue has just closed as expired: the only input schoolIdFromExpiredSupportSession
 * takes (the expiry's audit rows and notice). Never a BrandedSupportSession.
 */
export type ExpiredSupportSession = SupportSessionRow & ExpiredSupportSessionRecord;

/** A row with the platform user's email and the school's name, for the DTOs. */
export interface SupportSessionView extends SupportSessionRow {
  platformUserEmail: string;
  schoolName: string;
}

export interface SupportSchoolRow {
  id: bigint;
  name: string;
  status: SchoolStatus;
}

export interface SupportSessionListFilter {
  schoolId?: bigint;
  status?: 'open' | 'ended';
}

/** One audit entry written to both logs (contracts/slice-45.md §2). */
export interface SupportAuditEntry {
  /** The platform user acting, or (revoke, expiry) whose session it is. */
  platformUserId: bigint;
  /** The school user acting (a revoke); the school row then names that user, not the platform. */
  actorUserId?: bigint;
  action: string;
  sessionId: bigint;
  reason?: string;
  metadata: Record<string, AuditMetadataValue>;
}

const SELECT = {
  id: true,
  platformUserId: true,
  schoolId: true,
  reason: true,
  ticketRef: true,
  openedAt: true,
  expiresAt: true,
  closedAt: true,
  endKind: true,
  closeReason: true,
  revokedAt: true,
  revokedBy: true,
  revokeReason: true,
} as const;

/** Open and unexpired at `now`. */
const openAt = (now: Date) => ({ closedAt: null, expiresAt: { gt: now } });

const statusWhere = (
  status: 'open' | 'ended' | undefined,
  now: Date,
): Prisma.PlatformSupportSessionWhereInput => {
  if (status === 'open') return openAt(now);
  if (status === 'ended') return { OR: [{ closedAt: { not: null } }, { expiresAt: { lte: now } }] };
  return {};
};

const ORDER = [{ openedAt: 'desc' }, { id: 'desc' }] as const;

@Injectable()
export class SupportSessionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ------------------------------------------------------------------ platform side

  /** The school a session is asked for, by the route's id (404 / SCHOOL_TERMINATED in the service). */
  findSchool(id: bigint): Promise<SupportSchoolRow | null> {
    return this.txHost.tx.school.findFirst({ where: { id }, select: { id: true, name: true, status: true } });
  }

  /** platform_settings.support_session_hours (1-24, default 4). */
  async sessionHours(): Promise<number> {
    const row = await this.txHost.tx.platformSettings.findFirst({
      where: { id: 1n },
      select: { supportSessionHours: true },
    });
    return row?.supportSessionHours ?? 4;
  }

  /** The school's open, unexpired session, any owner (SUPPORT_SESSION_OPEN's details). */
  findOpenForSchoolRow(schoolId: bigint, now: Date): Promise<{ id: bigint } | null> {
    return this.txHost.tx.platformSupportSession.findFirst({
      where: { schoolId, ...openAt(now) },
      select: { id: true },
    });
  }

  /** How many sessions the platform user has open (the three-open cap, R349). */
  countOpenOwned(platformUserId: bigint, now: Date): Promise<number> {
    return this.txHost.tx.platformSupportSession.count({ where: { platformUserId, ...openAt(now) } });
  }

  /** Inserts an open session; the row is the caller's own and open, so it is branded. */
  async insertOpen(data: {
    platformUserId: bigint;
    schoolId: bigint;
    reason: string;
    ticketRef: string;
    openedAt: Date;
    expiresAt: Date;
  }): Promise<BrandedSupportSession> {
    const row = await this.txHost.tx.platformSupportSession.create({ data, select: SELECT });
    return supportSessionRecord(row);
  }

  /** The session if it is open, unexpired and the caller's own: the support reads' predicate. */
  async findOpenOwned(
    id: bigint,
    platformUserId: bigint,
    now: Date,
  ): Promise<BrandedSupportSession | null> {
    const row = await this.txHost.tx.platformSupportSession.findFirst({
      where: { id, platformUserId, ...openAt(now) },
      select: SELECT,
    });
    return row === null ? null : supportSessionRecord(row);
  }

  /** Every open, unexpired session of the caller (logout closes them). */
  async findOpenOwnedAll(
    platformUserId: bigint,
    now: Date,
  ): Promise<BrandedSupportSession[]> {
    const rows = await this.txHost.tx.platformSupportSession.findMany({
      where: { platformUserId, ...openAt(now) },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => supportSessionRecord(row));
  }

  /** Any session by id, unbranded (the guard's 404/403 and the platform's GET). */
  find(id: bigint): Promise<SupportSessionRow | null> {
    return this.txHost.tx.platformSupportSession.findFirst({ where: { id }, select: SELECT });
  }

  /** One page of every admin's sessions, newest first, and the filter's total. */
  async list(
    filter: SupportSessionListFilter,
    now: Date,
    skip: number,
    take: number,
  ): Promise<{ rows: SupportSessionView[]; total: number }> {
    const where: Prisma.PlatformSupportSessionWhereInput = {
      ...(filter.schoolId === undefined ? {} : { schoolId: filter.schoolId }),
      ...statusWhere(filter.status, now),
    };
    const rows = await this.txHost.tx.platformSupportSession.findMany({
      where,
      select: SELECT,
      orderBy: [...ORDER],
      skip,
      take,
    });
    const total = await this.txHost.tx.platformSupportSession.count({ where });
    return { rows: await this.withNames(rows), total };
  }

  /** The email and school name of each row (non-tenant reads; no relation includes, R76). */
  async withNames(rows: readonly SupportSessionRow[]): Promise<SupportSessionView[]> {
    if (rows.length === 0) return [];
    const users = await this.txHost.tx.platformUser.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.platformUserId))] } },
      select: { id: true, email: true },
    });
    const schools = await this.txHost.tx.school.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.schoolId))] } },
      select: { id: true, name: true },
    });
    const email = new Map(users.map((u) => [u.id, u.email]));
    const name = new Map(schools.map((s) => [s.id, s.name]));
    return rows.map((row) => ({
      ...row,
      platformUserEmail: email.get(row.platformUserId) ?? '',
      schoolName: name.get(row.schoolId) ?? '',
    }));
  }

  /** The owner's close; false when the row was no longer open (a lost race). */
  async close(id: bigint, platformUserId: bigint, now: Date, reason: string | null): Promise<boolean> {
    const { count } = await this.txHost.tx.platformSupportSession.updateMany({
      where: { id, platformUserId, closedAt: null },
      data: { closedAt: now, endKind: 'closed', closeReason: reason },
    });
    return count === 1;
  }

  /**
   * Closes as `expired` every open row past its expiry at `now` that `scope` names: one school's
   * (the job, with the fan-out's SchoolId), or the caller's and the target school's (the open flow,
   * before the database counts open rows). Each row is closed by its own conditional update,
   * stamped with the actual time of the write; the update's filter is the earlier of that time and
   * `now`, so closed_at >= expires_at always holds. Only a row this call closed is returned, under
   * the expired brand: the expiry's audit rows and notice need its school, and no support read may
   * take it.
   */
  async expireDue(
    scope: { schoolId: bigint } | { platformUserId: bigint; schoolId: bigint },
    now: Date,
  ): Promise<ExpiredSupportSession[]> {
    const owner =
      'platformUserId' in scope
        ? { OR: [{ schoolId: scope.schoolId }, { platformUserId: scope.platformUserId }] }
        : { schoolId: scope.schoolId };
    const due = await this.txHost.tx.platformSupportSession.findMany({
      where: { ...owner, closedAt: null, expiresAt: { lte: now } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    const expired: ExpiredSupportSession[] = [];
    for (const row of due) {
      const closedAt = new Date();
      const { count } = await this.txHost.tx.platformSupportSession.updateMany({
        where: { id: row.id, closedAt: null, expiresAt: { lte: closedAt < now ? closedAt : now } },
        data: { closedAt, endKind: 'expired' },
      });
      if (count === 1) expired.push(expiredSupportSessionRecord({ ...row, closedAt, endKind: 'expired' }));
    }
    return expired;
  }

  // ------------------------------------------------------------------ school side (every predicate
  // carries the school's own SchoolId, like OwnInvoicesRepository)

  async listForSchool(
    schoolId: SchoolId,
    skip: number,
    take: number,
  ): Promise<{ rows: SupportSessionView[]; total: number }> {
    const rows = await this.txHost.tx.platformSupportSession.findMany({
      where: { schoolId },
      select: SELECT,
      orderBy: [...ORDER],
      skip,
      take,
    });
    const total = await this.txHost.tx.platformSupportSession.count({ where: { schoolId } });
    return { rows: await this.withNames(rows), total };
  }

  findForSchool(schoolId: SchoolId, id: bigint): Promise<SupportSessionRow | null> {
    return this.txHost.tx.platformSupportSession.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** The school's open, unexpired session (MeDto.supportSession). */
  openForSchool(schoolId: SchoolId, now: Date): Promise<SupportSessionRow | null> {
    return this.txHost.tx.platformSupportSession.findFirst({
      where: { schoolId, ...openAt(now) },
      select: SELECT,
    });
  }

  /** The school's revoke; false when the row was no longer open. The trigger checks the revoker. */
  async revoke(schoolId: SchoolId, id: bigint, userId: bigint, reason: string, now: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.platformSupportSession.updateMany({
      where: { schoolId, id, closedAt: null },
      data: { closedAt: now, endKind: 'revoked', revokedAt: now, revokedBy: userId, revokeReason: reason },
    });
    return count === 1;
  }

  // ------------------------------------------------------------------ the two writes into a school

  /**
   * The school's active principals' staff ids, the recipients of the two support notices: the
   * shared predicate `activePrincipalStaffIds` (name-reads.ts) that MessageRecipientRepository also
   * calls; the support module may not import that repository
   * (contracts/slice-45.md §4).
   */
  async principalStaffIds(schoolId: SchoolId): Promise<bigint[]> {
    return activePrincipalStaffIds(this.txHost.tx, schoolId);
  }

  /**
   * One entry in platform_audit_log and in the school's audit_log, in the ambient transaction
   * (rule 35: open, close, revoke, expiry and every support read are in both logs). The school row
   * names the school user when one acted (a revoke), else the platform user; the platform row
   * always names a platform user (platform_audit_log_actor_check).
   */
  async recordBoth(schoolId: SchoolId, entry: SupportAuditEntry): Promise<void> {
    const reason = entry.reason === undefined ? {} : { reason: entry.reason };
    await this.txHost.tx.platformAuditLog.create({
      data: {
        actorPlatformUserId: entry.platformUserId,
        schoolId,
        action: entry.action,
        subjectType: 'support_session',
        subjectId: entry.sessionId,
        ...reason,
        metadata:
          entry.actorUserId === undefined
            ? entry.metadata
            : { ...entry.metadata, by: 'school', revokedByUserId: entry.actorUserId.toString() },
      },
      select: { id: true },
    });
    await this.txHost.tx.auditLog.create({
      data: {
        schoolId,
        ...(entry.actorUserId === undefined
          ? { actorUserId: null, actorPlatformUserId: entry.platformUserId }
          : { actorUserId: entry.actorUserId }),
        action: entry.action,
        subjectType: 'support_session',
        subjectId: entry.sessionId,
        ...reason,
        metadata: entry.metadata,
      },
      select: { id: true },
    });
  }
}
