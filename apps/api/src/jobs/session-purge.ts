import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { DeviceRepository } from '../repositories/device.repository';
import { SessionRepository } from '../repositories/session.repository';
import type { SchoolId } from '../tenancy/school-id';

/** Sessions ended (revoked or expired) longer ago than this are deleted (contracts/slice-9.md §1.5). */
export const SESSION_PURGE_AFTER_MS = 90 * 24 * 60 * 60_000;
/** Sessions per transaction. */
const BATCH = 500;

/**
 * The per-school body of the daily `session-purge` job (contracts/slice-9.md §1.5, §7.12;
 * decision 25): sessions revoked or expired more than 90 days ago are deleted, each batch in one
 * transaction with its device rows first (devices reference sessions with no cascade). A session
 * is a sign-in, not a record: rule 4 keeps history in the audit log, not here. The sessions are
 * long dead, so nothing else writes them; the purge re-checks the age in the DELETE.
 */
@Injectable()
export class SessionPurge {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly devices: DeviceRepository,
  ) {}

  async run(schoolId: SchoolId, now: Date = new Date()): Promise<{ sessions: number; devices: number }> {
    const endedBefore = new Date(now.getTime() - SESSION_PURGE_AFTER_MS);
    const total = { sessions: 0, devices: 0 };
    for (;;) {
      const batch = await this.purgeBatch(schoolId, endedBefore);
      total.sessions += batch.sessions;
      total.devices += batch.devices;
      if (batch.listed < BATCH) return total;
    }
  }

  @Transactional()
  private async purgeBatch(
    schoolId: SchoolId,
    endedBefore: Date,
  ): Promise<{ listed: number; sessions: number; devices: number }> {
    const ids = await this.sessions.listEndedBefore(schoolId, endedBefore, BATCH);
    const devices = await this.devices.deleteForSessions(schoolId, ids);
    const sessions = await this.sessions.deleteEnded(schoolId, ids, endedBefore);
    return { listed: ids.length, sessions, devices };
  }
}
