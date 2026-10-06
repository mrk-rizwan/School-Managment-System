'use client';

import type { InvoiceStatus } from '@asms/shared';
import { Badge } from '@/components/ui/badge';

// Pieces shared by the plans, invoices and school billing screens (contracts/slice-26.md).

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
};

/** An unpaid invoice shows how far along it is: issued, overdue, or eligible for suspension. */
export function InvoiceStatusBadge({
  invoice,
}: {
  invoice: { status: InvoiceStatus; overdueAt: string | null; suspensionEligibleAt: string | null };
}) {
  if (invoice.status === 'issued' && invoice.suspensionEligibleAt) {
    return <Badge variant="destructive">Eligible for suspension</Badge>;
  }
  if (invoice.status === 'issued' && invoice.overdueAt) return <Badge variant="destructive">Overdue</Badge>;
  const variant = invoice.status === 'paid' ? 'secondary' : invoice.status === 'void' ? 'ghost' : 'outline';
  return <Badge variant={variant}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>;
}

/** `2026-10` as `October 2026`. */
export function formatYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1)),
  );
}

/** The band a plan covers, `0–150 students` or `501+ students`. */
export function formatBand(plan: { minStudents: number; maxStudents: number | null }): string {
  const n = (v: number) => v.toLocaleString('en-PK');
  return plan.maxStudents === null
    ? `${n(plan.minStudents)}+ students`
    : `${n(plan.minStudents)}–${n(plan.maxStudents)} students`;
}

/** The current month, `YYYY-MM`, in Asia/Karachi (the platform's calendar). */
export function currentYearMonth(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7);
}
