import { DEFAULT_TIMEZONE } from '@asms/shared';
import type { InvoiceRecord } from '../../../repositories/platform/invoice.repository';
import type { PlanRecord } from '../../../repositories/platform/plan.repository';
import type { SubscriptionRecord } from '../../../repositories/platform/subscription.repository';
import type { InvoiceDto, PlanDto, SubscriptionDto } from './billing.dto';

/** A DATE value (UTC midnight) as `YYYY-MM-DD`. */
export const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/** `YYYY-MM-DD` as a DATE value. */
export const fromDateString = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * The platform's calendar: Asia/Karachi (every school's assumed zone, CLAUDE.md "Assumed unless
 * corrected"). Invoices, due dates and the billing run's days are read in it.
 */
export const PLATFORM_TIMEZONE = DEFAULT_TIMEZONE;

export const toPlanDto = (plan: PlanRecord): PlanDto => ({
  id: plan.id.toString(),
  name: plan.name,
  minStudents: plan.minStudents,
  maxStudents: plan.maxStudents,
  monthlyPrice: plan.monthlyPrice,
  smsAllowance: plan.smsAllowance,
  status: plan.status,
  archivedAt: plan.archivedAt,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

export const toSubscriptionDto = (row: SubscriptionRecord): SubscriptionDto => ({
  id: row.id.toString(),
  schoolId: row.schoolId.toString(),
  planId: row.planId.toString(),
  planName: row.planName,
  startedOn: toDateString(row.startedOn),
  endedOn: row.endedOn === null ? null : toDateString(row.endedOn),
  pinned: row.pinned,
  assignedByPlatform: row.assignedBy !== null,
  reason: row.reason,
  createdAt: row.createdAt,
});

export const toInvoiceDto = (row: InvoiceRecord): InvoiceDto => ({
  id: row.id.toString(),
  invoiceNo: row.invoiceNo,
  schoolId: row.schoolId.toString(),
  schoolName: row.schoolName,
  yearMonth: row.yearMonth,
  planName: row.planName,
  studentCount: row.studentCount,
  amount: row.amount,
  dueOn: toDateString(row.dueOn),
  status: row.status,
  issuedAt: row.issuedAt,
  overdueAt: row.overdueAt,
  suspensionEligibleAt: row.suspensionEligibleAt,
  paidAt: row.paidAt,
  voidedAt: row.voidedAt,
});
