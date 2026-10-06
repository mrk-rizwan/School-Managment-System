import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { LeaveStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface LeaveRequestRecord {
  id: bigint;
  staffId: bigint;
  leaveTypeId: bigint;
  startsOn: Date;
  endsOn: Date;
  workingDays: number;
  reason: string;
  status: LeaveStatus;
  requestedBy: bigint;
  requestedAt: Date;
  onBehalf: boolean;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  selfApproved: boolean;
  coverAssignmentId: bigint | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  endedEarlyOn: Date | null;
  updatedAt: Date;
}

export type LeaveRequestSort = '-requestedAt' | 'startsOn';

export interface LeaveRequestListQuery {
  staffId?: bigint;
  status?: LeaveStatus;
  startsFrom?: Date;
  startsTo?: Date;
  sort: LeaveRequestSort;
  skip: number;
  take: number;
}

/** A class-teacher row of a staff member, with its section's names (R212's sectionsNeedingCover). */
export interface ClassTeacherRow {
  id: bigint;
  staffId: bigint;
  sectionId: bigint;
  startsOn: Date;
  endsOn: Date | null;
}

/** Live: these hold dates (leave_requests_live_excl). */
export const LIVE_LEAVE_STATUSES: readonly LeaveStatus[] = ['pending', 'approved', 'ended_early'];
/** Taken: these count against a balance (R209). */
export const TAKEN_LEAVE_STATUSES: readonly LeaveStatus[] = ['approved', 'ended_early'];

// Scalars only: names are read by separate statements, since Prisma loads sibling relations of one
// select concurrently and a transaction must not overlap statements.
const SELECT = {
  id: true,
  staffId: true,
  leaveTypeId: true,
  startsOn: true,
  endsOn: true,
  workingDays: true,
  reason: true,
  status: true,
  requestedBy: true,
  requestedAt: true,
  onBehalf: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  selfApproved: true,
  coverAssignmentId: true,
  cancelledAt: true,
  cancelReason: true,
  endedEarlyOn: true,
  updatedAt: true,
} as const satisfies Prisma.LeaveRequestSelect;

/** Rows whose taken dates (starts_on .. coalesce(ended_early_on, ends_on)) overlap from..to. */
const overlapping = (from: Date, to: Date): Prisma.LeaveRequestWhereInput => ({
  startsOn: { lte: to },
  OR: [
    { endedEarlyOn: null, endsOn: { gte: from } },
    { endedEarlyOn: { gte: from } },
  ],
});

/**
 * Leave requests (tenant table leave_requests, phase-3-financial.md §4 "Leave", R209-R212, R248).
 * Never deleted; dates, type and staff are frozen; only status, decision, cancel, ended_early_on and
 * cover_assignment_id move, forward. Every status write is conditional on the status read, so a
 * moved row changes nothing and the caller answers 409.
 */
@Injectable()
export class LeaveRequestRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findById(schoolId: SchoolId, id: bigint): Promise<LeaveRequestRecord | null> {
    return this.txHost.tx.leaveRequest.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  async list(
    schoolId: SchoolId,
    query: LeaveRequestListQuery,
  ): Promise<{ rows: LeaveRequestRecord[]; total: number }> {
    const where: Prisma.LeaveRequestWhereInput = {
      schoolId,
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.startsFrom === undefined && query.startsTo === undefined
        ? {}
        : {
            startsOn: {
              ...(query.startsFrom === undefined ? {} : { gte: query.startsFrom }),
              ...(query.startsTo === undefined ? {} : { lte: query.startsTo }),
            },
          }),
    };
    const orderBy: Prisma.LeaveRequestOrderByWithRelationInput[] =
      query.sort === 'startsOn'
        ? [{ startsOn: 'asc' }, { id: 'asc' }]
        : [{ requestedAt: 'desc' }, { id: 'desc' }];
    const rows = await this.txHost.tx.leaveRequest.findMany({
      where,
      select: SELECT,
      orderBy,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.leaveRequest.count({ where });
    return { rows, total };
  }

  /** The first live request of the staff member overlapping from..to (R211), if any. */
  findLiveOverlapping(
    schoolId: SchoolId,
    staffId: bigint,
    from: Date,
    to: Date,
  ): Promise<{ id: bigint } | null> {
    return this.txHost.tx.leaveRequest.findFirst({
      where: { schoolId, staffId, status: { in: [...LIVE_LEAVE_STATUSES] }, ...overlapping(from, to) },
      select: { id: true },
      orderBy: { startsOn: 'asc' },
    });
  }

  /** The staff member's requests in `statuses` whose taken dates overlap from..to (balances). */
  forStaffInRange(
    schoolId: SchoolId,
    staffId: bigint,
    statuses: readonly LeaveStatus[],
    from: Date,
    to: Date,
  ): Promise<LeaveRequestRecord[]> {
    return this.txHost.tx.leaveRequest.findMany({
      where: { schoolId, staffId, status: { in: [...statuses] }, ...overlapping(from, to) },
      select: SELECT,
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
  }

  /** The approved leave covering `date` of each listed staff member (the day sheet, R245). */
  takenOn(
    schoolId: SchoolId,
    date: Date,
    staffIds: readonly bigint[],
  ): Promise<{ id: bigint; staffId: bigint; leaveTypeId: bigint }[]> {
    if (staffIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.leaveRequest.findMany({
      where: {
        schoolId,
        staffId: { in: [...staffIds] },
        status: { in: [...TAKEN_LEAVE_STATUSES] },
        ...overlapping(date, date),
      },
      select: { id: true, staffId: true, leaveTypeId: true },
    });
  }

  create(
    schoolId: SchoolId,
    data: {
      staffId: bigint;
      leaveTypeId: bigint;
      startsOn: Date;
      endsOn: Date;
      workingDays: number;
      reason: string;
      requestedBy: bigint;
      onBehalf: boolean;
    },
  ): Promise<LeaveRequestRecord> {
    return this.txHost.tx.leaveRequest.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /** Locks the row if unchanged since `row` was read; false: read again. */
  async lockIfUnchanged(schoolId: SchoolId, row: LeaveRequestRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.leaveRequest.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** pending -> approved | rejected. 0: the row was not pending. */
  async decide(
    schoolId: SchoolId,
    id: bigint,
    data: {
      status: 'approved' | 'rejected';
      decidedBy: bigint;
      decisionReason: string | null;
      selfApproved: boolean;
      coverAssignmentId: bigint | null;
    },
  ): Promise<number> {
    const { count } = await this.txHost.tx.leaveRequest.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: { ...data, decidedAt: new Date() },
    });
    return count;
  }

  /** pending | approved -> cancelled. 0: the row was in neither. */
  async cancel(schoolId: SchoolId, id: bigint, from: LeaveStatus, by: bigint, reason: string): Promise<number> {
    const { count } = await this.txHost.tx.leaveRequest.updateMany({
      where: { schoolId, id, status: from },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: by, cancelReason: reason },
    });
    return count;
  }

  /**
   * approved -> ended_early (R248). The trigger reads the actor from asms.actor_user_id, so the
   * caller sets the change context first in the same transaction. 0: the row was not approved.
   */
  async endEarly(schoolId: SchoolId, id: bigint, endedEarlyOn: Date): Promise<number> {
    const { count } = await this.txHost.tx.leaveRequest.updateMany({
      where: { schoolId, id, status: 'approved' },
      data: { status: 'ended_early', endedEarlyOn },
    });
    return count;
  }

  /** Live class-teacher rows of the staff members overlapping from..to (R212). */
  classTeacherRows(
    schoolId: SchoolId,
    staffIds: readonly bigint[],
    from: Date,
    to: Date,
  ): Promise<ClassTeacherRow[]> {
    if (staffIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.teacherAssignment
      .findMany({
        where: {
          schoolId,
          staffId: { in: [...new Set(staffIds)] },
          role: 'class_teacher',
          voidedAt: null,
          sectionId: { not: null },
          startsOn: { lte: to },
          OR: [{ endsOn: null }, { endsOn: { gte: from } }],
        },
        select: { id: true, staffId: true, sectionId: true, startsOn: true, endsOn: true },
        orderBy: { id: 'asc' },
      })
      .then((rows) =>
        rows.flatMap((r) => (r.sectionId === null ? [] : [{ ...r, sectionId: r.sectionId }])),
      );
  }

  /** The section of each cover row (a cover always has one). */
  async coverSections(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, bigint>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, sectionId: true },
    });
    return new Map(rows.flatMap((r) => (r.sectionId === null ? [] : [[r.id, r.sectionId] as const])));
  }

  /** Each cover row's last day, or null when it was voided (never counted) or has none. */
  async coverLastDays(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, Date | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, endsOn: true, voidedAt: true },
    });
    return new Map(rows.map((r) => [r.id, r.voidedAt === null ? r.endsOn : null]));
  }

  /** `<class> <section>` per section id. */
  async sectionLabels(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, { classId: bigint; label: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, classId: true, class: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.id, { classId: r.classId, label: `${r.class.name} ${r.name}` }]));
  }

  /** Staff full names by staff id. */
  async staffNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  /** The staff full name behind each user id (the decider). */
  async userNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.user.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, staff: { select: { fullName: true } } },
    });
    return new Map(rows.flatMap((r) => (r.staff ? [[r.id, r.staff.fullName] as const] : [])));
  }
}
