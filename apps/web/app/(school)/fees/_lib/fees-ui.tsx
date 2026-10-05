'use client';

import { MAX_RUPEES, YEAR_MONTH_PATTERN } from '@asms/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { z } from 'zod';
import { cn } from '@/lib/utils';

// Pieces shared by the fee-head and fee-structure screens (phase-3-financial.md slice 18).

export const feesKeys = {
  all: ['school', 'fees'] as const,
  heads: ['school', 'fees', 'heads'] as const,
  structures: ['school', 'fees', 'structures'] as const,
};

const TABS = [
  { href: '/fees/heads', label: 'Fee heads' },
  { href: '/fees/structures', label: 'Fee structure' },
] as const;

export function FeesTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Fees" className="mb-6 flex gap-1 border-b">
      {TABS.map(({ href, label }) => {
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
