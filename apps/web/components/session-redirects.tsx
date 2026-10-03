'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Sends the user to the right screen when any query or mutation reports a session problem.
 * `redirectFor` maps an error to a path, or null when the error is not about the session.
 * Watches the query and mutation caches, so no screen has to remember to do it. Renders nothing.
 * The school console uses it with lib/school-session.ts; the platform console
 * (app/platform/layout.tsx) with lib/platform-session.ts.
 */
export function SessionRedirects({ redirectFor }: { redirectFor: (error: unknown) => string | null }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const redirectForRef = useRef(redirectFor);

  useEffect(() => {
    pathnameRef.current = pathname;
    redirectForRef.current = redirectFor;
  }, [pathname, redirectFor]);

  useEffect(() => {
    const handle = (error: unknown) => {
      const target = redirectForRef.current(error);
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
