'use client';

import { SCHOOL_STATUSES, type SchoolStatus } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import {
  platform,
  type SchoolDto,
  type SchoolListQuery,
  type SchoolSort,
} from '@/lib/api/platform-contract';
import { platformKeys } from '@/lib/platform-session';
import { formatDate, SCHOOL_STATUS_LABELS, SchoolStatusBadge } from './school-ui';

const LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 300;
const NO_ROWS: SchoolDto[] = [];

type SortField = 'name' | 'shortCode' | 'status' | 'createdAt';

/**
 * The search box sends `q` only when the API would accept it (contracts/slice-1.md §4.1):
 * 2–100 characters, and never a run of 13 digits (an identity number is not a search term).
 */
function searchTerm(raw: string): { q?: string; hint?: string } {
  const q = raw.trim();
  if (q.length === 0) return {};
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  if (/\d{13}/.test(q)) return { hint: 'Search by school name or short code.' };
  return { q: q.slice(0, 100) };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function SchoolList() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<SchoolStatus | ''>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SchoolSort>('name');
  const { q, hint } = searchTerm(useDebounced(search, SEARCH_DEBOUNCE_MS));
  const searchId = useId();
  const statusId = useId();

  // A filter or sort change starts again at page 1 (adjusting state while rendering, the
  // React-recommended alternative to an effect).
  const filterKey = `${status}|${q ?? ''}|${sort}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query: SchoolListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(q && { q }),
  };
  const schools = useQuery({
    queryKey: [...platformKeys.schools, 'list', query],
    queryFn: () => unwrap(platform.GET('/api/v1/platform/schools', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, SchoolDto>();
    const sortable = (field: SortField, label: string) =>
      function Header() {
        return <SortHeader field={field} label={label} sort={sort} onSort={setSort} />;
      };
    return [
      column.accessor('name', {
        header: sortable('name', 'Name'),
        cell: (info) => (
          <Link
            href={`/platform/schools/${info.row.original.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('shortCode', {
        header: sortable('shortCode', 'Short code'),
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
      column.accessor('status', {
        header: sortable('status', 'Status'),
        cell: (info) => <SchoolStatusBadge status={info.getValue()} />,
      }),
      column.accessor('timezone', {
        header: 'Time zone',
        cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
      }),
      column.accessor('createdAt', {
        header: sortable('createdAt', 'Created'),
        cell: (info) => formatDate(info.getValue()),
      }),
    ];
  }, [sort]);

  const filtered = Boolean(status || q);
  const result = schools.data;

  return (
    <>
      <PageHeader
        title="Schools"
        description="Every school on the platform."
        actions={
          <Link href="/platform/schools/new" className={buttonVariants()}>
            <PlusIcon />
            New school
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="grid w-full gap-1.5 sm:w-72">
          <Label htmlFor={searchId}>Search</Label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={search}
              maxLength={100}
              placeholder="Name or short code"
              className="pl-8"
              aria-describedby={hint ? `${searchId}-hint` : undefined}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {hint && (
            <p id={`${searchId}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={statusId}>Status</Label>
          <NativeSelect
            id={statusId}
            value={status}
            onChange={(event) => setStatus(event.target.value as SchoolStatus | '')}
          >
            <option value="">All statuses</option>
            {SCHOOL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SCHOOL_STATUS_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={result?.data ?? NO_ROWS}
        getRowId={(row) => row.id}
        page={result?.page ?? page}
        limit={result?.limit ?? LIMIT}
        total={result?.total ?? 0}
        onPageChange={setPage}
        isLoading={schools.isPending || schools.isPlaceholderData}
        error={schools.error}
        onRetry={() => void schools.refetch()}
        emptyTitle={filtered ? 'No schools match' : 'No schools yet'}
        emptyDescription={
          filtered
            ? 'Try a different status or search.'
            : 'Create the first school to give it a console.'
        }
        emptyAction={
          !filtered && (
            <Link href="/platform/schools/new" className={buttonVariants({ variant: 'outline' })}>
              New school
            </Link>
          )
        }
      />
    </>
  );
}
