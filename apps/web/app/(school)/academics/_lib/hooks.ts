'use client';

import type { Capability } from '@asms/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSchoolMe } from '@/lib/school-session';

/**
 * The signed-in user's effective capabilities, from the school shell's GET /me query
 * (contracts/slice-2.md §4.1). Used by the academic-structure and guardian screens to hide write
 * controls. A convenience only: the API checks every request, and a 403 still shows the
 * no-permission state. Candidate to move into lib/school-session.ts if other screens need it.
 */
export function useCapabilities() {
  const me = useSchoolMe();
  const held = useMemo(() => new Set<string>(me.data?.capabilities ?? []), [me.data]);
  // While GET /me is pending (or failed) nothing is held, so write controls stay hidden.
  const can = useCallback((capability: Capability) => held.has(capability), [held]);
  return { can };
}

/** The value, once it has stopped changing for `ms` (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
