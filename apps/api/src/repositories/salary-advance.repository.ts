import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AdvanceStatus, PaymentMethod } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant table salary_advances (phase-3-financial.md §4 "Payroll", slice 25, R215, R235,
// R247). Never deleted. recovered_amount moves only through salary_advance_recoveries (trigger
// salary_advance_recoveries_apply, under the advance's row lock); the advance turns recovered when
// fully repaid. Nobody grants or writes off their own (salary_advances_not_self, no exception).

export interface SalaryAdvanceRecord {
  id: bigint;
  staffId: bigint;
  staffName: string;
  amount: number;
  grantedOn: Date;
  recoverFrom: string;
  instalmentAmount: number;
  approvedBy: bigint;
  paidMethod: PaymentMethod;
  paidReference: string | null;
  expenseId: bigint | null;
  recoveredAmount: number;
  status: AdvanceStatus;
  writtenOffAt: Date | null;
  writtenOffBy: bigint | null;
  writeOffReason: string | null;
  createdAt: Date;
}

export interface NewSalaryAdvance {
  staffId: bigint;
  amount: number;
  grantedOn: Date;
  recoverFrom: string;
  instalmentAmount: number;
  approvedBy: bigint;
  paidMethod: PaymentMethod;
  paidReference: string | null;
  expenseId: bigint | null;
}

export interface SalaryAdvanceListQuery {
  staffId?: bigint;
  status?: AdvanceStatus;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  staffId: true,
  amount: true,
  grantedOn: true,
  recoverFrom: true,
  instalmentAmount: true,
  approvedBy: true,
  paidMethod: true,
  paidReference: true,
  expenseId: true,
  recoveredAmount: true,
  status: true,
  writtenOffAt: true,
  writtenOffBy: true,
  writeOffReason: true,
  createdAt: true,
  staff: { select: { fullName: true } },
} as const satisfies Prisma.SalaryAdvanceSelect;

type Row = Prisma.SalaryAdvanceGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ staff, ...row }: Row): SalaryAdvanceRecord => ({ ...row, staffName: staff.fullName });

@Injectable()
export class SalaryAdvanceRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Newest grant first. */
  async list(schoolId: SchoolId, query: SalaryAdvanceListQuery): Promise<{ rows: SalaryAdvanceRecord[]; total: number }> {
    const where: Prisma.SalaryAdvanceWhereInput = {
      schoolId,
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const rows = await this.txHost.tx.salaryAdvance.findMany({
      where,
      select: SELECT,
      orderBy: [{ grantedOn: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.salaryAdvance.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<SalaryAdvanceRecord | null> {
    const row = await this.txHost.tx.salaryAdvance.findFirst({ where: { schoolId, id }, select: SELECT });
    return row === null ? null : toRecord(row);
  }

  async create(schoolId: SchoolId, data: NewSalaryAdvance): Promise<bigint> {
    const row = await this.txHost.tx.salaryAdvance.create({ data: { schoolId, ...data }, select: { id: true } });
    return row.id;
  }

  /** Writes off an open advance; 0 when it is no longer open. */
  async writeOff(schoolId: SchoolId, id: bigint, by: bigint, at: Date, reason: string): Promise<number> {
    const { count } = await this.txHost.tx.salaryAdvance.updateMany({
      where: { schoolId, id, status: 'open' },
      data: { status: 'written_off', writtenOffAt: at, writtenOffBy: by, writeOffReason: reason },
    });
    return count;
  }
}
