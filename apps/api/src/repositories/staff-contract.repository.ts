import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { DEFAULT_CONTRACT_WARNING_DAYS, type ContractType } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant table staff_contracts (phase-5-extended.md rule 35, §3.2 "Contracts", R318-R321;
// contracts/slice-39.md; migration 20261010090000_wave_s_events_contracts). A contract is never
// edited: the database freezes every column but the end group (set once, together) and the two
// warning stamps (each set once). One live (not ended) contract per staff member
// (staff_contracts_live_key). Importable only from src/modules/people/staff/** (eslint
// staffContractRepository).

export interface StaffContractDocument {
  objectKey: string;
  mime: string;
  sizeBytes: number;
}

export interface StaffContractRecord {
  id: bigint;
  staffId: bigint;
  staffName: string;
  staffStatus: string;
  type: ContractType;
  startsOn: Date;
  endsOn: Date | null;
  salaryStructureId: bigint | null;
  documentObjectKey: string | null;
  documentMime: string | null;
  documentSizeBytes: number | null;
  note: string | null;
  createdBy: bigint;
  createdByName: string | null;
  createdAt: Date;
  endedAt: Date | null;
  endedBy: bigint | null;
  endedByName: string | null;
  endReason: string | null;
  endedOn: Date | null;
  warned30At: Date | null;
  warned7At: Date | null;
}

export interface NewStaffContract {
  staffId: bigint;
  type: ContractType;
  startsOn: Date;
  endsOn: Date | null;
  salaryStructureId: bigint | null;
  document: StaffContractDocument | null;
  note: string | null;
  createdBy: bigint;
}

export interface ContractEnd {
  endedBy: bigint;
  reason: string;
  endedOn: Date;
  now: Date;
}

const SELECT = {
  id: true,
  staffId: true,
  type: true,
  startsOn: true,
  endsOn: true,
  salaryStructureId: true,
  documentObjectKey: true,
  documentMime: true,
  documentSizeBytes: true,
  note: true,
  createdBy: true,
  createdAt: true,
  endedAt: true,
  endedBy: true,
  endReason: true,
  endedOn: true,
  warned30At: true,
  warned7At: true,
  staff: { select: { fullName: true, status: true } },
  createdByUser: { select: { staff: { select: { fullName: true } } } },
  endedByUser: { select: { staff: { select: { fullName: true } } } },
} as const satisfies Prisma.StaffContractSelect;

type Row = Prisma.StaffContractGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ staff, createdByUser, endedByUser, ...row }: Row): StaffContractRecord => ({
  ...row,
  staffName: staff.fullName,
  staffStatus: staff.status,
  createdByName: createdByUser.staff?.fullName ?? null,
  endedByName: endedByUser?.staff?.fullName ?? null,
});

@Injectable()
export class StaffContractRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A staff member's contracts, newest start first (GET /staff/:id/contracts, `-startsOn`). */
  async listForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: StaffContractRecord[]; total: number }> {
    const where = { schoolId, staffId };
    const rows = await this.txHost.tx.staffContract.findMany({
      where,
      select: SELECT,
      orderBy: [{ startsOn: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.staffContract.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /**
   * Live contracts with an end on or before `endsBy` (expired, not ended, included), soonest end
   * first: the dashboard tile and its list (R320), and the staff report's "ending within" (R337).
   */
  async liveEndingBy(
    schoolId: SchoolId,
    endsBy: Date,
    page: { skip: number; take: number },
  ): Promise<{ rows: StaffContractRecord[]; total: number }> {
    const where = { schoolId, endedAt: null, endsOn: { not: null, lte: endsBy } };
    const rows = await this.txHost.tx.staffContract.findMany({
      where,
      select: SELECT,
      orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.staffContract.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<StaffContractRecord | null> {
    const row = await this.txHost.tx.staffContract.findFirst({ where: { schoolId, id }, select: SELECT });
    return row && toRecord(row);
  }

  /** The staff member's live (not ended) contract, if any; at most one (staff_contracts_live_key). */
  async findLive(schoolId: SchoolId, staffId: bigint): Promise<StaffContractRecord | null> {
    const row = await this.txHost.tx.staffContract.findFirst({
      where: { schoolId, staffId, endedAt: null },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  async create(schoolId: SchoolId, contract: NewStaffContract): Promise<bigint> {
    const { document, ...rest } = contract;
    const row = await this.txHost.tx.staffContract.create({
      data: {
        schoolId,
        ...rest,
        documentObjectKey: document?.objectKey ?? null,
        documentMime: document?.mime ?? null,
        documentSizeBytes: document?.sizeBytes ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Sets the end group on a live contract; 0 when it has already ended (a race loser). */
  async end(schoolId: SchoolId, id: bigint, end: ContractEnd): Promise<number> {
    const { count } = await this.txHost.tx.staffContract.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endedAt: end.now, endedBy: end.endedBy, endReason: end.reason, endedOn: end.endedOn },
    });
    return count;
  }

  /**
   * Live contracts with an end between `from` and `to` (inclusive) still lacking the given stamp:
   * the expiry job's candidates (R319). Bounded by the school's staff (one live each).
   */
  async unwarned(
    schoolId: SchoolId,
    stamp: 'warned30At' | 'warned7At',
    from: Date,
    to: Date,
  ): Promise<StaffContractRecord[]> {
    const rows = await this.txHost.tx.staffContract.findMany({
      where: {
        schoolId,
        endedAt: null,
        endsOn: { gte: from, lte: to },
        ...(stamp === 'warned30At' ? { warned30At: null } : { warned7At: null }),
      },
      select: SELECT,
      orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRecord);
  }

  /** Sets one warning stamp once; 0 when it was set meanwhile or the contract ended. */
  async stamp(schoolId: SchoolId, id: bigint, stamp: 'warned30At' | 'warned7At', now: Date): Promise<number> {
    const { count } = await this.txHost.tx.staffContract.updateMany({
      where: { schoolId, id, endedAt: null, ...(stamp === 'warned30At' ? { warned30At: null } : { warned7At: null }) },
      data: stamp === 'warned30At' ? { warned30At: now } : { warned7At: now },
    });
    return count;
  }

  /** `school_settings.contract_warning_days` (rule 35 *default* 30), or the default without a row. */
  async warningDays(schoolId: SchoolId): Promise<number> {
    const row = await this.txHost.tx.schoolSettings.findFirst({
      where: { schoolId },
      select: { contractWarningDays: true },
    });
    return row?.contractWarningDays ?? DEFAULT_CONTRACT_WARNING_DAYS;
  }
}
