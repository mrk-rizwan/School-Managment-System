// TanStack Query keys, in one place so a wipe or an invalidation names exactly what it means.
export const queryKeys = {
  me: ['me'] as const,
  calendar: (dateFrom: string, dateTo: string) => ['me', 'calendar', dateFrom, dateTo] as const,
  cacheRow: (key: string) => ['cache-row', key] as const,
};
