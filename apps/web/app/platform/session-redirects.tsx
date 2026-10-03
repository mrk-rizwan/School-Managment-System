'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { sessionRedirectFor } from '@/lib/platform-session';

/**
 * Sends the user to the right screen when any platform call reports a session problem
 * (contracts/slice-1.md §8): 401 AUTH_REQUIRED → sign in, 403 TOTP_REQUIRED → enrolment,
 * 403 PASSWORD_CHANGE_REQUIRED → password change. Watches the query and mutation caches, so no
 * screen has to remember to do it. Renders nothing.
 */
export function PlatformSessionRedirects() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const handle = (error: unknown) => {
      const target = sessionRedirectFor(error);
      if (!target || target === pathnameRef.current) return;
      // No cache clearing here: clearing while the console is mounted makes it refetch, fail
      // and clear again, starving the navigation. The login page clears the cache on arrival.
      router.replace(target);
    };
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') handle(event.action.error);
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') handle(event.action.error);
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, router]);

  return null;
}
