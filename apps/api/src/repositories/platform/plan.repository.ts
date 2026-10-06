import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PlanStatus } from '@asms/shared';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';

// platform_plans (non-tenant, R219): the price tiers. Bands are frozen (trigger); name, price and
// allowance change until the plan is archived; active bands never overlap (EXCLUDE
// platform_plans_band_excl). Importable only from src/modules/platform/billing/** and
// src/jobs/platform-billing.ts (eslint.config.mjs, billingRepositories).

export interface PlanRecord {
  id: bigint;
  name: string;
  minStudents: number;
  maxStudents: number | null;
  monthlyPrice: number;
  smsAllowance: number;
  status: PlanStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  minStudents: true,
  maxStudents: true,
  monthlyPrice: true,
  smsAllowance: true,
  status: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlatformPlanSelect;

@Injectable()
export class PlanRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(query: {
    status?: PlanStatus;
    skip: number;
    take: number;
  }): Promise<{ rows: PlanRecord[]; total: number }> {
    const where: Prisma.PlatformPlanWhereInput =
      query.status === undefined ? {} : { status: query.status };
    const rows = await this.txHost.tx.platformPlan.findMany({
      where,
      select: SELECT,
      orderBy: [{ status: 'asc' }, { minStudents: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.platformPlan.count({ where });
    return { rows, total };
  }

  /** Every active plan, lowest band first: the input of tierFor (bounded by the band space). */
  listActive(): Promise<PlanRecord[]> {
    return this.txHost.tx.platformPlan.findMany({
      where: { status: 'active' },
      select: SELECT,
      orderBy: [{ minStudents: 'asc' }, { id: 'asc' }],
    });
  }

  findById(id: bigint): Promise<PlanRecord | null> {
    return this.txHost.tx.platformPlan.findFirst({ where: { id }, select: SELECT });
  }

  /** An active plan whose band (inclusive, null = unbounded) meets [min, max]; null when none. */
  findOverlappingActive(min: number, max: number | null): Promise<PlanRecord | null> {
    return this.txHost.tx.platformPlan.findFirst({
      where: {
        status: 'active',
        OR: [{ maxStudents: null }, { maxStudents: { gte: min } }],
        ...(max === null ? {} : { minStudents: { lte: max } }),
      },
      select: SELECT,
      orderBy: { minStudents: 'asc' },
    });
  }

  /**
   * Locks the plan row for the rest of the transaction (a no-op UPDATE) and returns it as read
   * under the lock; null when absent. Archive and every subscription write take it, so a plan is
   * never archived while a subscription is being written onto it.
   */
  async lock(id: bigint): Promise<PlanRecord | null> {
    const [row] = await this.txHost.tx.platformPlan.updateManyAndReturn({
      where: { id },
      data: { id },
      select: SELECT,
    });
    return row ?? null;
  }

  create(data: {
    name: string;
    minStudents: number;
    maxStudents: number | null;
    monthlyPrice: number;
    smsAllowance: number;
  }): Promise<PlanRecord> {
    return this.txHost.tx.platformPlan.create({ data, select: SELECT });
  }

  /** Name, price, allowance. The caller holds the lock and has checked the plan is active. */
  update(
    id: bigint,
    data: { name?: string; monthlyPrice?: number; smsAllowance?: number },
  ): Promise<PlanRecord> {
    return this.txHost.tx.platformPlan.update({ where: { id }, data, select: SELECT });
  }

  /** active -> archived; 0 when it was not active. */
  async archive(id: bigint): Promise<number> {
    const { count } = await this.txHost.tx.platformPlan.updateMany({
      where: { id, status: 'active' },
      data: { status: 'archived', archivedAt: new Date() },
    });
    return count;
  }
}
