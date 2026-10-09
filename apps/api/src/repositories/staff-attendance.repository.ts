import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  STAFF_ATTENDANCE_STATUSES,
  type StaffAttendanceStatus,
  type StaffStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { sqlDate } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

// contracts/slice-12.md (R133-R136). The tenant tables staff_attendance (one row per staff member
// per date, staff_attendance_natural_key) and staff_attendance_changes (written only by the
// staff_attendance_history trigger). A row is never deleted; a correction is an UPDATE whose old
// and new values the trigger records with the transaction-local actor and reason
// (ChangeContextRepository). Nested selects follow the composite (school_id, id) foreign keys,
// so they stay inside the school. Raw SQL only for the two row locks (SELECT ... FOR UPDATE, which
// Prisma cannot express); each filters school_id (test/staff-attendance/isolation.e2e-spec.ts).
// Listed in RAW_SQL_FILES. Not student-linked: no Scope (control 7 covers student rows); every
// caller holds attendance.staff.manage or staff.view, both school-wide, or reads its own row.

/** One mark with the names the DTO shows. */
export interface StaffMarkView {
  id: bigint;
  staffId: bigint;
  /** UTC midnight of the calendar date (a `date` column). */
  date: Date;
  status: StaffAttendanceStatus;
  note: string | null;
  /** Null for a mark a biometric device made (Phase 5 rule 40, source `device`). */
  markedBy: bigint | null;
  markedByName: string | null;
  markedAt: Date;
  /** The latest staff_attendance_changes row, if any. */
  lastAmendedAt: Date | null;
  lastAmendedByName: string | null;
}

/** A staff member on a day's sheet, with the day's mark if one exists. */
export interface StaffDayRow {
  staffId: bigint;
  fullName: string;
  designation: string | null;
  staffStatus: StaffStatus;
  mark: StaffMarkView | null;
}

export type StaffDaySort = 'fullName' | '-fullName' | 'status';

export interface StaffDayQuery {
  date: Date;
  /** A status, or `unrecorded` for members without a mark on the date. */
  status?: StaffAttendanceStatus | 'unrecorded';
  /** full_name contains (case-insensitive). */
  q?: string;
  sort: StaffDaySort;
  skip: number;
  take: number;
}

export interface NewStaffMark {
  staffId: bigint;
  status: StaffAttendanceStatus;
  note: string | null;
}

export interface DaySummary {
  staff: number;
  marked: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
}

const staffName = { select: { staff: { select: { fullName: true } } } } as const;

const MARK_SELECT = {
  id: true,
  staffId: true,
  date: true,
  status: true,
  note: true,
  markedBy: true,
  markedAt: true,
  markedByUser: staffName,
  changes: {
    select: { changedAt: true, changedByUser: staffName },
    orderBy: { id: 'desc' },
    take: 1,
  },
} as const satisfies Prisma.StaffAttendanceSelect;

type MarkRow = Prisma.StaffAttendanceGetPayload<{ select: typeof MARK_SELECT }>;

const toView = ({ markedByUser, changes, ...row }: MarkRow): StaffMarkView => {
  const last = changes[0];
  return {
    ...row,
    markedByName: markedByUser?.staff?.fullName ?? null,
    lastAmendedAt: last?.changedAt ?? null,
    lastAmendedByName: last?.changedByUser.staff?.fullName ?? null,
  };
};

/** The staff members on a date's sheet (§4.1): markable now, or marked on that date. */
const onSheet = (date: Date): Prisma.StaffWhereInput => ({
  OR: [
    { status: 'active', OR: [{ joinedOn: null }, { joinedOn: { lte: date } }] },
    { attendance: { some: { date } } },
  ],
});

