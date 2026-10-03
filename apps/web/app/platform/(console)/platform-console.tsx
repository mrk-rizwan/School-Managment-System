'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LogOutIcon } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ErrorState, LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { nextPathFor, PLATFORM_PATHS, sessionRedirectFor, usePlatformMe, useSignOut } from '@/lib/platform-session';

/**
 * The platform console shell. Asks GET /me first and renders the console only for a full
 * session with no pending password change; any other session is sent to the screen it belongs
 * on (contracts/slice-1.md §8). The API enforces the same rules on every request.
 */
export function PlatformConsole({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = usePlatformMe();
  const signOut = useSignOut();
  const target = me.data ? nextPathFor(me.data) : null;
  const ready = target === PLATFORM_PATHS.home;

  useEffect(() => {
    if (target && target !== PLATFORM_PATHS.home) router.replace(target);
  }, [router, target]);

  let body: React.ReactNode;
  if (ready) body = children;
  else if (me.error && !sessionRedirectFor(me.error)) {
    body = (
      <div className="rounded-lg border bg-card">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  } else body = <LoadingState />;

  return (
    <AppShell
      title="ASMS Platform"
      nav="platform"
      topBarEnd={
        me.data && (
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {me.data.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              <LogOutIcon />
              Sign out
            </Button>
          </div>
        )
      }
    >
      {body}
    </AppShell>
  );
}
