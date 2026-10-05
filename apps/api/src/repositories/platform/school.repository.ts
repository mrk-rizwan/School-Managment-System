import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus, SmsProviderChoice, WhatsAppProviderChoice } from '@asms/shared';
import type { CreatedSchoolRow } from '../../tenancy/school-id';
import {
  createdSchoolRow,
  principalIssueSchoolRow,
  type PrincipalIssueSchoolRow,
} from '../../tenancy/school-id.mint';
import type { Prisma } from '../generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from '../prisma';

/** The school row as the platform module sees it. */
export interface SchoolRecord {
  id: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
  /** Messaging knobs set by the platform (contracts/slice-9.md §6.1). */
  smsMonthlyCap: number;
  whatsappProvider: WhatsAppProviderChoice;
  smsProvider: SmsProviderChoice;
  createdAt: Date;
  updatedAt: Date;
}

export type SchoolSortField = 'name' | 'shortCode' | 'status' | 'createdAt';
/** A sort field, `-` prefixed for descending. */
export type SchoolSort = SchoolSortField | `-${SchoolSortField}`;

export interface SchoolListQuery {
  status?: SchoolStatus;
  /** Already trimmed and at least 2 characters (the DTO's job). */
  q?: string;
  sort: SchoolSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  name: true,
  shortCode: true,
  status: true,
  timezone: true,
  smsMonthlyCap: true,
  whatsappProvider: true,
  smsProvider: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SchoolSelect;

function orderBy(sort: SchoolSort): Prisma.SchoolOrderByWithRelationInput[] {
  // SchoolSort admits only the four field names, so the key is one of them.
  const primary: Partial<Record<SchoolSortField, Prisma.SortOrder>> = {
    [sort.replace(/^-/, '')]: sort.startsWith('-') ? 'desc' : 'asc',
  };
  // id ascending breaks ties so paging is stable.
  return [primary, { id: 'asc' }];
}

/**
 * The schools table (non-tenant, CLAUDE.md named exception 1). Importable only from
 * src/modules/platform/**. Writes that depend on a read are compare-and-set (changeStatus) or run
 * under lockIfUnchanged: a 0 / false result means the row changed since the read, and the caller
 * reads again.
 */
@Injectable()
export class SchoolRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(query: SchoolListQuery): Promise<{ rows: SchoolRecord[]; total: number }> {
    const where: Prisma.SchoolWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: escapeLike(query.q), mode: 'insensitive' } },
              { shortCode: { startsWith: escapeLike(query.q.toLowerCase()) } },
            ],
          }),
    };
    // Sequential, not Promise.all: one connection when called inside a transaction (§3.3).
    const rows = await this.txHost.tx.school.findMany({
      where,
      select: SELECT,
      orderBy: orderBy(query.sort),
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.school.count({ where });
    return { rows, total };
  }

  findById(id: bigint): Promise<SchoolRecord | null> {
    return this.txHost.tx.school.findUnique({ where: { id }, select: SELECT });
  }

  /**
   * New schools are always `trial` (the column default). The row comes back branded: it is the
   * only value SchoolId.fromPlatformSchool accepts.
   */
  async create(data: {
    name: string;
    shortCode: string;
    timezone: string;
  }): Promise<SchoolRecord & CreatedSchoolRow> {
    return createdSchoolRow(await this.txHost.tx.school.create({ data, select: SELECT }));
  }

  /**
   * Locks the row for the rest of the transaction, but only if it still holds every value of
   * `school` (as read by the caller), so the caller decides on current data under the lock. It
   * writes nothing visible: updated_at is set to the value it already has. False when the row
   * changed (or vanished) since the read; the caller reads again.
   */
  async lockIfUnchanged(school: SchoolRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.school.updateMany({
      where: {
        id: school.id,
        name: school.name,
        timezone: school.timezone,
        status: school.status,
        smsMonthlyCap: school.smsMonthlyCap,
        whatsappProvider: school.whatsappProvider,
        smsProvider: school.smsProvider,
        updatedAt: school.updatedAt,
      },
      data: { updatedAt: school.updatedAt },
    });
    return count === 1;
  }

  /**
   * Contract slice-2 §7: locks the school row for the rest of the transaction (an UPDATE holds its
   * row lock until commit, so touching updated_at is a SELECT ... FOR UPDATE without raw SQL) and
   * returns it as read under the lock, branded: the only other value fromPlatformSchool accepts.
   * Null if absent.
   */
  async lockForPrincipalIssue(
    id: bigint,
  ): Promise<(SchoolRecord & PrincipalIssueSchoolRow) | null> {
    const { count } = await this.txHost.tx.school.updateMany({
      where: { id },
      data: { updatedAt: new Date() },
    });
    if (count === 0) return null;
    const school = await this.findById(id);
    return school ? principalIssueSchoolRow(school) : null;
  }

  /** Plain attributes. The caller holds the row lock (lockIfUnchanged) and has checked status. */
  async update(
    id: bigint,
    data: {
      name?: string;
      timezone?: string;
      smsMonthlyCap?: number;
      whatsappProvider?: WhatsAppProviderChoice;
      smsProvider?: SmsProviderChoice;
    },
  ): Promise<void> {
    await this.txHost.tx.school.update({ where: { id }, data, select: { id: true } });
  }

  /** Sets `to` only if the status is still `from`. Returns rows changed (0 or 1). */
  async changeStatus(id: bigint, from: SchoolStatus, to: SchoolStatus): Promise<number> {
    const { count } = await this.txHost.tx.school.updateMany({
      where: { id, status: from },
      // R224: terminating stamps terminated_at (CHECK schools_terminated_at_check).
      data: { status: to, ...(to === 'terminated' ? { terminatedAt: new Date() } : {}) },
    });
    return count;
  }
}
