import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { queryKeys } from '../api/query-keys';
import { cacheKey, readCache, writeCache, type CacheParams, type Cached } from './cache';

// A read that survives airplane mode (slice-15 §6, §7.2): the SQLite row hydrates the query (its
// "as of" becomes the data's updatedAt, so staleness is judged from the server's time), and a cold
// start offline shows data. A successful fetch replaces the row with the response and its Date
// header. The network query waits for the row so it never races it.

export function useCachedQuery<T>(
  queryKey: QueryKey,
  path: string,
  params: CacheParams,
  fetcher: () => Promise<{ data: T; date: string | null }>,
  /** enabled: false reads nothing (a picker the caller does not need); staleTime 0: always refetch. */
  options: { enabled?: boolean; staleTime?: number } = {},
) {
  const enabled = options.enabled ?? true;
  const client = useQueryClient();
  const key = cacheKey(path, params);
  const row = useQuery({
    queryKey: queryKeys.cacheRow(key),
    queryFn: async () => {
      const cached = await readCache<T>(key);
      if (cached !== null && client.getQueryData(queryKey) === undefined) {
        client.setQueryData<Cached<T>>(queryKey, cached, {
          updatedAt: Date.parse(cached.serverTime),
        });
      }
      return cached;
    },
    networkMode: 'always',
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
    enabled,
  });
  return useQuery<Cached<T>>({
    queryKey,
    enabled: enabled && row.isFetched,
    ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
    queryFn: async () => {
      const { data, date } = await fetcher();
      return writeCache(key, data, date);
    },
  });
}
