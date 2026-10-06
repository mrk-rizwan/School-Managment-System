'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { MenuIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { platformNav, schoolNav, visibleNav, type NavItem } from '@/lib/nav';

const NAV = { school: schoolNav, platform: platformNav };

/**
 * The admin shell shared by the school console and the platform console: sidebar and top bar.
 * At desktop width (lg, 1024px+) the sidebar is fixed; below it, it opens as a drawer from the
 * menu button so tablet screens keep the full content width.
 * The nav config is chosen here by key, not passed in: its icons are components, which cannot
 * cross from a server layout to this client component.
 */
export function AppShell({
  title,
  nav,
  capabilities = [],
  capacities = [],
  topBarEnd,
  children,
}: {
  title: string;
  nav: keyof typeof NAV;
  /** Effective capabilities of the signed-in user; entries needing others are hidden. */
  capabilities?: readonly string[];
  /** Active capacities (staff, guardian, student); a capacity's own entries need it. */
  capacities?: readonly string[];
  topBarEnd?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const items = visibleNav(NAV[nav], new Set(capabilities), new Set(capacities));

  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[15rem_1fr]">
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r bg-sidebar text-sidebar-foreground transition-transform lg:sticky lg:top-0 lg:h-svh lg:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <span className="text-sm font-semibold tracking-tight">{title}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          >
            <XIcon />
          </Button>
        </div>
        <SidebarNav items={items} onNavigate={() => setDrawerOpen(false)} />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </Button>
          <div className="flex-1" />
          {topBarEnd}
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate: () => void }) {
  const pathname = usePathname();
  // The longest matching entry is the current one, so /settings/messaging lights Messaging only.
  const current = items
    .map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
  return (
    <nav className="flex-1 overflow-y-auto p-2">
      <ul className="grid gap-0.5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === current;
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-primary'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Page heading used at the top of every screen inside the shell. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
