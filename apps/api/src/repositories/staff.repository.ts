import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { StaffStatus, SystemRole } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

// contracts/slice-4.md §3. The tenant table staff. `cnic` is the field-encryption envelope and
// `cnicHash` its lookup HMAC; neither is decrypted or matched here, only stored and compared.

export interface StaffRecord {
  id: bigint;
  fullName: string;
  /** `v1:...` ciphertext with AAD `schoolId|staff|cnic`. */
  cnic: string | null;
  cnicHash: string | null;
  /** E.164. */
  phone: string;
  designation: string | null;
  joinedOn: Date | null;
  status: StaffStatus;
  leftOn: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The login whose staff_id is this row, if any. */
  userId: bigint | null;
}

export interface NewStaff {
  fullName: string;
  /** `v1:...` ciphertext with AAD `schoolId|staff|cnic`, or null when not given. */
  cnic: string | null;
  cnicHash: string | null;
  /** E.164. */
  phone: string;
  designation: string | null;
  /** A date (time part ignored by the DATE column). */
  joinedOn: Date | null;
}

export type StaffSortField = 'fullName' | 'joinedOn' | 'createdAt';
export type StaffSort = StaffSortField | `-${StaffSortField}`;

export interface StaffListQuery {
  status?: StaffStatus;
  /** Staff whose login holds a live row of this role. */
  role?: SystemRole;
  hasLogin?: boolean;
  hasCnic?: boolean;
  /** Name or designation contains (case-insensitive); already refused if it holds a CNIC. */
  q?: string;
  /** Phone contains these digits (set only when q is a short digit run). */
  phoneDigits?: string;
  sort: StaffSort;
  skip: number;
  take: number;
}

// One relation, the login's id: a lone relation in a select is a single statement chain.
const SELECT = {
  id: true,
  fullName: true,
  cnic: true,
  cnicHash: true,
  phone: true,
  designation: true,
  joinedOn: true,
  status: true,
  leftOn: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true } },
} as const satisfies Prisma.StaffSelect;

type Row = Prisma.StaffGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ user, ...row }: Row): StaffRecord => ({ ...row, userId: user?.id ?? null });

function orderBy(sort: StaffSort): Prisma.StaffOrderByWithRelationInput[] {
  const direction: Prisma.SortOrder = sort.startsWith('-') ? 'desc' : 'asc';
  const primary: Prisma.StaffOrderByWithRelationInput =
    sort === 'joinedOn' || sort === '-joinedOn'
      ? { joinedOn: { sort: direction, nulls: 'last' } }
      : sort === 'createdAt' || sort === '-createdAt'
        ? { createdAt: direction }
        : { fullName: direction };
  // id breaks ties so paging is stable.
  return [primary, { id: 'asc' }];
}

@Injectable()
export class StaffRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: StaffListQuery,
  ): Promise<{ rows: StaffRecord[]; total: number }> {
    const and: Prisma.StaffWhereInput[] = [];
    if (query.status !== undefined) and.push({ status: query.status });
    if (query.role !== undefined) {
      and.push({ user: { is: { roles: { some: { systemRole: query.role, endedAt: null } } } } });
    }
    if (query.hasLogin !== undefined) {
      and.push(query.hasLogin ? { user: { isNot: null } } : { user: { is: null } });
    }
    if (query.hasCnic !== undefined) and.push({ cnicHash: query.hasCnic ? { not: null } : null });
    if (query.q !== undefined) {
      const pattern = escapeLike(query.q);
      const or: Prisma.StaffWhereInput[] = [
        { fullName: { contains: pattern, mode: 'insensitive' } },
        { designation: { contains: pattern, mode: 'insensitive' } },
      ];
      if (query.phoneDigits !== undefined) or.push({ phone: { contains: query.phoneDigits } });
      and.push({ OR: or });
    }
    const where: Prisma.StaffWhereInput = { schoolId, AND: and };
    // Sequential, not Promise.all: one connection inside a transaction (§3.3).
    const rows = await this.txHost.tx.staff.findMany({
      where,
      select: SELECT,
      orderBy: orderBy(query.sort),
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.staff.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<StaffRecord | null> {
    const row = await this.txHost.tx.staff.findFirst({ where: { schoolId, id }, select: SELECT });
    return row && toRecord(row);
  }

  /** The row holding this CNIC hash, any status (the index is unique per school, R20). */
  async findByCnicHash(schoolId: SchoolId, cnicHash: string): Promise<StaffRecord | null> {
    const row = await this.txHost.tx.staff.findFirst({
      where: { schoolId, cnicHash },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** New rows are `active`. A CNIC already in the school fails staff_school_id_cnic_hash_key. */
  async create(schoolId: SchoolId, staff: NewStaff): Promise<bigint> {
    const row = await this.txHost.tx.staff.create({
      data: { schoolId, ...staff, status: 'active' },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Locks the row to the end of the transaction if it is still as read (same updated_at),
   * writing nothing visible. False when it changed since; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<StaffRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.staff.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** Plain attributes. The caller holds the row lock. */
  async update(schoolId: SchoolId, id: bigint, data: Partial<NewStaff>): Promise<void> {
    await this.txHost.tx.staff.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: { id: true },
    });
  }

  /** Status and its last-day marker (left_on only while `left`: CHECK staff_left_on_check). */
  async setStatus(
    schoolId: SchoolId,
    id: bigint,
    status: StaffStatus,
    leftOn: Date | null,
  ): Promise<void> {
    await this.txHost.tx.staff.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status, leftOn },
      select: { id: true },
    });
  }
}
