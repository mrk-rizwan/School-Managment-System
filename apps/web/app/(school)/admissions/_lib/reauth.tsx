'use client';

import { ErrorCode, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { useSuppressSessionRedirects } from '@/components/session-redirects';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { school, type MeDto } from '@/lib/api/school-contract';
import { schoolKeys, useSchoolMe } from '@/lib/school-session';
import { formatIdentityInput } from '../../guardians/_lib/guardians-ui';

/** Thrown when the user gives up signing in again, or signs in as someone else. */
export class ReauthAbandoned extends Error {
  constructor(readonly reason: 'cancelled' | 'other-user') {
    super(
      reason === 'cancelled'
        ? 'Your session ended. Sign in again to continue; nothing was saved.'
        : 'You signed in as a different user, so nothing was submitted. Start again.',
    );
    this.name = 'ReauthAbandoned';
  }
}

const isSessionGone = (error: unknown) =>
  error instanceof ApiError && error.status === 401 && error.code !== ErrorCode.AUTH_FAILED;

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

/**
 * Re-authentication in place (plan §5 slice 6, R97). `guard(call)` runs a request; on a 401 it
 * asks for the password in a dialog, signs in again and repeats the same request, so the
 * admission wizard keeps its state and its Idempotency-Key. A guarded call may run inside a
 * TanStack mutation: the 401 is caught before the mutation sees it.
 *
 * While the calling screen is mounted, the console does not send a 401 to /login
 * (useSuppressSessionRedirects): a background refetch that finds the session gone (GET /me on
 * window focus, say) opens the same dialog instead, so the screen's in-memory state survives.
 */
export function useReauth() {
  const me = useSchoolMe();
  // The console renders its pages only once GET /me has answered, so this is the wizard's user.
  const [expectedUserId] = useState(() => me.data?.id ?? null);
  const waiters = useRef<Waiter[]>([]);
  // Once someone else has signed in, nothing more is sent from this screen.
  const otherUser = useRef(false);
  const [open, setOpen] = useState(false);

  const signIn = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiters.current.push({ resolve, reject });
        setOpen(true);
      }),
    [],
  );

  const guard = useCallback(
    async function run<T>(call: () => Promise<T>): Promise<T> {
      if (otherUser.current) throw new ReauthAbandoned('other-user');
      try {
        return await call();
      } catch (error) {
        if (!isSessionGone(error)) throw error;
        await signIn();
        return run(call);
      }
    },
    [signIn],
  );

  // A background 401: ask now. Giving up leaves the screen as it is; its next request asks again.
  useSuppressSessionRedirects(() => {
    signIn().catch(() => {});
  });

  const settle = (outcome: 'signed-in' | ReauthAbandoned) => {
    const pending = waiters.current;
    waiters.current = [];
    if (outcome instanceof ReauthAbandoned && outcome.reason === 'other-user') otherUser.current = true;
    setOpen(false);
    for (const waiter of pending) {
      if (outcome === 'signed-in') waiter.resolve();
      else waiter.reject(outcome);
    }
  };

  const dialog = (
    <ReauthDialog
      open={open}
      schoolCode={me.data?.school.shortCode ?? ''}
      expectedUserId={expectedUserId}
      onSignedIn={() => settle('signed-in')}
      onAbandon={(reason) => settle(new ReauthAbandoned(reason))}
    />
  );
  return { guard, dialog };
}

const schema = z.object({
  username: z
    .string()
    .trim()
    .refine((v) => normaliseIdentityDigits(v) !== null, 'Enter all 13 digits.'),
  password: z.string().min(1, 'Enter your password.').max(128),
});
type Values = z.infer<typeof schema>;

function ReauthDialog({
  open,
  schoolCode,
  expectedUserId,
  onSignedIn,
  onAbandon,
}: {
  open: boolean;
  schoolCode: string;
  expectedUserId: string | null;
  onSignedIn: () => void;
  onAbandon: (reason: 'cancelled' | 'other-user') => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async ({ username, password }) => {
    setPending(true);
    try {
      const me: MeDto = await unwrap(
        school.POST('/api/v1/auth/login', {
          body: { schoolCode, username: normaliseIdentityDigits(username)!, password },
        }),
      );
      form.reset();
      // The console shows the session that is now live; nothing else in the cache is dropped.
      queryClient.setQueryData(schoolKeys.me, me);
      // Lists that failed while the session was gone load again.
      void queryClient.refetchQueries({ predicate: (query) => query.state.status === 'error' });
      if (expectedUserId !== null && me.id !== expectedUserId) onAbandon('other-user');
      else onSignedIn();
    } catch (error) {
      form.resetField('password');
      applyApiError(form, error);
    } finally {
      setPending(false);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || pending) return;
        form.reset();
        onAbandon('cancelled');
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Sign in to continue</DialogTitle>
            <DialogDescription>
              Your session ended. Sign in again and carry on where you left off; nothing you
              entered is lost and nothing is saved twice.
            </DialogDescription>
          </DialogHeader>
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="username"
            label="CNIC"
            hint="Your own login: 13 digits."
            inputMode="numeric"
            autoComplete="username"
            maxLength={15}
            format={formatIdentityInput}
            autoFocus
          />
          <FormField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                form.reset();
                onAbandon('cancelled');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
