import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ContractType } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Phase 5 slice 42 (rule 38, R337; contracts/slice-42.md §2.4): the staff report's reads — a page
// of staff, their attendance counts and approved leave in a window, and each one's newest
// contract. Read-only; every query filters school_id, probed cross-school in
// test/reports/isolation.e2e-spec.ts.

export interface StaffReportMember {
  id: bigint;
  fullName: string;
  designation: string | null;
  status: 'active' | 'suspended' | 'left';
}

export interface StaffAttendanceCounts {
  present: number;
  absent: number;
  late: number;
  onLeave: number;
}

export interface LatestContract {
  type: ContractType;
  startsOn: Date;
  endsOn: Date | null;
  endedAt: Date | null;
}

@Injectable()
export class StaffReportRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Staff employed at some point of the window (not left before `from`), by name; a page and the total. */
  async members(
    schoolId: SchoolId,
    filter: { from: Date; staffName?: string },
    page: { skip: number; take: number },
  ): Promise<{ rows: StaffReportMember[]; total: number }> {
    const where = {
      schoolId,
      OR: [{ status: { not: 'left' as const } }, { leftOn: null }, { leftOn: { gte: filter.from } }],
      ...(filter.staffName === undefined ? {} : { fullName: { contains: filter.staffName, mode: 'insensitive' as const } }),
    };
    const rows = await this.txHost.tx.staff.findMany({
      where,
      select: { id: true, fullName: true, designation: true, status: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.staff.count({ where });
    return { rows, total };
  }

  /** Each member's recorded days of the window, by status. */
  async attendance(
    schoolId: SchoolId,
    staffIds: readonly bigint[],
    from: Date,
    to: Date,
  ): Promise<Map<bigint, StaffAttendanceCounts>> {
    const counts = new Map<bigint, StaffAttendanceCounts>();
    if (staffIds.length === 0) return counts;
    const rows = await this.txHost.tx.staffAttendance.groupBy({
      by: ['staffId', 'status'],
      where: { schoolId, staffId: { in: [...staffIds] }, date: { gte: from, lte: to } },
      _count: { _all: true },
    });
    for (const row of rows) {
      const entry = counts.get(row.staffId) ?? { present: 0, absent: 0, late: 0, onLeave: 0 };
      const n = row._count._all;
      if (row.status === 'present') entry.present += n;
      else if (row.status === 'absent') entry.absent += n;
      else if (row.status === 'late') entry.late += n;
      else entry.onLeave += n;
      counts.set(row.staffId, entry);
    }
    return counts;
  }

  /** Working days of each member's approved (or ended-early) leave starting in the window. */
  async leaveTaken(schoolId: SchoolId, staffIds: readonly bigint[], from: Date, to: Date): Promise<Map<bigint, number>> {
    if (staffIds.length === 0) return new Map();
    const rows = await this.txHost.tx.leaveRequest.groupBy({
      by: ['staffId'],
      where: {
        schoolId,
        staffId: { in: [...staffIds] },
        status: { in: ['approved', 'ended_early'] },
        startsOn: { gte: from, lte: to },
      },
      _sum: { workingDays: true },
    });
    return new Map(rows.map((r) => [r.staffId, r._sum.workingDays ?? 0]));
  }

  /** Each member's newest contract (by start, then id). */
  async latestContracts(schoolId: SchoolId, staffIds: readonly bigint[]): Promise<Map<bigint, LatestContract>> {
    if (staffIds.length === 0) return new Map();
    const rows = await this.txHost.tx.staffContract.findMany({
      where: { schoolId, staffId: { in: [...staffIds] } },
      select: { staffId: true, type: true, startsOn: true, endsOn: true, endedAt: true },
      orderBy: [{ staffId: 'asc' }, { startsOn: 'desc' }, { id: 'desc' }],
      distinct: ['staffId'],
    });
    return new Map(rows.map((r) => [r.staffId, { type: r.type, startsOn: r.startsOn, endsOn: r.endsOn, endedAt: r.endedAt }]));
  }
}
