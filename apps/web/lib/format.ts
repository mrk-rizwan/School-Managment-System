// formatDate, formatDateTime, formatDay and todayInSchool live in @asms/shared since slice 15
// (contracts/slice-15.md §2.5): the mobile app formats the same way. Re-exported here so no web
// importer changes.
export { formatDate, formatDateTime, formatDay, todayInSchool } from '@asms/shared';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
