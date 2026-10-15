'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface AreaTab {
  href: string;
  label: string;
}

/**
 * An area's tab strip under its page header. The first tab is the area's root and is active only
 * on its own path; every other tab is active on its path and anything below it.
 */
export function AreaTabs({ label, tabs }: { label: string; tabs: readonly AreaTab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="mb-6 flex gap-1 overflow-x-auto border-b">
      {tabs.map(({ href, label: tabLabel }, index) => {
        const active = index === 0 ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tabLabel}
          </Link>
        );
      })}
    </nav>
  );
}
