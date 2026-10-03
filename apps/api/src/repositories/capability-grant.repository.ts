import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { GrantEffect } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

/** One user_capability_grants row (contracts/slice-7.md §2 GrantDto), names from staff. */
export interface GrantRecord {
  id: bigint;
  userId: bigint;
  capabilityKey: string;
  effect: GrantEffect;
  reason: string;
  grantedBy: bigint;
  grantedByName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: bigint | null;
  revokedByName: string | null;
  endReason: string | null;
}

/** end_reason of the rows ended when their user becomes a principal (named in a CHECK). */
export const BECAME_PRINCIPAL = 'became principal';

const NAME = { select: { staff: { select: { fullName: true } } } } as const;

const SELECT = {
  id: true,
  userId: true,
  capabilityKey: true,
  effect: true,
  reason: true,
  grantedBy: true,
  createdAt: true,
  revokedAt: true,
  revokedBy: true,
  endReason: true,
  grantedByUser: NAME,
  revokedByUser: NAME,
} as const satisfies Prisma.UserCapabilityGrantSelect;

type Row = Prisma.UserCapabilityGrantGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ grantedByUser, revokedByUser, ...row }: Row): GrantRecord => ({
  ...row,
  grantedByName: grantedByUser.staff?.fullName ?? null,
  revokedByName: revokedByUser?.staff?.fullName ?? null,
});

/**
 * user_capability_grants (tenant). Append-only except ending (trigger
 * user_capability_grants_end_only): a row ends by revoked_at, never by delete (R50). Every write
 * runs under the holder's user row lock (contracts/slice-7.md §1).
 */
@Injectable()
export class CapabilityGrantRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async findById(schoolId: SchoolId, id: bigint): Promise<GrantRecord | null> {
    const row = await this.txHost.tx.userCapabilityGrant.findFirst({
      where: { schoolId, id },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  /** The live row of (user, key, effect): at most one, by user_capability_grants_live_key. */
  async findLive(
    schoolId: SchoolId,
    userId: bigint,
    capabilityKey: string,
    effect: GrantEffect,
  ): Promise<GrantRecord | null> {
    const row = await this.txHost.tx.userCapabilityGrant.findFirst({
      where: { schoolId, userId, capabilityKey, effect, revokedAt: null },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  /** The user's rows, newest first; live rows only unless includeEnded. */
  async listForUser(
    schoolId: SchoolId,
    userId: bigint,
    includeEnded: boolean,
  ): Promise<GrantRecord[]> {
    const rows = await this.txHost.tx.userCapabilityGrant.findMany({
      where: { schoolId, userId, ...(includeEnded ? {} : { revokedAt: null }) },
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toRecord);
  }

  /** The user's live rows, for effective permissions (R69: read on every request). */
  activeForUser(
    schoolId: SchoolId,
    userId: bigint,
  ): Promise<{ id: bigint; capabilityKey: string; effect: GrantEffect }[]> {
    return this.txHost.tx.userCapabilityGrant.findMany({
      where: { schoolId, userId, revokedAt: null },
      select: { id: true, capabilityKey: true, effect: true },
      orderBy: { id: 'asc' },
    });
  }

  async create(
    schoolId: SchoolId,
    data: {
      userId: bigint;
      capabilityKey: string;
      effect: GrantEffect;
      grantedBy: bigint;
      reason: string;
      now: Date;
    },
  ): Promise<bigint> {
    const row = await this.txHost.tx.userCapabilityGrant.create({
      data: {
        schoolId,
        userId: data.userId,
        capabilityKey: data.capabilityKey,
        effect: data.effect,
        grantedBy: data.grantedBy,
        reason: data.reason,
        createdAt: data.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Ends one live row. Returns rows changed (0 when it had already ended: a no-op, R50). */
  async end(
    schoolId: SchoolId,
    id: bigint,
    data: { revokedBy: bigint; endReason: string; now: Date },
  ): Promise<number> {
    const { count } = await this.txHost.tx.userCapabilityGrant.updateMany({
      where: { schoolId, id, revokedAt: null },
      data: { revokedAt: data.now, revokedBy: data.revokedBy, endReason: data.endReason },
    });
    return count;
  }

  /** Ends every live row of the user, grants and revokes (staff left, R17). Returns how many. */
  async endAllForUser(
    schoolId: SchoolId,
    userId: bigint,
    data: { revokedBy: bigint; endReason: string; now: Date },
  ): Promise<number> {
    const { count } = await this.txHost.tx.userCapabilityGrant.updateMany({
      where: { schoolId, userId, revokedAt: null },
      data: { revokedAt: data.now, revokedBy: data.revokedBy, endReason: data.endReason },
    });
    return count;
  }

  /**
   * Ends every live row of a user who has just become a principal (principals are unrestricted
   * peers, contracts/slice-7.md §4.4). `revokedBy` is null only for the platform's
   * issue-principal-login, which has no school-user actor (CHECK user_capability_grants_revoked_check
   * allows that for this end reason alone). Returns how many.
   */
  async endAllForNewPrincipal(
    schoolId: SchoolId,
    userId: bigint,
    data: { revokedBy: bigint | null; now: Date },
  ): Promise<number> {
    const { count } = await this.txHost.tx.userCapabilityGrant.updateMany({
      where: { schoolId, userId, revokedAt: null },
      data: { revokedAt: data.now, revokedBy: data.revokedBy, endReason: BECAME_PRINCIPAL },
    });
    return count;
  }
}
