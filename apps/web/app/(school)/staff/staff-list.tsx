'use client';

import { Capability, SYSTEM_ROLES } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, MissingBadge, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import {
  staffApi,
  type StaffDto,
  type StaffListQuery,
  type StaffSort,
  type StaffStatus,
  type SystemRole,
} from '@/lib/api/school-staff-contract';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { useCapabilities } from '@/lib/school-session';
import { ROLE_LABELS, STAFF_STATUS_LABELS, StaffStatusBadge, staffKeys } from './_lib/staff-ui';

const LIMIT = 25;
type Flag = '' | 'true' | 'false';

// `q` is sent only when the API would accept it (contracts/slice-4.md §3.1). Staff have no CNIC
// lookup, so a CNIC is refused with a message.
export function StaffList() {
  const { can } = useCapabilities();
  const [sort, setSort] = useState<StaffSort>('fullName');
  const [search, setSearch] = useState('');
  // The web asks for active staff by default (§3.1).
  const [status, setStatus] = useState<StaffStatus | ''>('active');
  const [role, setRole] = useState<SystemRole | ''>('');
  const [hasLogin, setHasLogin] = useState<Flag>('');
  const [hasCnic, setHasCnic] = useState<Flag>('');
  const { q, identity, hint } = useListSearch(search);
  const [page, setPage] = useListPage([sort, q, status, role, hasLogin, hasCnic]);

  const query: StaffListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(q && { q }),
    ...(role && { role }),
    ...(hasLogin && { hasLogin: hasLogin === 'true' }),
    ...(hasCnic && { hasCnic: hasCnic === 'true' }),
  };
  const staff = useQuery({
    queryKey: [...staffKeys.list, query],
    queryFn: () => unwrap(staffApi.GET('/api/v1/staff', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, StaffDto>();
    return [
      column.accessor('fullName', {
        header: () => <SortHeader field="fullName" label="Name" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <Link
            href={`/staff/${info.row.original.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('cnicMasked', {
        header: 'CNIC',
        cell: (info) =>
          info.getValue() ? (
            <span className="font-mono text-xs">{info.getValue()}</span>
          ) : (
            <MissingBadge>No CNIC</MissingBadge>
          ),
      }),
      column.accessor('phone', {
        header: 'Phone',
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
      column.accessor('designation', {
        header: 'Designation',
        cell: (info) => info.getValue() ?? <span className="text-muted-foreground">—</span>,
      }),
      column.accessor('systemRoles', {
        header: 'Roles',
        cell: (info) => {
          const custom = info.row.original.customRoleNames;
          return info.getValue().length + custom.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {info.getValue().map((r) => (
                <Badge key={r} variant="outline">
                  {ROLE_LABELS[r]}
                </Badge>
              ))}
              {custom.map((name) => (
                <Badge key={`custom-${name}`} variant="outline">
                  {name}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      }),
      column.accessor('userId', {
        header: 'Login',
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="secondary">Has login</Badge>
          ) : (
            <span className="text-muted-foreground">None</span>
          ),
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <StaffStatusBadge status={info.getValue()} />,
      }),
    ];
  }, [sort]);

  const filtered = Boolean(q || status !== 'active' || role || hasLogin || hasCnic);

  return (
    <>
      <PageHeader
        title="Staff"
        description="Everyone the school employs: teachers, office staff and the principal."
        actions={
          can(Capability.STAFF_CREATE) && (
            <Link href="/staff/new" className={buttonVariants()}>
              <PlusIcon />
              New staff member
            </Link>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Name, designation or phone"
          hint={identity ? 'Staff cannot be searched by CNIC. Search by name, designation or phone.' : hint}
          hintTone={identity ? 'destructive' : 'muted'}
        />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="">Any</option>
          {(Object.keys(STAFF_STATUS_LABELS) as StaffStatus[]).map((s) => (
            <option key={s} value={s}>
              {STAFF_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Role" value={role} onChange={setRole}>
          <option value="">Any</option>
          {SYSTEM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Login" value={hasLogin} onChange={setHasLogin}>
          <option value="">Any</option>
          <option value="true">Has login</option>
          <option value="false">No login</option>
        </FilterSelect>
        <FilterSelect label="CNIC" value={hasCnic} onChange={setHasCnic}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No CNIC</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={staff}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No staff match' : 'No staff yet'}
        emptyDescription={
          filtered ? 'Try a different search or filter.' : 'Add each member of staff when they are hired.'
        }
      />
    </>
  );
}
