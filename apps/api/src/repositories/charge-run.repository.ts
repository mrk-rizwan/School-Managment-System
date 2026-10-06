import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ChargeRunKind, ChargeRunStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Charge runs (tenant table charge_runs, phase-3-financial.md §3.7, R179, R252): one row per
// monthly generation (the 1st, every manual run, and a daily catch-up that inserted something)
// and per campaign generation. Never deleted; `queued -> running -> done | failed`, with
// `queued -> failed` for the stale sweep. At most one queued or running row per year, period and
// kind (charge_runs_period_key).

/** A class a run skipped, as stored (allowlisted keys, CHECK charge_runs_skipped_classes_check). */
export interface SkippedClass {
  classId: string;
  reason: string;
}

export interface ChargeRunRecord {
  id: bigint;
  academicYearId: bigint;
  period: string;
  kind: ChargeRunKind;
  campaignId: bigint | null;
  status: ChargeRunStatus;
  triggeredBy: bigint | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  studentsCharged: number;
  chargesInserted: number;
  chargesSkipped: number;
  skippedClasses: Prisma.JsonValue;
  regenerateVoided: boolean;
  errorCode: string | null;
}

const SELECT = {
  id: true,
  academicYearId: true,
  period: true,
  kind: true,
  campaignId: true,
  status: true,
  triggeredBy: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  studentsCharged: true,
  chargesInserted: true,
  chargesSkipped: true,
  skippedClasses: true,
  regenerateVoided: true,
  errorCode: true,
} satisfies Prisma.ChargeRunSelect;

export interface RunCounts {
  studentsCharged: number;
  chargesInserted: number;
  chargesSkipped: number;
  skippedClasses: SkippedClass[];
}

/** R252: a run queued this long, or running this long, is stale. */
export const STALE_QUEUED_MS = 10 * 60_000;
export const STALE_RUNNING_MS = 15 * 60_000;

@Injectable()
export class ChargeRunRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: { academicYearId?: bigint; period?: string; skip: number; take: number },
  ): Promise<{ rows: ChargeRunRecord[]; total: number }> {
    const where: Prisma.ChargeRunWhereInput = {
      schoolId,
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.period === undefined ? {} : { period: query.period }),
    };
    const rows = await this.txHost.tx.chargeRun.findMany({
      where,
      select: SELECT,
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.chargeRun.count({ where });
    return { rows, total };
  }

  findById(schoolId: SchoolId, id: bigint): Promise<ChargeRunRecord | null> {
    return this.txHost.tx.chargeRun.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** A queued or running run of this year (any kind, any period), oldest first. */
  findInProgress(schoolId: SchoolId, academicYearId: bigint): Promise<ChargeRunRecord | null> {
    return this.txHost.tx.chargeRun.findFirst({
      where: { schoolId, academicYearId, status: { in: ['queued', 'running'] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** The queued or running run of this year, period and kind (charge_runs_period_key). */
  findActive(
    schoolId: SchoolId,
    academicYearId: bigint,
    period: string,
    kind: ChargeRunKind,
  ): Promise<ChargeRunRecord | null> {
    return this.txHost.tx.chargeRun.findFirst({
      where: { schoolId, academicYearId, period, kind, status: { in: ['queued', 'running'] } },
      select: SELECT,
    });
  }

  createQueued(
    schoolId: SchoolId,
    data: {
      academicYearId: bigint;
      period: string;
      kind: ChargeRunKind;
      campaignId: bigint | null;
      triggeredBy: bigint | null;
      regenerateVoided: boolean;
      queuedAt: Date;
    },
  ): Promise<ChargeRunRecord> {
    return this.txHost.tx.chargeRun.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /**
   * A daily catch-up that inserted something is recorded after the fact (§4: a catch-up writes a
   * row only when it inserted something), straight as `done`.
   */
  createDone(
    schoolId: SchoolId,
    data: { academicYearId: bigint; period: string; startedAt: Date; finishedAt: Date } & RunCounts,
  ): Promise<ChargeRunRecord> {
    return this.txHost.tx.chargeRun.create({
      data: {
        schoolId,
        academicYearId: data.academicYearId,
        period: data.period,
        kind: 'monthly',
        status: 'done',
        queuedAt: data.startedAt,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
        studentsCharged: data.studentsCharged,
        chargesInserted: data.chargesInserted,
        chargesSkipped: data.chargesSkipped,
        skippedClasses: data.skippedClasses.map((c) => ({ classId: c.classId, reason: c.reason })),
      },
      select: SELECT,
    });
  }

  /** R105: the job's first statement. queued → running; false when it was not queued. */
  async claim(schoolId: SchoolId, id: bigint, now: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.chargeRun.updateMany({
      where: { schoolId, id, status: 'queued' },
      data: { status: 'running', startedAt: now },
    });
    return count === 1;
  }

  /** running → done with the counts; false when it was no longer running (the sweep failed it). */
  async finish(schoolId: SchoolId, id: bigint, counts: RunCounts, now: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.chargeRun.updateMany({
      where: { schoolId, id, status: 'running' },
      data: {
        status: 'done',
        finishedAt: now,
        studentsCharged: counts.studentsCharged,
        chargesInserted: counts.chargesInserted,
        chargesSkipped: counts.chargesSkipped,
        skippedClasses: counts.skippedClasses.map((c) => ({ classId: c.classId, reason: c.reason })),
      },
    });
    return count === 1;
  }

  /** queued | running → failed with a code. */
  async fail(schoolId: SchoolId, id: bigint, errorCode: string, now: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.chargeRun.updateMany({
      where: { schoolId, id, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', errorCode, finishedAt: now },
    });
    return count === 1;
  }

  /** Class names by id (a run's skipped classes). */
  async classNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id.toString(), r.name]));
  }

  /** R252: runs queued over 10 minutes or running over 15, with their campaign ids. */
  stale(schoolId: SchoolId, now: Date): Promise<{ id: bigint; campaignId: bigint | null }[]> {
    return this.txHost.tx.chargeRun.findMany({
      where: {
        schoolId,
        OR: [
          { status: 'queued', queuedAt: { lt: new Date(now.getTime() - STALE_QUEUED_MS) } },
          { status: 'running', startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
        ],
      },
      select: { id: true, campaignId: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
  }
}
