'use client';

import { DEFAULT_TIMEZONE, type SystemRole } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { SearchIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import {
  school,
  type UserDto,
  type UserKind,
  type UserListQuery,
  type UserSort,
  type UserStatus,
} from '@/lib/api/school-contract';
import { schoolKeys, useSchoolMe } from '@/lib/school-session';
import { UserActions } from './user-actions';

// contracts/slice-2.md §5.1 and §10: the office's view of every login in the school, with the
// two rule-12 questions as filters: who still uses the default password, who has no email.

const LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 300;
const NO_ROWS: UserDto[] = [];
type SortField = Exclude<UserSort, `-${string}`>;
type YesNo = '' | 'true' | 'false';

const ROLE_LABELS: Record<SystemRole, string> = {
  principal: 'Principal',
  office_staff: 'Office staff',
  teacher: 'Teacher',
};

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DEFAULT_TIMEZONE,
});

/** What the account is: its staff roles, and Parent / Student for the other capacities. */
function describeAccount(user: UserDto): string {
  const parts: string[] = user.systemRoles.map((role) => ROLE_LABELS[role]);
  if (user.staffId && parts.length === 0) parts.push('Staff');
  if (user.guardianId) parts.push('Parent');
  if (user.studentId) parts.push('Student');
  return parts.join(', ') || '—';
}

/** `q` only when the API would accept it: 2–100 characters, never a 13-digit run (§5.1). */
function searchTerm(raw: string): { q?: string; hint?: string } {
  const q = raw.trim();
  if (q.length === 0) return {};
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  if (/\d{13}/.test(q)) return { hint: 'Search by name. Identity numbers are not searchable.' };
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

export function UserList() {
  const me = useSchoolMe();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [kind, setKind] = useState<UserKind | ''>('');
  const [passwordIsDefault, setPasswordIsDefault] = useState<YesNo>('');
  const [hasEmail, setHasEmail] = useState<YesNo>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<UserSort>('fullName');
  const { q, hint } = searchTerm(useDebounced(search, SEARCH_DEBOUNCE_MS));
  const ids = { search: useId(), status: useId(), kind: useId(), password: useId(), email: useId() };

  // A filter or sort change starts again at page 1 (adjusting state while rendering).
  const filterKey = [status, kind, passwordIsDefault, hasEmail, q ?? '', sort].join('|');
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

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
            dateTimeFormat.format(new Date(value))
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
  const result = users.data;

  return (
    <>
      <PageHeader
        title="User accounts"
        description="Every sign-in for this school. Accounts are created by the office at admission or hiring."
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="grid w-full gap-1.5 sm:w-64">
          <Label htmlFor={ids.search}>Search</Label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={ids.search}
              type="search"
              value={search}
              maxLength={100}
              placeholder="Name"
              className="pl-8"
              aria-describedby={hint ? `${ids.search}-hint` : undefined}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {hint && (
            <p id={`${ids.search}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
        <Filter id={ids.status} label="Status" value={status} onChange={setStatus}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </Filter>
        <Filter id={ids.kind} label="Account type" value={kind} onChange={setKind}>
          <option value="">All types</option>
          <option value="staff">Staff</option>
          <option value="guardian">Parents</option>
          <option value="student">Students</option>
        </Filter>
        <Filter id={ids.password} label="Password" value={passwordIsDefault} onChange={setPasswordIsDefault}>
          <option value="">Any password</option>
          <option value="true">Still default</option>
          <option value="false">Changed</option>
        </Filter>
        <Filter id={ids.email} label="Email" value={hasEmail} onChange={setHasEmail}>
          <option value="">Any email</option>
          <option value="false">No email</option>
          <option value="true">Has email</option>
        </Filter>
      </div>
      <DataTable
        columns={columns}
        data={result?.data ?? NO_ROWS}
        getRowId={(row) => row.id}
        page={result?.page ?? page}
        limit={result?.limit ?? LIMIT}
        total={result?.total ?? 0}
        onPageChange={setPage}
        isLoading={users.isPending || users.isPlaceholderData}
        error={users.error}
        onRetry={() => void users.refetch()}
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

function Filter<T extends string>({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid w-full gap-1.5 sm:w-40">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {children}
      </NativeSelect>
    </div>
  );
}
