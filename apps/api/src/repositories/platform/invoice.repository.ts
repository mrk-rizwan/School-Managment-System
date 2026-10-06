import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { InvoiceStatus } from '@asms/shared';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';

// platform_invoices (non-tenant, R220, R221): the platform's monthly invoice to a school. One
// non-void invoice per school per month (platform_invoices_month_key); numbered gaplessly from
// platform_settings.invoice_counter; `issued -> paid | void`; overdue_at and
// suspension_eligible_at are stamped once by the daily run. Importable only from
// src/modules/platform/billing/** and src/jobs/platform-billing.ts.

export interface InvoiceRecord {
  id: bigint;
  schoolId: bigint;
  schoolName: string;
  invoiceNo: string;
  yearMonth: string;
  planId: bigint;
  planName: string;
  studentCount: number;
  amount: number;
  dueOn: Date;
  status: InvoiceStatus;
  issuedAt: Date;
  overdueAt: Date | null;
  suspensionEligibleAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export type InvoiceSort = '-issuedAt' | 'dueOn';

export interface InvoiceListQuery {
  status?: InvoiceStatus;
  schoolId?: bigint;
  yearMonth?: string;
  suspensionEligible?: boolean;
  sort: InvoiceSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  schoolId: true,
  invoiceNo: true,
  yearMonth: true,
  planId: true,
  studentCount: true,
  amount: true,
  dueOn: true,
  status: true,
  issuedAt: true,
  overdueAt: true,
  suspensionEligibleAt: true,
  paidAt: true,
  voidedAt: true,
  voidReason: true,
} satisfies Prisma.PlatformInvoiceSelect;

type Row = Prisma.PlatformInvoiceGetPayload<{ select: typeof SELECT }>;

/** R221: eligible = stamped and still unpaid. */
const ELIGIBLE: Prisma.PlatformInvoiceWhereInput = {
  status: 'issued',
  suspensionEligibleAt: { not: null },
};

@Injectable()
export class InvoiceRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The rows with their school and plan names: two reads for the whole page, not a relation
   * select (the query guard refuses a relation on a non-tenant model).
   */
  private async withNames(rows: readonly Row[]): Promise<InvoiceRecord[]> {
    if (rows.length === 0) return [];
    const schools = await this.txHost.tx.school.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.schoolId))] } },
      select: { id: true, name: true },
    });
    const plans = await this.txHost.tx.platformPlan.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.planId))] } },
      select: { id: true, name: true },
    });
    const schoolName = new Map(schools.map((x) => [x.id, x.name]));
    const planName = new Map(plans.map((x) => [x.id, x.name]));
    return rows.map((row) => ({
      ...row,
      schoolName: schoolName.get(row.schoolId) ?? '',
      planName: planName.get(row.planId) ?? '',
    }));
  }

  private async one(row: Row | null): Promise<InvoiceRecord | null> {
    return row === null ? null : ((await this.withNames([row]))[0] ?? null);
  }

  async list(query: InvoiceListQuery): Promise<{ rows: InvoiceRecord[]; total: number }> {
    const where: Prisma.PlatformInvoiceWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.schoolId === undefined ? {} : { schoolId: query.schoolId }),
      ...(query.yearMonth === undefined ? {} : { yearMonth: query.yearMonth }),
      ...(query.suspensionEligible === undefined
        ? {}
        : query.suspensionEligible
          ? { AND: [ELIGIBLE] }
          : { NOT: [ELIGIBLE] }),
    };
    const orderBy: Prisma.PlatformInvoiceOrderByWithRelationInput[] =
      query.sort === 'dueOn'
        ? [{ dueOn: 'asc' }, { id: 'asc' }]
        : [{ issuedAt: 'desc' }, { id: 'desc' }];
    const rows = await this.txHost.tx.platformInvoice.findMany({
      where,
      select: SELECT,
      orderBy,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.platformInvoice.count({ where });
    return { rows: await this.withNames(rows), total };
  }

  async findById(id: bigint): Promise<InvoiceRecord | null> {
    return this.one(await this.txHost.tx.platformInvoice.findFirst({ where: { id }, select: SELECT }));
  }

  /** The school's non-void invoice for the month (at most one, platform_invoices_month_key). */
  async findLiveForMonth(schoolId: bigint, yearMonth: string): Promise<InvoiceRecord | null> {
    const row = await this.txHost.tx.platformInvoice.findFirst({
      where: { schoolId, yearMonth, status: { not: 'void' } },
      select: SELECT,
    });
    return this.one(row);
  }

  /** The school's latest `take` invoices, newest month first (the console's billing tab). */
  async lastForSchool(schoolId: bigint, take: number): Promise<InvoiceRecord[]> {
    const rows = await this.txHost.tx.platformInvoice.findMany({
      where: { schoolId },
      select: SELECT,
      orderBy: [{ yearMonth: 'desc' }, { id: 'desc' }],
      take,
    });
    return this.withNames(rows);
  }

  /**
   * The next invoice number: `UPDATE platform_settings SET invoice_counter = invoice_counter + 1
   * RETURNING`. The row stays locked until the transaction ends, so numbers are issued in commit
   * order with no gap (a rolled-back issue gives its number back). Call it last in the issuing
   * transaction (lock order: school, plan, subscription, counter).
   */
  async nextNumber(): Promise<number> {
    const [row] = await this.txHost.tx.platformSettings.updateManyAndReturn({
      where: { id: 1n },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true },
    });
    if (!row) throw new Error('platform_settings row missing (seeded by migration)');
    return row.invoiceCounter;
  }

  async create(data: {
    schoolId: bigint;
    invoiceNo: string;
    yearMonth: string;
    planId: bigint;
    studentCount: number;
    amount: number;
    dueOn: Date;
    /** A free plan's invoice is issued paid (platform_payments.amount > 0 cannot record it). */
    paidAt: Date | null;
  }): Promise<InvoiceRecord> {
    const { paidAt, ...rest } = data;
    const row = await this.txHost.tx.platformInvoice.create({
      data: { ...rest, ...(paidAt === null ? {} : { status: 'paid', paidAt }) },
      select: SELECT,
    });
    const [record] = await this.withNames([row]);
    if (!record) throw new Error('unreachable: one row in, one record out');
    return record;
  }

  /** issued -> paid; 0 when it was not issued. */
  async markPaid(id: bigint, paidAt: Date): Promise<number> {
    const { count } = await this.txHost.tx.platformInvoice.updateMany({
      where: { id, status: 'issued' },
      data: { status: 'paid', paidAt },
    });
    return count;
  }

  /** issued -> void; 0 when it was not issued. */
  async void(id: bigint, by: bigint, reason: string): Promise<number> {
    const { count } = await this.txHost.tx.platformInvoice.updateMany({
      where: { id, status: 'issued' },
      data: { status: 'void', voidedAt: new Date(), voidedBy: by, voidReason: reason },
    });
    return count;
  }

  /** R221: every issued invoice whose due date has passed, stamped once. Returns rows stamped. */
  async stampOverdue(today: Date, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.platformInvoice.updateMany({
      where: { status: 'issued', overdueAt: null, dueOn: { lt: today } },
      data: { overdueAt: now },
    });
    return count;
  }

  /** R221: every issued invoice due before `dueBefore` (today - grace), stamped once. */
  async stampSuspensionEligible(dueBefore: Date, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.platformInvoice.updateMany({
      where: { status: 'issued', suspensionEligibleAt: null, dueOn: { lt: dueBefore } },
      data: { suspensionEligibleAt: now },
    });
    return count;
  }
}
