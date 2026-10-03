import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { ContactCapability, GuardianStatus, Prisma } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

// contracts/slice-5.md. The tenant table guardians. `cnic` is the field-encryption envelope and
// `cnicHash` its lookup HMAC; neither is ever decrypted or matched here, only stored and compared.

export interface GuardianRecord {
  id: bigint;
  fullName: string;
  /** Ciphertext (`v1:...`), AAD `schoolId|guardians|cnic`. */
  cnic: string | null;
  cnicHash: string | null;
  phone: string | null;
  email: string | null;
  contactCapability: ContactCapability;
  address: string | null;
  mergedIntoId: bigint | null;
  status: GuardianStatus;
  createdAt: Date;
  updatedAt: Date;
  /** The login linked to this guardian (users.guardian_id), if any. */
  userId: bigint | null;
}

export type GuardianSortField = 'fullName' | 'createdAt';
export type GuardianSort = GuardianSortField | `-${GuardianSortField}`;

export interface GuardianListQuery {
  status?: GuardianStatus;
  contactCapability?: ContactCapability;
  hasCnic?: boolean;
  hasPhone?: boolean;
  hasLogin?: boolean;
  /** Name contains (case-insensitive). Already trimmed and refused if it holds an identity number. */
  q?: string;
  /** Phone contains these digits (only set when q is a short digit run). */
  phoneDigits?: string;
  sort: GuardianSort;
  skip: number;
  take: number;
}

export interface GuardianWrite {
  fullName: string;
  cnic: string | null;
  cnicHash: string | null;
  phone: string | null;
  email: string | null;
  contactCapability: ContactCapability;
  address: string | null;
}

const SELECT = {
  id: true,
  fullName: true,
  cnic: true,
  cnicHash: true,
  phone: true,
  email: true,
  contactCapability: true,
  address: true,
  mergedIntoId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true } },
} satisfies Prisma.GuardianSelect;

type Row = Prisma.GuardianGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ user, ...row }: Row): GuardianRecord => ({ ...row, userId: user?.id ?? null });

function orderBy(sort: GuardianSort): Prisma.GuardianOrderByWithRelationInput[] {
  const direction: Prisma.SortOrder = sort.startsWith('-') ? 'desc' : 'asc';
  const primary: Prisma.GuardianOrderByWithRelationInput =
    sort.replace(/^-/, '') === 'createdAt' ? { createdAt: direction } : { fullName: direction };
  // id breaks ties so paging is stable.
  return [primary, { id: 'asc' }];
}

const presence = (present: boolean) => (present ? { not: null } : null);

@Injectable()
export class GuardianRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: GuardianListQuery,
  ): Promise<{ rows: GuardianRecord[]; total: number }> {
    const and: Prisma.GuardianWhereInput[] = [];
    if (query.status !== undefined) and.push({ status: query.status });
    if (query.contactCapability !== undefined) {
      and.push({ contactCapability: query.contactCapability });
    }
    if (query.hasCnic !== undefined) and.push({ cnicHash: presence(query.hasCnic) });
    if (query.hasPhone !== undefined) and.push({ phone: presence(query.hasPhone) });
    if (query.hasLogin !== undefined) {
      and.push(query.hasLogin ? { user: { isNot: null } } : { user: { is: null } });
    }
    if (query.q !== undefined) {
      const or: Prisma.GuardianWhereInput[] = [
        { fullName: { contains: escapeLike(query.q), mode: 'insensitive' } },
      ];
      if (query.phoneDigits !== undefined) or.push({ phone: { contains: query.phoneDigits } });
      and.push({ OR: or });
    }
    const where: Prisma.GuardianWhereInput = { schoolId, AND: and };
    // Sequential, not Promise.all: one connection inside a transaction (§3.3).
    const rows = await this.txHost.tx.guardian.findMany({
      where,
      select: SELECT,
      orderBy: orderBy(query.sort),
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.guardian.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<GuardianRecord | null> {
    const row = await this.txHost.tx.guardian.findFirst({
      where: { schoolId, id },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** Several rows by id, in no particular order; ids of other schools are simply absent. */
  async findByIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<GuardianRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: [...ids] } },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  /** The row holding this CNIC hash (live or merged; the index is unique per school). */
  async findByCnicHash(schoolId: SchoolId, cnicHash: string): Promise<GuardianRecord | null> {
    const row = await this.txHost.tx.guardian.findFirst({
      where: { schoolId, cnicHash },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** Rows with exactly this E.164 phone, by name then id, at most `take`. */
  async findByPhone(schoolId: SchoolId, phone: string, take: number): Promise<GuardianRecord[]> {
    const rows = await this.txHost.tx.guardian.findMany({
      where: { schoolId, phone },
      select: SELECT,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toRecord);
  }

  /** New rows are `active`. A second live CNIC fails guardians_school_id_cnic_hash_key. */
  async create(schoolId: SchoolId, data: GuardianWrite): Promise<GuardianRecord> {
    const row = await this.txHost.tx.guardian.create({
      data: { schoolId, ...data },
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * Locks the row for the rest of the transaction if it is still exactly as `row` was read
   * (same updated_at), writing nothing visible. False when it changed since; the caller reads
   * again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<GuardianRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.guardian.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** Plain attributes. The caller holds the row lock. */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: Partial<GuardianWrite>,
  ): Promise<GuardianRecord> {
    const row = await this.txHost.tx.guardian.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
    return toRecord(row);
  }
}
