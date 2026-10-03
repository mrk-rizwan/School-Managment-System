import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { HolidayKind, HolidayStatus, Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-10.md §4 (R116, R117). The tenant table holidays: inclusive date ranges, never
// deleted (trigger), live (draft or published) ranges never overlap in a school
// (holidays_live_excl), and a published row's dates, kind and name are frozen by trigger.

export interface HolidayRecord {
  id: bigint;
  /** UTC midnight of the calendar date (a `date` column). */
  startsOn: Date;
  endsOn: Date;
  name: string;
  description: string | null;
  kind: HolidayKind;
  appliesToStaff: boolean;
  status: HolidayStatus;
  publishedAt: Date | null;
  publishedBy: bigint | null;
  cancelledAt: Date | null;
  cancelledBy: bigint | null;
  cancelReason: string | null;
  announcementId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A holiday with the staff names of whoever published and cancelled it, for the DTO. */
export interface HolidayView extends HolidayRecord {
  publishedByName: string | null;
  cancelledByName: string | null;
}

export interface NewHoliday {
  startsOn: Date;
  endsOn: Date;
  name: string;
  description: string | null;
  kind: HolidayKind;
  appliesToStaff: boolean;
}

export type HolidayChange = Partial<NewHoliday>;

export interface HolidayListQuery {
  dateFrom?: Date;
  dateTo?: Date;
  /** The statuses the caller may see; a draft is filtered here for a caller without holiday.manage. */
  statuses: readonly HolidayStatus[];
  kind?: HolidayKind;
  sort: 'startsOn' | '-startsOn';
  skip: number;
  take: number;
}

/** A published holiday as the teaching-day arithmetic and the calendar reads need it. */
export interface PublishedHoliday {
  id: bigint;
  startsOn: Date;
  endsOn: Date;
  name: string;
  kind: HolidayKind;
  appliesToStaff: boolean;
}

/** One person each, as §4.7 resolves them; ids only. */
export interface NoticeRecipients {
  guardianIds: bigint[];
  staffIds: bigint[];
  studentIds: bigint[];
}

const SELECT = {
  id: true,
  startsOn: true,
  endsOn: true,
  name: true,
  description: true,
  kind: true,
  appliesToStaff: true,
  status: true,
  publishedAt: true,
  publishedBy: true,
  cancelledAt: true,
  cancelledBy: true,
  cancelReason: true,
  announcementId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.HolidaySelect;

/** Overlapping `from..to`, both inclusive; either bound may be open. */
const overlapping = (from: Date | undefined, to: Date | undefined): Prisma.HolidayWhereInput => ({
  ...(from === undefined ? {} : { endsOn: { gte: from } }),
  ...(to === undefined ? {} : { startsOn: { lte: to } }),
});

const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

@Injectable()
export class HolidayRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: HolidayListQuery,
  ): Promise<{ rows: HolidayView[]; total: number }> {
    const where: Prisma.HolidayWhereInput = {
      schoolId,
      status: { in: [...query.statuses] },
      ...overlapping(query.dateFrom, query.dateTo),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    };
    const direction: Prisma.SortOrder = query.sort === '-startsOn' ? 'desc' : 'asc';
    const rows = await this.txHost.tx.holiday.findMany({
      where,
      select: SELECT,
      orderBy: [{ startsOn: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.holiday.count({ where });
    return { rows: await this.withNames(schoolId, rows), total };
  }

  /** The holiday if its status is one of `statuses` (a hidden draft reads as absent). */
  findById(
    schoolId: SchoolId,
    id: bigint,
    statuses?: readonly HolidayStatus[],
  ): Promise<HolidayRecord | null> {
    return this.txHost.tx.holiday.findFirst({
      where: { schoolId, id, ...(statuses === undefined ? {} : { status: { in: [...statuses] } }) },
      select: SELECT,
    });
  }

  async view(schoolId: SchoolId, row: HolidayRecord): Promise<HolidayView> {
    const [view] = await this.withNames(schoolId, [row]);
    if (!view) throw new Error('holiday view vanished');
    return view;
  }

  /**
   * Locks the row to the end of the transaction if it is still as read (same updated_at),
   * writing nothing visible. False when it changed; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<HolidayRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.holiday.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** Created `draft`. An overlap with a live holiday fails holidays_live_excl. */
  create(schoolId: SchoolId, data: NewHoliday): Promise<HolidayRecord> {
    return this.txHost.tx.holiday.create({
      data: { schoolId, ...data, status: 'draft' },
      select: SELECT,
    });
  }

  /** Plain attributes. The caller holds the row lock. */
  update(schoolId: SchoolId, id: bigint, data: HolidayChange): Promise<HolidayRecord> {
    return this.txHost.tx.holiday.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  publish(schoolId: SchoolId, id: bigint, by: bigint, at: Date): Promise<HolidayRecord> {
    return this.txHost.tx.holiday.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status: 'published', publishedAt: at, publishedBy: by },
      select: SELECT,
    });
  }

  cancel(
    schoolId: SchoolId,
    id: bigint,
    by: bigint,
    at: Date,
    reason: string,
  ): Promise<HolidayRecord> {
    return this.txHost.tx.holiday.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status: 'cancelled', cancelledAt: at, cancelledBy: by, cancelReason: reason },
      select: SELECT,
    });
  }

  /**
   * The oldest live (draft or published) holiday overlapping `from..to`, other than `exceptId`:
   * the row holidays_live_excl would name (HOLIDAY_DATES_TAKEN).
   */
  async firstLiveOverlapping(
    schoolId: SchoolId,
    from: Date,
    to: Date,
    exceptId?: bigint,
  ): Promise<bigint | null> {
    const row = await this.txHost.tx.holiday.findFirst({
      where: {
        schoolId,
        status: { in: ['draft', 'published'] },
        ...overlapping(from, to),
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return row?.id ?? null;
  }

  /** Published holidays overlapping `from..to` (whole rows), ascending by start (R116). */
  publishedOverlapping(schoolId: SchoolId, from: Date, to: Date): Promise<PublishedHoliday[]> {
    return this.txHost.tx.holiday.findMany({
      where: { schoolId, status: 'published', ...overlapping(from, to) },
      select: {
        id: true,
        startsOn: true,
        endsOn: true,
        name: true,
        kind: true,
        appliesToStaff: true,
      },
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The holiday notice's recipients (contracts/slice-10.md §4.7), one row per person: guardians
   * not merged with a live link to an active student; active staff; active students with a live
   * login while student login is enabled (`studentLoginEnabled`, the school's setting, read by
   * the caller). A staff member whose login also carries a guardian of the guardian set is
   * dropped (one person, the guardian plan). Four sequential statements.
   */
  async noticeRecipients(schoolId: SchoolId, studentLoginEnabled: boolean): Promise<NoticeRecipients> {
    const guardians = await this.txHost.tx.guardian.findMany({
      where: {
        schoolId,
        mergedIntoId: null,
        studentLinks: { some: { endedAt: null, student: { is: { status: 'active' } } } },
      },
      select: { id: true },
    });
    const guardianIds = new Set(guardians.map((g) => g.id));
    const staff = await this.txHost.tx.staff.findMany({
      where: { schoolId, status: 'active' },
      select: { id: true },
    });
    const staffIds = staff.map((s) => s.id);
    const alsoGuardians =
      staffIds.length === 0 || guardianIds.size === 0
        ? []
        : await this.txHost.tx.user.findMany({
            where: { schoolId, staffId: { in: staffIds }, guardianId: { in: [...guardianIds] } },
            select: { staffId: true },
          });
    const dropped = new Set(alsoGuardians.map((u) => u.staffId));
    const students = studentLoginEnabled
      ? await this.txHost.tx.student.findMany({
          where: { schoolId, status: 'active', user: { is: { status: 'active' } } },
          select: { id: true },
        })
      : [];
    return {
      guardianIds: [...guardianIds].sort(ascending),
      staffIds: staffIds.filter((id) => !dropped.has(id)).sort(ascending),
      studentIds: students.map((s) => s.id).sort(ascending),
    };
  }

  /** Publisher and canceller staff names: two sequential reads whatever the page size. */
  private async withNames(schoolId: SchoolId, rows: HolidayRecord[]): Promise<HolidayView[]> {
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.publishedBy, r.cancelledBy]).filter((id): id is bigint => id !== null),
      ),
    ];
    const users =
      userIds.length === 0
        ? []
        : await this.txHost.tx.user.findMany({
            where: { schoolId, id: { in: userIds } },
            select: { id: true, staffId: true },
          });
    const staffIds = users.map((u) => u.staffId).filter((id): id is bigint => id !== null);
    const staff =
      staffIds.length === 0
        ? []
        : await this.txHost.tx.staff.findMany({
            where: { schoolId, id: { in: staffIds } },
            select: { id: true, fullName: true },
          });
    const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
    const userName = new Map(
      users.map((u) => [u.id, u.staffId === null ? null : (staffName.get(u.staffId) ?? null)]),
    );
    const name = (id: bigint | null) => (id === null ? null : (userName.get(id) ?? null));
    return rows.map((row) => ({
      ...row,
      publishedByName: name(row.publishedBy),
      cancelledByName: name(row.cancelledBy),
    }));
  }
}
