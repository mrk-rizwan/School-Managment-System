import { DownloadIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

// Every report tab's CSV download (contracts/slice-42.md §3). A plain same-origin link: the browser
// sends the session cookie and `Sec-Fetch-Site: same-origin`, and the API answers with an
// attachment. The rows are the ones the tab shows, so the link carries the tab's filters; paging
// is left out (the API refuses `page` or `limit` with `format=csv`).

type Filters = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** `path?<filters>&format=csv`, without paging and without empty filters. */
export function csvHref(path: string, filters: Filters = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'page' || key === 'limit' || key === 'format') continue;
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  params.set('format', 'csv');
  return `${path}?${params.toString()}`;
}

export function DownloadCsvButton({
  path,
  filters,
  disabled = false,
}: {
  /** The report's API path, e.g. `/api/v1/finance-reports/defaulters`. */
  path: string;
  /** The tab's current query; `page` and `limit` are dropped. */
  filters?: Filters;
  /** While the report loads, fails or has no rows. */
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <Button variant="outline" disabled>
        <DownloadIcon />
        Download CSV
      </Button>
    );
  }
  return (
    <a href={csvHref(path, filters)} download className={buttonVariants({ variant: 'outline' })}>
      <DownloadIcon />
      Download CSV
    </a>
  );
}
