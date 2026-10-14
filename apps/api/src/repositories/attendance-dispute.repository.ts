import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  DisputeStatus,
  StaffAttendanceSource,
  StaffAttendanceStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-44.md §2.5, §2.6 (R346, R347). The tenant table staff_attendance_disputes: born
// pending, one pending per mark (partial unique), pending -> approved | rejected | withdrawn, the
// decision and withdrawal groups set once (triggers). Never deleted. Importable only from
// src/modules/staff-attendance/** (eslint.config.mjs). Staff rows: no Scope; callers hold
// attendance.staff.manage (school-wide) or read their own staff id from the session.

export interface DisputeRecord {
  id: bigint;
  attendanceId: bigint;
  staffId: bigint;
  staffName: string;
  /** The mark's date, status now and source. */
  date: Date;
  markStatus: StaffAttendanceStatus;
  markSource: StaffAttendanceSource;
  requestedStatus: StaffAttendanceStatus;
  reason: string;
  status: DisputeStatus;
  createdAt: Date;
  decidedBy: bigint | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  withdrawnAt: Date | null;
  updatedAt: Date;
}

export interface DisputeListQuery {
  staffId?: bigint;
  status?: DisputeStatus;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  attendanceId: true,
  staffId: true,
  requestedStatus: true,
  reason: true,
  status: true,
  createdAt: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  withdrawnAt: true,
  updatedAt: true,
  staff: { select: { fullName: true } },
  attendance: { select: { date: true, status: true, source: true } },
  decidedByUser: { select: { staff: { select: { fullName: true } } } },
} as const satisfies Prisma.StaffAttendanceDisputeSelect;

type Row = Prisma.StaffAttendanceDisputeGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ staff, attendance, decidedByUser, ...row }: Row): DisputeRecord => ({
  ...row,
  staffName: staff.fullName,
  date: attendance.date,
  markStatus: attendance.status,
  markSource: attendance.source,
  decidedByName: decidedByUser?.staff?.fullName ?? null,
});

@Injectable()
export class AttendanceDisputeRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async create(
    schoolId: SchoolId,
    data: {
      attendanceId: bigint;
      staffId: bigint;
      raisedBy: bigint;
      requestedStatus: StaffAttendanceStatus;
      reason: string;
    },
  ): Promise<DisputeRecord> {
    const row = await this.txHost.tx.staffAttendanceDispute.create({
      data: { schoolId, ...data },
      select: SELECT,
    });
    return toRecord(row);
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<DisputeRecord | null> {
    const row = await this.txHost.tx.staffAttendanceDispute.findFirst({ where: { schoolId, id }, select: SELECT });
    return row && toRecord(row);
  }

  /** The pending dispute of a mark, if any. */
  async pendingFor(schoolId: SchoolId, attendanceId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.staffAttendanceDispute.findFirst({
      where: { schoolId, attendanceId, status: 'pending' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Compare-and-set on updated_at: holds the row lock to the end of the transaction (readLocked). */
  async lockIfUnchanged(schoolId: SchoolId, row: DisputeRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.staffAttendanceDispute.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** Newest first, then id. */
  async list(schoolId: SchoolId, query: DisputeListQuery): Promise<{ rows: DisputeRecord[]; total: number }> {
    const where: Prisma.StaffAttendanceDisputeWhereInput = {
      schoolId,
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const rows = await this.txHost.tx.staffAttendanceDispute.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.staffAttendanceDispute.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** pending -> approved | rejected. 0: it was no longer pending. */
  async decide(
    schoolId: SchoolId,
    id: bigint,
    data: { status: 'approved' | 'rejected'; decidedBy: bigint; decisionReason: string | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.staffAttendanceDispute.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: { ...data, decidedAt: new Date() },
    });
    return count;
  }

  /** pending -> withdrawn by the staff member's own login. 0: no longer pending. */
  async withdraw(schoolId: SchoolId, id: bigint, withdrawnBy: bigint): Promise<number> {
    const { count } = await this.txHost.tx.staffAttendanceDispute.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: { status: 'withdrawn', withdrawnBy, withdrawnAt: new Date() },
    });
    return count;
  }

  /**
   * Each mark's dispute to show beside it: the pending one, else the latest (the day views,
   * contracts/slice-44.md §2.7).
   */
  async latestForMarks(
    schoolId: SchoolId,
    attendanceIds: bigint[],
  ): Promise<Map<bigint, { id: bigint; status: DisputeStatus }>> {
    if (attendanceIds.length === 0) return new Map();
    const rows = await this.txHost.tx.staffAttendanceDispute.findMany({
      where: { schoolId, attendanceId: { in: attendanceIds } },
      select: { id: true, attendanceId: true, status: true },
      orderBy: { id: 'asc' },
    });
    const found = new Map<bigint, { id: bigint; status: DisputeStatus }>();
    for (const row of rows) {
      const current = found.get(row.attendanceId);
      // Ascending ids: a later row replaces an earlier one unless the earlier one is pending.
      if (current?.status !== 'pending') found.set(row.attendanceId, { id: row.id, status: row.status });
    }
    return found;
  }
}
