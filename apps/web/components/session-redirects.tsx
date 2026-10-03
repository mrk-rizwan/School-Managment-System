'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Screens that hold work only in memory (the admission wizard, the readmission form) and can
 * re-authenticate in place. While one is mounted, a session error is handed to it instead of
 * navigating away, which would throw the work away. Module-level because there is one router
 * per tab; the most recently mounted screen answers.
 */
let sessionLostHandlers: Array<() => void> = [];

/**
 * Opts the calling screen out of the session redirect while it is mounted: `onSessionLost` runs
 * instead (it opens the screen's sign-in dialog). The latest callback is used; no memoising needed.
 */
export function useSuppressSessionRedirects(onSessionLost: () => void) {
  const latest = useRef(onSessionLost);
  useEffect(() => {
    latest.current = onSessionLost;
  }, [onSessionLost]);
  useEffect(() => {
    const handler = () => latest.current();
    sessionLostHandlers.push(handler);
    return () => {
      sessionLostHandlers = sessionLostHandlers.filter((h) => h !== handler);
    };
  }, []);
}

/**
 * Sends the user to the right screen when any query or mutation reports a session problem.
 * `redirectFor` maps an error to a path, or null when the error is not about the session.
 * Watches the query and mutation caches, so no screen has to remember to do it. Renders nothing.
 * The school console uses it with lib/school-session.ts; the platform console
 * (app/platform/layout.tsx) with lib/platform-session.ts. A screen mounted with
 * useSuppressSessionRedirects receives the session error instead of the redirect.
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
      const suppressedBy = sessionLostHandlers.at(-1);
      if (suppressedBy) {
        suppressedBy();
        return;
      }
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
