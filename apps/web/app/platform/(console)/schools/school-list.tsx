'use client';

import { SCHOOL_STATUSES, type SchoolStatus } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import {
  platform,
  type SchoolDto,
  type SchoolListQuery,
  type SchoolSort,
} from '@/lib/api/platform-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { platformKeys } from '@/lib/platform-session';
import { SCHOOL_STATUS_LABELS, SchoolStatusBadge } from './school-ui';

const LIMIT = 25;

type SortField = 'name' | 'shortCode' | 'status' | 'createdAt';

// The search box sends `q` only when the API would accept it (contracts/slice-1.md §4.1).
export function SchoolList() {
  const [status, setStatus] = useState<SchoolStatus | ''>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SchoolSort>('name');
  const { q, identity, hint } = useListSearch(search);
  const [page, setPage] = useListPage([status, q, sort]);

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
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Name or short code"
          hint={identity ? 'Search by school name or short code.' : hint}
        />
        <FilterSelect label="Status" value={status} onChange={setStatus} className="sm:w-44">
          <option value="">All statuses</option>
          {SCHOOL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SCHOOL_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={schools}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
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
