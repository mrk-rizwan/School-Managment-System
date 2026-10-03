'use client';

import { ErrorCode, type Capability } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { school, type MeDto } from '@/lib/api/school-contract';

// School console session handling (contracts/slice-2.md §1, §4, §10), the same pattern as
// lib/platform-session.ts. Every call is made by the browser with the school cookie; nothing
// here runs on the server. These redirects are a convenience: the API refuses every request
// the session does not allow.

export const SCHOOL_PATHS = {
  login: '/login',
  forgot: '/forgot',
  account: '/account',
  /** Where a sign-in lands. Every school user can open their account page. */
  home: '/account',
} as const;

export const schoolKeys = {
  all: ['school'] as const,
  me: ['school', 'me'] as const,
  users: ['school', 'users'] as const,
  settings: ['school', 'settings'] as const,
};

/**
 * The screen a session error sends the user to, or null when the error is not about the session.
 * Only a 401 is: the session is gone. A 403 (no capability, suspended school) is answered on the
 * screen itself. AUTH_FAILED is the login form's own answer and stays on the form.
 */
export function sessionRedirectFor(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401 && error.code !== ErrorCode.AUTH_FAILED) return SCHOOL_PATHS.login;
  return null;
}

export function useSchoolMe() {
  return useQuery({
    queryKey: schoolKeys.me,
    queryFn: () => unwrap(school.GET('/api/v1/me')),
  });
}

/**
 * The signed-in user's effective capabilities, from the school shell's GET /me query
 * (contracts/slice-2.md §4.1), to hide controls the user cannot use. A convenience only: the API
 * checks every request, and a 403 still shows the no-permission state.
 */
export function useCapabilities() {
  const me = useSchoolMe();
  const held = useMemo(() => new Set<string>(me.data?.capabilities ?? []), [me.data]);
  // While GET /me is pending (or failed) nothing is held, so write controls stay hidden.
  const can = useCallback((capability: Capability) => held.has(capability), [held]);
  return { can };
}

/**
 * Stores the session a login returned, dropping everything cached under the previous session
 * first, and goes to the console.
 */
export function useEnterSession() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (me: MeDto) => {
    queryClient.removeQueries({ queryKey: schoolKeys.all });
    queryClient.setQueryData(schoolKeys.me, me);
    router.replace(SCHOOL_PATHS.home);
  };
}

/**
 * POST /auth/logout, then the login page, which clears the query cache when it mounts. A 401
 * means the session was already gone: also signed out.
 */
export function useSignOut() {
  const router = useRouter();
  return useMutation({
    mutationFn: () => unwrap(school.POST('/api/v1/auth/logout')),
    onSettled: (_data, error) => {
      const signedOut = !error || (error instanceof ApiError && error.status === 401);
      if (!signedOut) {
        toast.error(error instanceof ApiError ? error.message : 'Sign-out failed. Try again.');
        return;
      }
      router.replace(SCHOOL_PATHS.login);
    },
  });
}

/**
 * The school login page drops every cached query on arrival, however it was reached: nothing
 * fetched under the previous session survives.
 */
export function useClearCacheOnArrival() {
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.clear();
  }, [queryClient]);
}

/** Puts a fresh MeDto (from change-email, change-password) in the cache. */
export function useSetMe() {
  const queryClient = useQueryClient();
  return (me: MeDto) => queryClient.setQueryData(schoolKeys.me, me);
}
