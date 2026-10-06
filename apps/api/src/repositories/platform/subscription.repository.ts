import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';

// platform_subscriptions (non-tenant, R220, R223): a school's plan over time, the history of its
// tiers. One live row per school (partial unique platform_subscriptions_live_key); only ended_on
// moves, once. Importable only from src/modules/platform/billing/** and src/jobs/platform-billing.ts.

export interface SubscriptionRecord {
  id: bigint;
  schoolId: bigint;
  planId: bigint;
  planName: string;
  startedOn: Date;
  endedOn: Date | null;
  pinned: boolean;
  assignedBy: bigint | null;
  reason: string | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  schoolId: true,
  planId: true,
  startedOn: true,
  endedOn: true,
  pinned: true,
  assignedBy: true,
  reason: true,
  createdAt: true,
} satisfies Prisma.PlatformSubscriptionSelect;

type Row = Prisma.PlatformSubscriptionGetPayload<{ select: typeof SELECT }>;

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The row with its plan's name. A second read, not a relation select: the query guard refuses
   * a relation on a non-tenant model (a platform row is never a path into other rows).
   */
  private async toRecord(row: Row): Promise<SubscriptionRecord> {
    const plan = await this.txHost.tx.platformPlan.findFirst({ where: { id: row.planId }, select: { name: true } });
    if (!plan) throw new Error('platform_subscriptions.plan_id without its plan');
    return { ...row, planName: plan.name };
  }

  /** The school's live subscription (ended_on null), or null. */
  async findLive(schoolId: bigint): Promise<SubscriptionRecord | null> {
    const row = await this.txHost.tx.platformSubscription.findFirst({
      where: { schoolId, endedOn: null },
      select: SELECT,
    });
    return row ? this.toRecord(row) : null;
  }

  /** PLAN_IN_USE: whether a live subscription points at the plan. */
  async anyLiveOnPlan(planId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.platformSubscription.findFirst({
      where: { planId, endedOn: null },
      select: { id: true },
    });
    return row !== null;
  }

  async create(data: {
    schoolId: bigint;
    planId: bigint;
    startedOn: Date;
    pinned: boolean;
    assignedBy: bigint | null;
    reason: string | null;
  }): Promise<SubscriptionRecord> {
    return this.toRecord(await this.txHost.tx.platformSubscription.create({ data, select: SELECT }));
  }

  /** Ends a live row; 0 when it was already ended (a concurrent writer). */
  async end(id: bigint, endedOn: Date): Promise<number> {
    const { count } = await this.txHost.tx.platformSubscription.updateMany({
      where: { id, endedOn: null },
      data: { endedOn },
    });
    return count;
  }
}
