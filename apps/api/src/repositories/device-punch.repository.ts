import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PunchDirection, PunchOutcome, StaffStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-44.md (R345, A11). The tenant table device_punches (append-only, the replay
// unique (school_id, device_user_id, punched_at)) and the device mapping on staff
// (staff.device_user_id, unique per school). Importable only from src/modules/staff-attendance/**
// (eslint.config.mjs). Staff rows, not student rows: no Scope; every caller holds
// attendance.staff.manage, or is the punch intake running for the school the device token named.

/** The staff member holding a device user id now (A11: the mapping at receipt). */
export interface DeviceHolder {
  staffId: bigint;
  deviceUserId: string;
  status: StaffStatus;
  joinedOn: Date | null;
}

export interface NewPunch {
  staffId: bigint | null;
  deviceUserId: string;
  punchedAt: Date;
  direction: PunchDirection | null;
  outcome: PunchOutcome;
}

export interface InsertedPunch {
  id: bigint;
  deviceUserId: string;
  punchedAt: Date;
}

export interface PunchView {
  id: bigint;
  deviceUserId: string;
  staffId: bigint | null;
  staffName: string | null;
  punchedAt: Date;
  direction: PunchDirection | null;
  outcome: PunchOutcome;
  receivedAt: Date;
  staffAttendanceId: bigint | null;
}

export interface PunchListQuery {
  /** punched_at in [from, to). */
  from: Date;
  to: Date;
  staffId?: bigint;
  unmapped?: boolean;
  skip: number;
  take: number;
}

/** The replay key as one string. */
export const punchKey = (deviceUserId: string, punchedAt: Date): string =>
  `${deviceUserId}|${punchedAt.toISOString()}`;

const VIEW_SELECT = {
  id: true,
  deviceUserId: true,
  staffId: true,
  punchedAt: true,
  direction: true,
  outcome: true,
  receivedAt: true,
  staff: { select: { fullName: true } },
  staffAttendance: { select: { id: true } },
} as const satisfies Prisma.DevicePunchSelect;

@Injectable()
export class DevicePunchRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The staff members holding these device user ids now, whatever their status. */
  async holders(schoolId: SchoolId, deviceUserIds: string[]): Promise<Map<string, DeviceHolder>> {
    if (deviceUserIds.length === 0) return new Map();
    const rows = await this.txHost.tx.staff.findMany({
      where: { schoolId, deviceUserId: { in: deviceUserIds } },
      select: { id: true, deviceUserId: true, status: true, joinedOn: true },
    });
    return new Map(
      rows.flatMap((r) =>
        r.deviceUserId === null
          ? []
          : [[r.deviceUserId, { staffId: r.id, deviceUserId: r.deviceUserId, status: r.status, joinedOn: r.joinedOn }]],
      ),
    );
  }

  /** Which of these replay keys are stored already (punchKey strings). */
  async storedKeys(schoolId: SchoolId, punches: { deviceUserId: string; punchedAt: Date }[]): Promise<Set<string>> {
    if (punches.length === 0) return new Set();
    const rows = await this.txHost.tx.devicePunch.findMany({
      where: {
        schoolId,
        deviceUserId: { in: [...new Set(punches.map((p) => p.deviceUserId))] },
        punchedAt: { in: punches.map((p) => p.punchedAt) },
      },
      select: { deviceUserId: true, punchedAt: true },
    });
    return new Set(rows.map((r) => punchKey(r.deviceUserId, r.punchedAt)));
  }

  /**
   * Inserts the punches with ON CONFLICT DO NOTHING (R345): only the rows actually inserted come
   * back, so a punch absent from the answer lost a replay race and is a duplicate.
   */
  async insert(schoolId: SchoolId, punches: NewPunch[]): Promise<InsertedPunch[]> {
    if (punches.length === 0) return [];
    return this.txHost.tx.devicePunch.createManyAndReturn({
      data: punches.map((p) => ({
        schoolId,
        staffId: p.staffId,
        deviceUserId: p.deviceUserId,
        punchedAt: p.punchedAt,
        direction: p.direction,
        outcome: p.outcome,
      })),
      skipDuplicates: true,
      select: { id: true, deviceUserId: true, punchedAt: true },
    });
  }

  /** The day view (contracts/slice-44.md §2.4): sorted by punchedAt, then id. */
  async list(schoolId: SchoolId, query: PunchListQuery): Promise<{ rows: PunchView[]; total: number }> {
    const where: Prisma.DevicePunchWhereInput = {
      schoolId,
      punchedAt: { gte: query.from, lt: query.to },
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.unmapped === true ? { staffId: null } : {}),
    };
    const rows = await this.txHost.tx.devicePunch.findMany({
      where,
      select: VIEW_SELECT,
      orderBy: [{ punchedAt: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.devicePunch.count({ where });
    return {
      total,
      rows: rows.map(({ staff, staffAttendance, ...row }) => ({
        ...row,
        staffName: staff?.fullName ?? null,
        staffAttendanceId: staffAttendance?.id ?? null,
      })),
    };
  }

  /** Per staff member, the first punch and the count in [from, to) (the day sheet, §2.7). */
  async firstPunches(
    schoolId: SchoolId,
    staffIds: bigint[],
    from: Date,
    to: Date,
  ): Promise<Map<bigint, { firstPunchAt: Date; count: number }>> {
    if (staffIds.length === 0) return new Map();
    const groups = await this.txHost.tx.devicePunch.groupBy({
      by: ['staffId'],
      where: { schoolId, staffId: { in: staffIds }, punchedAt: { gte: from, lt: to } },
      _min: { punchedAt: true },
      _count: { _all: true },
    });
    return new Map(
      groups.flatMap((g) =>
        g.staffId === null || g._min.punchedAt === null
          ? []
          : [[g.staffId, { firstPunchAt: g._min.punchedAt, count: g._count._all }]],
      ),
    );
  }

  // ------------------------------------------------------------------------------ the mapping

  /** The staff member's current device user id; undefined when the staff row is not this school's. */
  async deviceUserIdOf(schoolId: SchoolId, staffId: bigint): Promise<{ deviceUserId: string | null } | null> {
    return this.txHost.tx.staff.findFirst({ where: { schoolId, id: staffId }, select: { deviceUserId: true } });
  }

  /** The other staff member holding `deviceUserId`, if any. */
  async heldByOther(schoolId: SchoolId, deviceUserId: string, staffId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.staff.findFirst({
      where: { schoolId, deviceUserId, id: { not: staffId } },
      select: { id: true },
    });
    return row !== null;
  }

  async setDeviceUserId(schoolId: SchoolId, staffId: bigint, deviceUserId: string | null): Promise<void> {
    await this.txHost.tx.staff.update({
      where: { schoolId_id: { schoolId, id: staffId } },
      data: { deviceUserId },
      select: { id: true },
    });
  }
}
