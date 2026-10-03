'use client';

import { CUSTOM_ROLE_STATUSES, Capability } from '@asms/shared';
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
  rolesApi,
  type CustomRoleDto,
  type CustomRoleListQuery,
  type CustomRoleSort,
  type CustomRoleStatus,
} from '@/lib/api/school-roles-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { useCapabilities } from '@/lib/school-session';
import { CUSTOM_ROLE_STATUS_LABELS, CustomRoleStatusBadge, accessKeys } from './_lib/custom-roles-ui';

// contracts/slice-7.md §3.1 and §9. Readable with user.account.manage (so the office can name a
// custom role); write controls only with role.manage.

const LIMIT = 25;

export function CustomRoleList() {
  const { can } = useCapabilities();
  const [status, setStatus] = useState<CustomRoleStatus | ''>('active');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomRoleSort>('name');
  const { q, identity, hint } = useListSearch(search);
  // The API takes 2–50 characters here.
  const term = q?.slice(0, 50);
  const [page, setPage] = useListPage([status, term, sort]);

  const query: CustomRoleListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(term && { q: term }),
  };
  const roles = useQuery({
    queryKey: [...accessKeys.customRoleList, query],
    queryFn: () => unwrap(rolesApi.GET('/api/v1/custom-roles', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, CustomRoleDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Name" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <Link
            href={`/custom-roles/${info.row.original.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('key', {
        header: 'Key',
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
      column.accessor('capabilities', {
        header: 'Capabilities',
        cell: (info) => <span className="tabular-nums">{info.getValue().length}</span>,
      }),
      column.accessor('holderCount', {
        header: 'Held by',
        cell: (info) => {
          const n = info.getValue();
          return <span className="tabular-nums">{n === 1 ? '1 person' : `${n} people`}</span>;
        },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <CustomRoleStatusBadge status={info.getValue()} />,
      }),
      column.accessor('createdAt', {
        header: () => (
          <SortHeader field="createdAt" label="Created" sort={sort} onSort={setSort} />
        ),
        cell: (info) => formatDate(info.getValue()),
      }),
    ];
  }, [sort]);

  const canWrite = can(Capability.ROLE_MANAGE);
  const filtered = Boolean(term || status !== 'active');

  return (
    <>
      <PageHeader
        title="Custom roles"
        description="Roles your school defines beyond principal, office staff and teacher. Each is a set of capabilities given to staff as one."
        actions={
          canWrite && (
            <Link href="/custom-roles/new" className={buttonVariants()}>
              <PlusIcon />
              New custom role
            </Link>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Name or key"
          maxLength={50}
          hint={identity ? 'Search by the role’s name or key.' : hint}
          hintTone={identity ? 'destructive' : 'muted'}
        />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="">Any</option>
          {CUSTOM_ROLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CUSTOM_ROLE_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={roles}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No custom roles match' : 'No custom roles yet'}
        emptyDescription={
          filtered
            ? 'Try a different search or filter.'
            : canWrite
              ? 'Create one when a member of staff needs a set of capabilities no system role gives.'
              : 'Your principal creates custom roles.'
        }
      />
    </>
  );
}
