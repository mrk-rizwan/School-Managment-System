'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { platform, type PlatformMeDto } from '@/lib/api/platform-contract';

// Platform console session handling (contracts/slice-1.md §8). Every call is made by the
// browser with the platform cookie; nothing here runs on the server. These redirects are a
// convenience: the API refuses every request the session does not allow.

export const PLATFORM_PATHS = {
  login: '/platform/login',
  enrol: '/platform/enrol',
  changePassword: '/platform/change-password',
  home: '/platform/schools',
} as const;

export const platformKeys = {
  all: ['platform'] as const,
  me: ['platform', 'me'] as const,
  schools: ['platform', 'schools'] as const,
  school: (id: string) => ['platform', 'schools', 'detail', id] as const,
  settings: ['platform', 'settings'] as const,
  deliveryHealth: ['platform', 'messaging', 'health'] as const,
  // Slice 26: platform billing.
  plans: ['platform', 'plans'] as const,
  invoices: ['platform', 'invoices'] as const,
  billing: (id: string) => ['platform', 'schools', 'billing', id] as const,
};

/** Where a session in this state belongs: enrolment first, then the password, then the console. */
export function nextPathFor(me: PlatformMeDto): string {
  if (me.sessionStage === 'totp_enrolment') return PLATFORM_PATHS.enrol;
  if (me.mustChangePassword) return PLATFORM_PATHS.changePassword;
  return PLATFORM_PATHS.home;
}

/** The screen a session error sends the user to, or null when the error is not about the session. */
export function sessionRedirectFor(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401 && error.code === ErrorCode.AUTH_REQUIRED) return PLATFORM_PATHS.login;
  if (error.status === 403 && error.code === ErrorCode.TOTP_REQUIRED) return PLATFORM_PATHS.enrol;
  if (error.status === 403 && error.code === ErrorCode.PASSWORD_CHANGE_REQUIRED) {
    return PLATFORM_PATHS.changePassword;
  }
  return null;
}

export function usePlatformMe() {
  return useQuery({
    queryKey: platformKeys.me,
    queryFn: () => unwrap(platform.GET('/api/v1/platform/me')),
  });
}

/**
 * Stores the session a login, confirm or password change returned, dropping everything cached
 * under the previous session first, and goes where that session belongs.
 */
export function useEnterSession() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (me: PlatformMeDto) => {
    queryClient.removeQueries({ queryKey: platformKeys.all });
    queryClient.setQueryData(platformKeys.me, me);
    router.replace(nextPathFor(me));
  };
}

/**
 * POST /auth/logout, then the login page, which clears the query cache when it mounts (see
 * useClearCacheOnArrival). A 401 means the session was already gone: also signed out.
 */
export function useSignOut() {
  const router = useRouter();
  return useMutation({
    mutationFn: () => unwrap(platform.POST('/api/v1/platform/auth/logout')),
    onSettled: (_data, error) => {
      const signedOut = !error || (error instanceof ApiError && error.status === 401);
      if (!signedOut) {
        toast.error(error instanceof ApiError ? error.message : 'Sign-out failed. Try again.');
        return;
      }
      router.replace(PLATFORM_PATHS.login);
    },
  });
}

/**
 * The platform login page drops every cached query on arrival, however it was reached (sign
 * out, an expired session, a 401): nothing fetched under the previous session survives. Done
 * here rather than before navigating, because clearing under a mounted console makes it refetch.
 */
export function useClearCacheOnArrival() {
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.clear();
  }, [queryClient]);
}
