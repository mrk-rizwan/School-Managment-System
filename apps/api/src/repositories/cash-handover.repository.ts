import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { HandoverStatus, ShortfallResolution } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Cash handovers (tenant table cash_handovers, phase-3-financial.md §3.4, R193, R194). One
// collector's custody gathered for counting: expected_amount and payment_count stored at open
// (checked against the gathered payments at commit, cash_handovers_expected_matches); confirmed
// once by a third user (CHECK cash_handovers_not_self_check); a shortfall resolved once. Never
// deleted.

export interface HandoverRecord {
  id: bigint;
  collectorUserId: bigint;
  collectorStaffId: bigint;
  openedBy: bigint;
  onBehalf: boolean;
  expectedAmount: number;
  paymentCount: number;
  openedAt: Date;
  note: string | null;
  status: HandoverStatus;
  confirmedBy: bigint | null;
  confirmedAt: Date | null;
  countedAmount: number | null;
  shortfallAmount: number | null;
  surplusAmount: number | null;
  confirmNote: string | null;
  shortfallResolution: ShortfallResolution | null;
  shortfallResolvedAt: Date | null;
  shortfallResolvedBy: bigint | null;
  shortfallResolutionReason: string | null;
  shortfallExpenseId: bigint | null;
  shortfallReversalId: bigint | null;
}

const SELECT = {
  id: true,
  collectorUserId: true,
  collectorStaffId: true,
  openedBy: true,
  onBehalf: true,
  expectedAmount: true,
  paymentCount: true,
  openedAt: true,
  note: true,
  status: true,
  confirmedBy: true,
  confirmedAt: true,
  countedAmount: true,
  shortfallAmount: true,
  surplusAmount: true,
  confirmNote: true,
  shortfallResolution: true,
  shortfallResolvedAt: true,
  shortfallResolvedBy: true,
  shortfallResolutionReason: true,
  shortfallExpenseId: true,
  shortfallReversalId: true,
} satisfies Prisma.CashHandoverSelect;

export interface HandoverListQuery {
  status?: HandoverStatus;
  collectorUserId?: bigint;
  /** Confirmed with a shortfall nobody has resolved yet (the principal's banner). */
  unresolvedShortfall?: boolean;
  skip: number;
  take: number;
}

@Injectable()
export class CashHandoverRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(
    schoolId: SchoolId,
    data: {
      collectorUserId: bigint;
      collectorStaffId: bigint;
      openedBy: bigint;
      expectedAmount: number;
      paymentCount: number;
      note: string | null;
    },
    now: Date,
  ): Promise<HandoverRecord> {
    return this.txHost.tx.cashHandover.create({
      data: { schoolId, ...data, onBehalf: data.openedBy !== data.collectorUserId, openedAt: now },
      select: SELECT,
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<HandoverRecord | null> {
    return this.txHost.tx.cashHandover.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  findOpenFor(schoolId: SchoolId, collectorUserId: bigint): Promise<HandoverRecord | null> {
    return this.txHost.tx.cashHandover.findFirst({ where: { schoolId, collectorUserId, status: 'open' }, select: SELECT });
  }

  async list(schoolId: SchoolId, query: HandoverListQuery): Promise<{ rows: HandoverRecord[]; total: number }> {
    const where: Prisma.CashHandoverWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.collectorUserId === undefined ? {} : { collectorUserId: query.collectorUserId }),
      ...(query.unresolvedShortfall ? { status: 'confirmed', shortfallAmount: { gt: 0 }, shortfallResolution: null } : {}),
    };
    const rows = await this.txHost.tx.cashHandover.findMany({
      where,
      select: SELECT,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.cashHandover.count({ where });
    return { rows, total };
  }

  /** open → confirmed, all of the confirmation at once; 0 when it moved meanwhile. */
  async confirm(
    schoolId: SchoolId,
    id: bigint,
    c: { by: bigint; countedAmount: number; shortfallAmount: number; surplusAmount: number; note: string | null },
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.cashHandover.updateMany({
      where: { schoolId, id, status: 'open' },
      data: {
        status: 'confirmed',
        confirmedBy: c.by,
        confirmedAt: now,
        countedAmount: c.countedAmount,
        shortfallAmount: c.shortfallAmount,
        surplusAmount: c.surplusAmount,
        confirmNote: c.note,
      },
    });
    return count;
  }

  /** A confirmed shortfall, resolved once; 0 when it was resolved meanwhile. */
  async resolve(
    schoolId: SchoolId,
    id: bigint,
    r: { resolution: ShortfallResolution; by: bigint; reason: string; expenseId: bigint | null; reversalId: bigint | null },
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.cashHandover.updateMany({
      where: { schoolId, id, status: 'confirmed', shortfallAmount: { gt: 0 }, shortfallResolution: null },
      data: {
        shortfallResolution: r.resolution,
        shortfallResolvedAt: now,
        shortfallResolvedBy: r.by,
        shortfallResolutionReason: r.reason,
        shortfallExpenseId: r.expenseId,
        shortfallReversalId: r.reversalId,
      },
    });
    return count;
  }
}