@Injectable()
export class StaffAttendanceRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * A page of the day's sheet (§4.1). Three statements: the page of staff, the count, the page's
   * marks. The `status` sort needs every row's mark, so it reads the whole (bounded) sheet's
   * marks and pages in memory.
   */
  async daySheet(
    schoolId: SchoolId,
    query: StaffDayQuery,
  ): Promise<{ rows: StaffDayRow[]; total: number }> {
    const and: Prisma.StaffWhereInput[] = [onSheet(query.date)];
    if (query.q !== undefined) {
      and.push({ fullName: { contains: escapeLike(query.q), mode: 'insensitive' } });
    }
    if (query.status === 'unrecorded') {
      and.push({ attendance: { none: { date: query.date } } });
    } else if (query.status !== undefined) {
      and.push({ attendance: { some: { date: query.date, status: query.status } } });
    }
    const where: Prisma.StaffWhereInput = { schoolId, AND: and };
    const select = { id: true, fullName: true, designation: true, status: true } as const;
    const byStatus = query.sort === 'status';
    const direction: Prisma.SortOrder = query.sort === '-fullName' ? 'desc' : 'asc';
    const staff = await this.txHost.tx.staff.findMany({
      where,
      select,
      orderBy: [{ fullName: direction }, { id: 'asc' }],
      ...(byStatus ? {} : { skip: query.skip, take: query.take }),
    });
    const total = byStatus ? staff.length : await this.txHost.tx.staff.count({ where });
    const marks = await this.marksOn(
      schoolId,
      query.date,
      staff.map((s) => s.id),
    );
    const byStaff = new Map(marks.map((m) => [m.staffId, m]));
    let rows: StaffDayRow[] = staff.map((s) => ({
      staffId: s.id,
      fullName: s.fullName,
      designation: s.designation,
      staffStatus: s.status,
      mark: byStaff.get(s.id) ?? null,
    }));
    if (byStatus) {
      // Stable sort over the name order already applied: status in the enum's order, unrecorded
      // last, then name, then id.
      const rank = (row: StaffDayRow) =>
        row.mark === null
          ? STAFF_ATTENDANCE_STATUSES.length
          : STAFF_ATTENDANCE_STATUSES.indexOf(row.mark.status);
      rows = rows
        .map((row, index) => ({ row, index }))
        .sort((x, y) => rank(x.row) - rank(y.row) || x.index - y.index)
        .map(({ row }) => row)
        .slice(query.skip, query.skip + query.take);
    }
    return { rows, total };
  }

  /** The marks on `date` of these staff members, ascending by staff id. */
  async marksOn(schoolId: SchoolId, date: Date, staffIds: bigint[]): Promise<StaffMarkView[]> {
    if (staffIds.length === 0) return [];
    const rows = await this.txHost.tx.staffAttendance.findMany({
      where: { schoolId, date, staffId: { in: staffIds } },
      select: MARK_SELECT,
      orderBy: { staffId: 'asc' },
    });
    return rows.map(toView);
  }

  /**
   * Of `staffIds`, those who may be marked on `date` (§3): `active` now, and `joined_on` null or
   * on or before the date.
   */
  async markable(schoolId: SchoolId, date: Date, staffIds: bigint[]): Promise<Set<bigint>> {
    if (staffIds.length === 0) return new Set();
    const rows = await this.txHost.tx.staff.findMany({
      where: {
        schoolId,
        id: { in: staffIds },
        status: 'active',
        OR: [{ joinedOn: null }, { joinedOn: { lte: date } }],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Locks the existing rows of these staff members on `date` in staff_id order (the slice's only
   * lock, §1) with one SELECT ... FOR UPDATE held to the end of the transaction, and returns them
   * as read under the lock.
   */
  async lockDay(schoolId: SchoolId, date: Date, staffIds: bigint[]): Promise<StaffMarkView[]> {
    if (staffIds.length === 0) return [];
    await this.txHost.tx.$queryRaw`
      SELECT sa.id FROM staff_attendance sa
       WHERE sa.school_id = ${schoolId} AND sa.date = ${sqlDate(date)}
         AND sa.staff_id IN (${Prisma.join(staffIds)})
       ORDER BY sa.staff_id
         FOR UPDATE`;
    return this.marksOn(schoolId, date, staffIds);
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<StaffMarkView | null> {
    const row = await this.txHost.tx.staffAttendance.findFirst({
      where: { schoolId, id },
      select: MARK_SELECT,
    });
    return row && toView(row);
  }

  /** Locks one row (as lockDay) and returns it as read under the lock; null if absent. */
  async lock(schoolId: SchoolId, id: bigint): Promise<StaffMarkView | null> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT sa.id FROM staff_attendance sa
       WHERE sa.school_id = ${schoolId} AND sa.id = ${id}
         FOR UPDATE`;
    if (rows.length === 0) return null;
    return this.findById(schoolId, id);
  }

  /**
   * New rows marked by `markedBy` now. A row that exists already (a concurrent insert) fails
   * staff_attendance_natural_key; one whose marker is the staff member's own login fails
   * staff_attendance_not_self.
   */
  async create(
    schoolId: SchoolId,
    date: Date,
    markedBy: bigint,
    marks: NewStaffMark[],
  ): Promise<void> {
    if (marks.length === 0) return;
    await this.txHost.tx.staffAttendance.createMany({
      data: marks.map((m) => ({
        schoolId,
        staffId: m.staffId,
        date,
        status: m.status,
        note: m.note,
        markedBy,
      })),
    });
  }

  /**
   * Status and note in place. The caller holds the row lock and has set the change context: the
   * history trigger refuses a change without an actor and a reason.
   */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: { status: StaffAttendanceStatus; note: string | null },
  ): Promise<void> {
    await this.txHost.tx.staffAttendance.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: { id: true },
    });
  }

  /** The submit's summary (§2): markable staff on `date` and the marks recorded on it. */
  async daySummary(schoolId: SchoolId, date: Date): Promise<DaySummary> {
    const staff = await this.txHost.tx.staff.count({
      where: { schoolId, status: 'active', OR: [{ joinedOn: null }, { joinedOn: { lte: date } }] },
    });
    const groups = await this.txHost.tx.staffAttendance.groupBy({
      by: ['status'],
      where: { schoolId, date },
      _count: { _all: true },
    });
    const count = (status: StaffAttendanceStatus) =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    return {
      staff,
      marked: groups.reduce((sum, g) => sum + g._count._all, 0),
      present: count('present'),
      absent: count('absent'),
      late: count('late'),
      onLeave: count('on_leave'),
    };
  }

  /**
   * One staff member's marks from `from` to `to` inclusive, ascending by date (§4.4). Staff rows,
   * not student rows, so no Scope (see the header).
   */
  async history(
    schoolId: SchoolId,
    staffId: bigint,
    from: Date,
    to: Date,
  ): Promise<StaffMarkView[]> {
    const rows = await this.txHost.tx.staffAttendance.findMany({
      where: { schoolId, staffId, date: { gte: from, lte: to } },
      select: MARK_SELECT,
      orderBy: { date: 'asc' },
    });
    return rows.map(toView);
  }
}
