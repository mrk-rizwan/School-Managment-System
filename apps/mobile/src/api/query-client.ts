import { QueryClient } from '@tanstack/react-query';

// App-wide defaults (slice-15 §6): offline-first, five-minute staleness, a day in memory, no
// refetch on focus, one retry for reads and none for mutations (the outbox owns retries).
// refetchInterval is lint-banned: no polling, ever (R160).
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'offlineFirst',
        staleTime: 5 * 60_000,
        gcTime: 24 * 60 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: 1,
      },
      mutations: { networkMode: 'offlineFirst', retry: 0 },
    },
  });
}

export const queryClient = createQueryClient();
