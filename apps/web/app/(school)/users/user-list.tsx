'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import {
  school,
  type UserDto,
  type UserKind,
  type UserListQuery,
  type UserSort,
  type UserStatus,
} from '@/lib/api/school-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { schoolKeys, useSchoolMe } from '@/lib/school-session';
import { ROLE_LABELS } from '../staff/_lib/staff-ui';
import { UserActions } from './user-actions';

// contracts/slice-2.md §5.1 and §10: the office's view of every login in the school, with the
// two rule-12 questions as filters: who still uses the default password, who has no email.

const LIMIT = 25;
type SortField = Exclude<UserSort, `-${string}`>;
type YesNo = '' | 'true' | 'false';

/** What the account is: its staff roles, and Parent / Student for the other capacities. */
function describeAccount(user: UserDto): string {
  const parts: string[] = [...user.systemRoles.map((role) => ROLE_LABELS[role]), ...user.customRoleNames];
  if (user.staffId && parts.length === 0) parts.push('Staff');
  if (user.guardianId) parts.push('Parent');
  if (user.studentId) parts.push('Student');
  return parts.join(', ') || '—';
}

export function UserList() {
  const me = useSchoolMe();
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [kind, setKind] = useState<UserKind | ''>('');
  const [passwordIsDefault, setPasswordIsDefault] = useState<YesNo>('');
  const [hasEmail, setHasEmail] = useState<YesNo>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<UserSort>('fullName');
  const { q, identity, hint } = useListSearch(search);
  const [page, setPage] = useListPage([status, kind, passwordIsDefault, hasEmail, q, sort]);

  const query: UserListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(kind && { kind }),
    ...(passwordIsDefault && { passwordIsDefault: passwordIsDefault === 'true' }),
    ...(hasEmail && { hasEmail: hasEmail === 'true' }),
    ...(q && { q }),
  };
  const users = useQuery({
    queryKey: [...schoolKeys.users, 'list', query],
    queryFn: () => unwrap(school.GET('/api/v1/users', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const myId = me.data?.id;
  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, UserDto>();
    const sortable = (field: SortField, label: string) =>
      function Header() {
        return <SortHeader field={field} label={label} sort={sort} onSort={setSort} />;
      };
    return [
      column.accessor('fullName', {
        header: sortable('fullName', 'Name'),
        cell: (info) => (
          <div className="grid gap-0.5">
            <span className="font-medium">{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">{describeAccount(info.row.original)}</span>
          </div>
        ),
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) =>
          info.getValue() === 'active' ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="destructive">Disabled</Badge>
          ),
      }),
      column.accessor('emailMasked', {
        header: 'Email',
        cell: (info) => {
          const user = info.row.original;
          if (!user.hasEmail) return <span className="text-muted-foreground">No email</span>;
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs">{info.getValue()}</span>
              {!user.hasVerifiedEmail && <Badge variant="outline">Not verified</Badge>}
            </div>
          );
        },
      }),
      column.accessor('passwordIsDefault', {
        header: 'Password',
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="outline">Default</Badge>
          ) : (
            <span className="text-muted-foreground">Changed</span>
          ),
      }),
      column.accessor('lastLoginAt', {
        header: sortable('lastLoginAt', 'Last sign-in'),
        cell: (info) => {
          const value = info.getValue();
          return value ? (
            formatDateTime(value)
          ) : (
            <span className="text-muted-foreground">Never</span>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) =>
          info.row.original.id === myId ? (
            <span className="text-xs text-muted-foreground">You</span>
          ) : (
            <UserActions user={info.row.original} />
          ),
      }),
    ];
  }, [sort, myId]);

  const filtered = Boolean(status || kind || passwordIsDefault || hasEmail || q);

  return (
    <>
      <PageHeader
        title="User accounts"
        description="Every sign-in for this school. Accounts are created by the office at admission or hiring."
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Name"
          className="sm:w-64"
          hint={identity ? 'Search by name. Identity numbers are not searchable.' : hint}
        />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </FilterSelect>
        <FilterSelect label="Account type" value={kind} onChange={setKind}>
          <option value="">All types</option>
          <option value="staff">Staff</option>
          <option value="guardian">Parents</option>
          <option value="student">Students</option>
        </FilterSelect>
        <FilterSelect label="Password" value={passwordIsDefault} onChange={setPasswordIsDefault}>
          <option value="">Any password</option>
          <option value="true">Still default</option>
          <option value="false">Changed</option>
        </FilterSelect>
        <FilterSelect label="Email" value={hasEmail} onChange={setHasEmail}>
          <option value="">Any email</option>
          <option value="false">No email</option>
          <option value="true">Has email</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={users}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No accounts match' : 'No accounts yet'}
        emptyDescription={
          filtered
            ? 'Try different filters or clear the search.'
            : 'Accounts appear here as staff are hired and students are admitted.'
        }
      />
    </>
  );
}
