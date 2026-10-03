import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { DevicePlatform, DeviceUnregisteredReason } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-9.md §1.5, §3.2, §3.4, §3.5. The tenant table devices: one push address per
// bearer session (UNIQUE (school_id, session_id)). A device row is a push address, not history:
// it is ended (unregistered_at) by logout, FCM `unregistered` and replacement, and it dies with
// its session through the join in liveForUsers — no session-revocation path writes it. The daily
// session purge deletes a purged session's device rows (the only delete; decision 25).
// Lock order: sessions -> devices (§1.7).

/** A device row as the API sees it. The push token is read only for push resolution (R173). */
export interface DeviceRecord {
  id: bigint;
  userId: bigint;
  sessionId: bigint;
  platform: DevicePlatform;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  unregisteredAt: Date | null;
}

/** What push resolution needs: the address and whose it is. */
export interface LiveDevice {
  id: bigint;
  userId: bigint;
  platform: DevicePlatform;
  pushToken: string;
}

const SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  platform: true,
  appVersion: true,
  createdAt: true,
  lastSeenAt: true,
  unregisteredAt: true,
} as const;

export const DEVICE_SESSION_UNIQUE = 'devices_school_id_session_id_key';

@Injectable()
export class DeviceRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findForSession(schoolId: SchoolId, sessionId: bigint): Promise<DeviceRecord | null> {
    return this.txHost.tx.device.findFirst({ where: { schoolId, sessionId }, select: SELECT });
  }

  /**
   * Locks this session's device row for the rest of the transaction and returns it with its push
   * token, or null when the session has none (contract §3.5). A no-op UPDATE takes the row lock.
   */
  async lockForSession(
    schoolId: SchoolId,
    sessionId: bigint,
  ): Promise<(DeviceRecord & { pushToken: string }) | null> {
    const { count } = await this.txHost.tx.device.updateMany({
      where: { schoolId, sessionId },
      data: { updatedAt: new Date() },
    });
    if (count === 0) return null;
    return this.txHost.tx.device.findFirst({
      where: { schoolId, sessionId },
      select: { ...SELECT, pushToken: true },
    });
  }

  create(
    schoolId: SchoolId,
    data: {
      userId: bigint;
      sessionId: bigint;
      platform: DevicePlatform;
      pushToken: string;
      appVersion: string;
      now: Date;
    },
  ): Promise<DeviceRecord> {
    return this.txHost.tx.device.create({
      data: {
        schoolId,
        userId: data.userId,
        sessionId: data.sessionId,
        platform: data.platform,
        pushToken: data.pushToken,
        appVersion: data.appVersion,
        createdAt: data.now,
        lastSeenAt: data.now,
      },
      select: SELECT,
    });
  }

  /** Refresh or re-register: the token, version and platform, live again. Caller holds the lock. */
  async refresh(
    schoolId: SchoolId,
    id: bigint,
    data: { platform: DevicePlatform; pushToken: string; appVersion: string; now: Date },
  ): Promise<DeviceRecord> {
    await this.txHost.tx.device.updateMany({
      where: { schoolId, id },
      data: {
        platform: data.platform,
        pushToken: data.pushToken,
        appVersion: data.appVersion,
        lastSeenAt: data.now,
        unregisteredAt: null,
        unregisteredReason: null,
      },
    });
    const row = await this.txHost.tx.device.findFirst({ where: { schoolId, id }, select: SELECT });
    if (!row) throw new Error('device row vanished under its lock');
    return row;
  }

  /**
   * R159: every other live device row in the school holding this push token is ended as
   * `replaced` (two parents on one phone: the latest sign-in owns the token).
   */
  async replaceOthersWithToken(
    schoolId: SchoolId,
    pushToken: string,
    exceptSessionId: bigint,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.device.updateMany({
      where: {
        schoolId,
        pushToken,
        unregisteredAt: null,
        sessionId: { not: exceptSessionId },
      },
      data: { unregisteredAt: now, unregisteredReason: 'replaced' },
    });
    return count;
  }

  /** Ends this session's live device row, if any (logout: `sign_out`; FCM: `fcm_unregistered`). */
  async unregisterForSession(
    schoolId: SchoolId,
    sessionId: bigint,
    reason: DeviceUnregisteredReason,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.device.updateMany({
      where: { schoolId, sessionId, unregisteredAt: null },
      data: { unregisteredAt: now, unregisteredReason: reason },
    });
    return count;
  }

  /** FCM `unregistered` (contract §7.6): every live device row of the user is ended. */
  async unregisterForUser(
    schoolId: SchoolId,
    userId: bigint,
    reason: DeviceUnregisteredReason,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.device.updateMany({
      where: { schoolId, userId, unregisteredAt: null },
      data: { unregisteredAt: now, unregisteredReason: reason },
    });
    return count;
  }

  /**
   * Password change (contract §3.4): the presented session's device row, live or not, moves to
   * the rotated session so push continues without a re-registration.
   */
  async moveToSession(
    schoolId: SchoolId,
    fromSessionId: bigint,
    toSessionId: bigint,
  ): Promise<void> {
    await this.txHost.tx.device.updateMany({
      where: { schoolId, sessionId: fromSessionId },
      data: { sessionId: toSessionId },
    });
  }

  /** The session purge (§1.5): every device row of these sessions, live or ended. */
  async deleteForSessions(schoolId: SchoolId, sessionIds: readonly bigint[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const { count } = await this.txHost.tx.device.deleteMany({
      where: { schoolId, sessionId: { in: [...sessionIds] } },
    });
    return count;
  }

  /**
   * Push resolution (contract §1.5, R115): the live devices of these users whose session is live
   * — not revoked, before its absolute expiry, and seen within its idle window. `idleMs` is
   * `sessionLifetime('bearer', capacities).idleMs` (common/auth/school-session.ts) for the user's
   * current capacities; devices exist only on bearer sessions. Every revocation path therefore
   * stops push without writing a device row.
   */
  async liveForUsers(
    schoolId: SchoolId,
    userIds: readonly bigint[],
    idleMs: number,
    now: Date,
  ): Promise<LiveDevice[]> {
    if (userIds.length === 0) return [];
    return this.txHost.tx.device.findMany({
      where: {
        schoolId,
        userId: { in: [...userIds] },
        unregisteredAt: null,
        session: {
          schoolId,
          revokedAt: null,
          expiresAt: { gt: now },
          lastSeenAt: { gt: new Date(now.getTime() - idleMs) },
        },
      },
      select: { id: true, userId: true, platform: true, pushToken: true },
      orderBy: { id: 'asc' },
    });
  }
}
