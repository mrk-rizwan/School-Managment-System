'use client';

import { Capability } from '@asms/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';

// The student attendance screens' tab row (contracts/slice-11.md §13). A tab is shown only when
// GET /me lists a key its route admits (§1.1); the API checks every request regardless.

const TABS = [
  { href: '/attendance', label: 'Registers', any: [Capability.ATTENDANCE_STUDENT_MARK, Capability.ATTENDANCE_STUDENT_VIEW_ALL] },
  { href: '/attendance/register', label: 'Take register', any: [Capability.ATTENDANCE_STUDENT_MARK, Capability.ATTENDANCE_STUDENT_VIEW_ALL] },
  { href: '/attendance/summary', label: 'Daily summary', any: [Capability.ATTENDANCE_STUDENT_MARK, Capability.ATTENDANCE_STUDENT_VIEW_ALL] },
  { href: '/attendance/reports', label: 'Reports', any: [Capability.ATTENDANCE_STUDENT_VIEW_ALL] },
] as const;

export function AttendanceTabs() {
  const pathname = usePathname();
  const { can } = useCapabilities();
  const tabs = TABS.filter((tab) => tab.any.some((c) => can(c)));
  return (
    <nav aria-label="Attendance" className="mb-6 flex flex-wrap gap-1 border-b">
      {tabs.map(({ href, label }) => {
        const active = pathname === href;
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

/** The link that opens a section's register for a date (and period). */
export function registerHref(sectionId: string, date: string, period = 1): string {
  const query = new URLSearchParams({ section: sectionId, date });
  if (period !== 1) query.set('period', String(period));
  return `/attendance/register?${query.toString()}`;
}
