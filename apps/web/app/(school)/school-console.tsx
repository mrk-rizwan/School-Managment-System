'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRoundIcon, LockIcon, LogOutIcon, PauseCircleIcon } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ErrorState, LoadingState } from '@/components/page-states';
import { SessionRedirects } from '@/components/session-redirects';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { MeDto } from '@/lib/api/school-contract';
import { SCHOOL_PATHS, sessionRedirectFor, useSchoolMe, useSignOut } from '@/lib/school-session';

/**
 * The school console shell (contracts/slice-2.md §10). Asks GET /me first; a 401 sends the
 * visitor to /login (SessionRedirects). The sidebar shows only entries the user's effective
 * capabilities allow; hiding is a convenience, the API checks every request itself.
 */
export function SchoolConsole({ children }: { children: React.ReactNode }) {
  const me = useSchoolMe();
  const signOut = useSignOut();

  let body: React.ReactNode;
  if (me.data) {
    body = (
      <>
        <SessionNotices me={me.data} />
        {children}
      </>
    );
  } else if (me.error && !sessionRedirectFor(me.error)) {
    body = (
      <div className="rounded-lg border bg-card">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  } else body = <LoadingState />;

  return (
    <>
      <SessionRedirects redirectFor={sessionRedirectFor} />
      <AppShell
        title={me.data?.school.name ?? 'ASMS'}
        nav="school"
        capabilities={me.data?.capabilities ?? []}
        topBarEnd={
          me.data && (
            <div className="flex min-w-0 items-center gap-3">
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {me.data.fullName}
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
    </>
  );
}

/**
 * Persistent notices above every screen: the default-password prompt (CLAUDE.md rule 12:
 * prompt, never force) and the suspended-school banner. A suspended school keeps working exactly
 * as an active one (contracts/slice-9.md §10, R80 lifted): the banner is the only effect.
 */
function SessionNotices({ me }: { me: MeDto }) {
  const pathname = usePathname();
  const onAccount = pathname === SCHOOL_PATHS.account;
  // Rule 24: role.manage and user.account.manage stay inert until the password is changed.
  const blocked = me.blockedCapabilities.length > 0;
  if (!me.passwordIsDefault && !blocked && me.school.status !== 'suspended') return null;

  return (
    <div className="mb-6 grid gap-3">
      {me.school.status === 'suspended' && (
        <Alert role="status" data-testid="suspended-banner">
          <PauseCircleIcon />
          <AlertTitle>Subscription suspended</AlertTitle>
          <AlertDescription>
            This school’s subscription is suspended. Contact the platform.
          </AlertDescription>
        </Alert>
      )}
      {me.passwordIsDefault && (
        <Alert role="status" data-testid="default-password-banner">
          <KeyRoundIcon />
          <AlertTitle>You are still using the default password</AlertTitle>
          <AlertDescription>
            {me.hasVerifiedEmail
              ? 'Anyone who knows your identity number can sign in as you. Choose your own password.'
              : 'Anyone who knows your identity number can sign in as you. Add and verify an email address, then choose your own password.'}{' '}
            {!onAccount && <Link href={SCHOOL_PATHS.account}>Go to your account</Link>}
          </AlertDescription>
        </Alert>
      )}
      {blocked && (
        <Alert role="status" data-testid="blocked-capabilities-banner">
          <LockIcon />
          <AlertDescription>
            Change your password to manage user accounts and roles.{' '}
            {!onAccount && <Link href={SCHOOL_PATHS.account}>Change your password</Link>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
