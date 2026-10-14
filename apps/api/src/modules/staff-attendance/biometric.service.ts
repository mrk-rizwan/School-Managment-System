import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { newSessionToken } from '../../common/auth/platform-session';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { addDays, dayStart, SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { DevicePunchRepository } from '../../repositories/device-punch.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { fromDateString } from '../academics/academics.shared';
import type {
  DevicePunchDto,
  DeviceTokenDto,
  DeviceTokenRevokedDto,
  ListDevicePunchesQueryDto,
  SetDeviceUserDto,
  StaffDeviceUserDto,
} from './biometric.dto';

// contracts/slice-44.md §2.1, §2.3, §2.4 (R344, A11): the school side of the biometric device.

/** R346's wording for the device mapping too: nobody maps their own attendance (§2.3). */
export const ownAttendance = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'Nobody changes how their own attendance is recorded.', {
    reason: 'own_attendance',
  });

@Injectable()
export class BiometricService {
  constructor(
    private readonly context: SchoolContext,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly punches: DevicePunchRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /**
   * §2.1: a fresh token, shown once; only its sha-256 is stored, so the old token stops resolving
   * at commit. The token is never logged or audited.
   */
  @Transactional()
  async rotate(): Promise<DeviceTokenDto> {
    const { schoolId, userId } = this.context.actor();
    const before = await this.ownSchool.find(schoolId);
    if (!before) throw notFound();
    const { token, tokenHash } = newSessionToken();
    const rotatedAt = this.clock.now();
    await this.ownSchool.setDeviceToken(schoolId, tokenHash, rotatedAt);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'device_token.rotated',
      subjectType: 'school',
      subjectId: schoolId,
      metadata: { first: before.deviceTokenRotatedAt === null },
    });
    return { token, rotatedAt };
  }

  /** §2.1: turn the device off. The token stops resolving at commit; audited when one was set. */
  @Transactional()
  async revoke(): Promise<DeviceTokenRevokedDto> {
    const { schoolId, userId } = this.context.actor();
    const revoked = await this.ownSchool.clearDeviceToken(schoolId);
    if (revoked) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'device_token.revoked',
        subjectType: 'school',
        subjectId: schoolId,
      });
    }
    return { revoked };
  }

  /** §2.3: never one's own record; a left member keeps theirs until cleared. */
  @Transactional()
  async setDeviceUser(session: SchoolSessionContext, staffId: bigint, dto: SetDeviceUserDto): Promise<StaffDeviceUserDto> {
    const { schoolId, userId } = this.context.actor();
    if (staffId === session.access.staffId) throw ownAttendance();
    const current = await this.punches.deviceUserIdOf(schoolId, staffId);
    if (!current) throw notFound();
    const to = dto.deviceUserId;
    const result = { staffId: staffId.toString(), deviceUserId: to };
    if (current.deviceUserId === to) return result;
    if (to !== null && (await this.punches.heldByOther(schoolId, to, staffId))) {
      throw fieldRefused('deviceUserId', ErrorCode.INVALID_VALUE, 'deviceUserId is already used by another staff member');
    }
    await this.punches.setDeviceUserId(schoolId, staffId, to);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff.device_user_set',
      subjectType: 'staff',
      subjectId: staffId,
      metadata: { from: current.deviceUserId, to },
    });
    return result;
  }

  /** §2.4: one school day's punches in the school's time zone. */
  async listPunches(query: ListDevicePunchesQueryDto): Promise<Page<DevicePunchDto>> {
    const schoolId = this.context.schoolId;
    const day = fromDateString(query.date);
    if (day > (await this.clock.today(schoolId))) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
    }
    const timezone = await this.clock.timezone(schoolId);
    const { rows, total } = await this.punches.list(schoolId, {
      from: dayStart(timezone, day),
      to: dayStart(timezone, addDays(day, 1)),
      ...(query.staffId === undefined ? {} : { staffId: BigInt(query.staffId) }),
      ...(query.unmapped === undefined ? {} : { unmapped: query.unmapped }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((r) => ({
        id: r.id.toString(),
        deviceUserId: r.deviceUserId,
        staffId: r.staffId?.toString() ?? null,
        staffName: r.staffName,
        punchedAt: r.punchedAt,
        direction: r.direction,
        outcome: r.outcome,
        receivedAt: r.receivedAt,
        staffAttendanceId: r.staffAttendanceId?.toString() ?? null,
      })),
      query,
      total,
    );
  }
}
