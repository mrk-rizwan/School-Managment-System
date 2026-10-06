'use client';

import { Capability, MAX_RUPEES, YEAR_MONTH_PATTERN } from '@asms/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { z } from 'zod';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';

// Pieces shared by the fee screens (phase-3-financial.md slices 18 and 19).

export const feesKeys = {
  all: ['school', 'fees'] as const,
  heads: ['school', 'fees', 'heads'] as const,
  structures: ['school', 'fees', 'structures'] as const,
  // Slice 19.
  charges: ['school', 'fees', 'charges'] as const,
  runs: ['school', 'fees', 'runs'] as const,
  concessions: ['school', 'fees', 'concessions'] as const,
  campaigns: ['school', 'fees', 'campaigns'] as const,
  statement: (studentId: string) => ['school', 'fees', 'statement', studentId] as const,
};

/** Each tab shows to the holders of any of its keys (the API checks every request). */
const TABS: readonly { href: string; label: string; keys: readonly Capability[] }[] = [
  { href: '/fees/heads', label: 'Fee heads', keys: [] },
  { href: '/fees/structures', label: 'Fee structure', keys: [] },
  { href: '/fees/charges', label: 'Charges', keys: [Capability.FEE_STATEMENT_VIEW, Capability.CHARGE_CREATE] },
  { href: '/fees/runs', label: 'Generation runs', keys: [Capability.CHARGE_CREATE, Capability.FINANCE_REPORT_VIEW] },
  { href: '/fees/concessions', label: 'Concessions', keys: [Capability.CONCESSION_GRANT, Capability.CHARGE_CREATE] },
  { href: '/fees/campaigns', label: 'Campaigns', keys: [Capability.CHARGE_CAMPAIGN_SEND] },
  // Slice 20: the counter, payments and receipts, cash custody and handovers.
  { href: '/fees/counter', label: 'Counter', keys: [Capability.PAYMENT_RECORD] },
  { href: '/fees/payments', label: 'Payments', keys: [Capability.PAYMENT_RECORD, Capability.FEE_STATEMENT_VIEW] },
  { href: '/fees/handovers', label: 'Cash handovers', keys: [Capability.PAYMENT_RECORD, Capability.COLLECTION_HANDOVER_CONFIRM] },
];

export function FeesTabs() {
  const pathname = usePathname();
  const { can } = useCapabilities();
  const tabs = TABS.filter((t) => t.keys.length === 0 || t.keys.some((key) => can(key)));
  return (
    <nav aria-label="Fees" className="mb-6 flex flex-wrap gap-1 border-b">
      {tabs.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** `2026-04` as `Apr 2026`. */
export const formatMonth = (yearMonth: string) => monthFormat.format(new Date(`${yearMonth}-01T00:00:00Z`));

/** A whole-rupee amount typed as text: digits only, 0 to MAX_RUPEES (rule 15). */
export const rupeesSchema = z
  .string()
  .trim()
  .refine(
    (v) => /^\d+$/.test(v) && Number(v) <= MAX_RUPEES,
    `Enter a whole number of rupees, up to ${MAX_RUPEES.toLocaleString('en-US')}.`,
  );

export const yearMonthSchema = z.string().refine((v) => YEAR_MONTH_PATTERN.test(v), 'Pick a month.');

/** Digits only, as an amount is typed: no decimals, separators or signs. */
export const digitsOnly = (raw: string) => raw.replace(/\D/g, '').slice(0, 8);

/** The principal role (R233): a grant of a key never stands in for it; the API decides. */
export function useIsPrincipal(): boolean {
  return useSchoolMe().data?.roles.includes('principal') ?? false;
}

export const CHARGE_STATUS_LABELS = { open: 'Open', settled: 'Settled', voided: 'Voided', waived: 'Waived' } as const;
export const CHARGE_KIND_LABELS = {
  generated: 'Generated',
  campaign: 'Campaign',
  manual: 'Manual',
  late_fee: 'Late fee',
  adjustment: 'Credit',
} as const;
export const CONCESSION_STATUS_LABELS = { requested: 'Requested', approved: 'Approved', rejected: 'Rejected', ended: 'Ended' } as const;
export const RUN_STATUS_LABELS = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' } as const;
export const CAMPAIGN_STATUS_LABELS = { draft: 'Draft', generating: 'Generating', generated: 'Generated', cancelled: 'Cancelled' } as const;
