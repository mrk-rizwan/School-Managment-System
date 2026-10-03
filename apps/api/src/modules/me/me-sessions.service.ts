import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  DEVICE_SESSION_UNIQUE,
  DeviceRepository,
  type DeviceRecord,
} from '../../repositories/device.repository';
import { SessionRepository } from '../../repositories/session.repository';
import type { DeviceDto, RegisterDeviceDto, SessionsRevokedDto } from './me-sessions.dto';

const toDeviceDto = (row: DeviceRecord): DeviceDto => ({
  id: row.id.toString(),
  platform: row.platform,
  appVersion: row.appVersion,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
});

/** The caller's own sessions and push address (contracts/slice-9.md §3.5, §3.6). */
@Injectable()
export class MeSessionsService {
  constructor(
    private readonly devices: DeviceRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * POST /me/devices. The session is bearer (checked by the route guard). An insert race on the
   * session's unique row aborts that transaction, so it is answered by running again outside
   * it, which finds the row and refreshes it ("row exists").
   */
  async register(
    session: SchoolSessionContext,
    dto: RegisterDeviceDto,
    appVersion: string,
  ): Promise<{ created: boolean; device: DeviceDto }> {
    const apply = () => this.applyRegister(session, dto, appVersion);
    return recoverConstraint(DEVICE_SESSION_UNIQUE, apply, apply);
  }

  @Transactional()
  private async applyRegister(
    session: SchoolSessionContext,
    dto: RegisterDeviceDto,
    appVersion: string,
  ): Promise<{ created: boolean; device: DeviceDto }> {
    const { schoolId, sessionId } = session;
    const now = new Date();
    const current = await this.devices.lockForSession(schoolId, sessionId);
    const data = { platform: dto.platform, pushToken: dto.pushToken, appVersion, now };
    const device =
      current === null
        ? await this.devices.create(schoolId, { ...data, userId: session.access.userId, sessionId })
        : await this.devices.refresh(schoolId, current.id, data);
    // R159: two parents on one phone; the latest sign-in owns the token in this school.
    await this.devices.replaceOthersWithToken(schoolId, dto.pushToken, sessionId, now);
    return { created: current === null, device: toDeviceDto(device) };
  }

  /** POST /me/sessions/revoke-others (R169): every other live session of the caller, any channel. */
  @Transactional()
  async revokeOthers(session: SchoolSessionContext): Promise<SessionsRevokedDto> {
    const { schoolId } = session;
    const userId = session.access.userId;
    const revoked = await this.sessions.revokeAllForUser(
      schoolId,
      userId,
      new Date(),
      session.sessionId,
    );
    if (revoked > 0) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'user.sessions_revoked',
        subjectType: 'user',
        subjectId: userId,
        metadata: { revoked },
      });
    }
    return { revoked };
  }
}
