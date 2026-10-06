import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { InvoiceStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The school's read of its own platform bill (phase-3-financial.md A18), the OwnSchoolRepository
// pattern: every statement's school predicate is `school_id = schoolId`, so a school reads nothing
// but its own invoices and its own live plan. Importable only from src/jobs/billing-notices.ts and
// src/modules/school-settings/billing-status.controller.ts (eslint.config.mjs,
// ownInvoicesRepository). It never writes.

export interface OwnInvoiceRecord {
  id: bigint;
  invoiceNo: string;
  yearMonth: string;
  amount: number;
  dueOn: Date;
  status: InvoiceStatus;
  issuedAt: Date;
  overdueAt: Date | null;
  suspensionEligibleAt: Date | null;
}

export interface OwnPlanRecord {
  name: string;
  smsAllowance: number;
}

const SELECT = {
  id: true,
  invoiceNo: true,
  yearMonth: true,
  amount: true,
  dueOn: true,
  status: true,
  issuedAt: true,
  overdueAt: true,
  suspensionEligibleAt: true,
} as const;

/** Unpaid invoices are few (one a month until paid); a bound keeps the read finite regardless. */
const UNPAID_MAX = 24;

@Injectable()
export class OwnInvoicesRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The plan of the school's live subscription; null when it has none. */
  async livePlan(schoolId: SchoolId): Promise<OwnPlanRecord | null> {
    const live = await this.txHost.tx.platformSubscription.findFirst({
      where: { schoolId, endedOn: null },
      select: { planId: true },
    });
    if (!live) return null;
    // The plan row of the school's own subscription (a plan carries no school; the guard refuses
    // a relation select on a non-tenant model, so it is its own read).
    return this.txHost.tx.platformPlan.findFirst({
      where: { id: live.planId },
      select: { name: true, smsAllowance: true },
    });
  }

  /** The school's latest non-void invoice (by month billed); null when none. */
  latest(schoolId: SchoolId): Promise<OwnInvoiceRecord | null> {
    return this.txHost.tx.platformInvoice.findFirst({
      where: { schoolId, status: { not: 'void' } },
      select: SELECT,
      orderBy: [{ yearMonth: 'desc' }, { id: 'desc' }],
    });
  }

  /** The school's unpaid (issued) invoices, oldest month first. */
  unpaid(schoolId: SchoolId): Promise<OwnInvoiceRecord[]> {
    return this.txHost.tx.platformInvoice.findMany({
      where: { schoolId, status: 'issued' },
      select: SELECT,
      orderBy: [{ yearMonth: 'asc' }, { id: 'asc' }],
      take: UNPAID_MAX,
    });
  }
}
