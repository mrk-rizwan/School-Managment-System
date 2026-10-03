'use client';

import { useEffect, useState } from 'react';

/** The value, once it has stopped changing for `ms` (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * The page of a server-paginated list. Any change to `filters` (search, filter selects, sort)
 * starts again at page 1, by adjusting state while rendering: the React-recommended alternative
 * to an effect.
 */
export function useListPage(filters: readonly unknown[]): [number, (page: number) => void] {
  const filterKey = filters.join('|');
  const [page, setPage] = useState(1);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }
  return [page, setPage];
}
