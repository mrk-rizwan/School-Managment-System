import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../../tenancy/school-id';
import type { PrismaTxAdapter } from '../prisma';

// platform_school_metrics (named exception 6, widened in Phase 3; §3.7): one integer per school per
// day, the platform's only window onto a school's size. Written only by the per-school rollup
// (src/jobs/school-metrics-rollup.ts, inside runAsSchool, with the school's SchoolId); read only by
// the billing module and src/jobs/platform-billing.ts (eslint.config.mjs, billingRepositories).

export interface MetricsRecord {
  schoolId: bigint;
  day: Date;
  activeStudents: number;
}

const SELECT = { schoolId: true, day: true, activeStudents: true } as const;

@Injectable()
export class SchoolMetricsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The rollup's write: the day's count, rewritten by a re-run of the same day. */
  async upsert(schoolId: SchoolId, day: Date, activeStudents: number, computedAt: Date): Promise<void> {
    await this.txHost.tx.platformSchoolMetric.upsert({
      where: { schoolId_day: { schoolId, day } },
      create: { schoolId, day, activeStudents, computedAt },
      update: { activeStudents, computedAt },
      select: { id: true },
    });
  }

  /** The school's latest row on or before `onOrBefore`, no earlier than `notBefore`; null when none. */
  latest(schoolId: bigint, notBefore: Date, onOrBefore: Date): Promise<MetricsRecord | null> {
    return this.txHost.tx.platformSchoolMetric.findFirst({
      where: { schoolId, day: { gte: notBefore, lte: onOrBefore } },
      select: SELECT,
      orderBy: { day: 'desc' },
    });
  }

  /**
   * latest() for every school with a row in the window, keyed by school id: one read for the
   * monthly run (at most schools x 8 rows).
   */
  async latestInWindow(notBefore: Date, onOrBefore: Date): Promise<Map<bigint, MetricsRecord>> {
    const latest = new Map<bigint, MetricsRecord>();
    const rows = await this.txHost.tx.platformSchoolMetric.findMany({
      where: { day: { gte: notBefore, lte: onOrBefore } },
      select: SELECT,
      orderBy: [{ schoolId: 'asc' }, { day: 'desc' }],
    });
    for (const row of rows) if (!latest.has(row.schoolId)) latest.set(row.schoolId, row);
    return latest;
  }

  /** The school's most recent row of any age (the console's billing tab). */
  mostRecent(schoolId: bigint): Promise<MetricsRecord | null> {
    return this.txHost.tx.platformSchoolMetric.findFirst({
      where: { schoolId },
      select: SELECT,
      orderBy: { day: 'desc' },
    });
  }
}
