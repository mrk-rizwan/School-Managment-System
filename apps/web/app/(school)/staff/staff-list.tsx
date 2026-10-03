'use client';

import { Capability, SYSTEM_ROLES, containsIdentityNumber } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import {
  staffApi,
  type StaffDto,
  type StaffListQuery,
  type StaffSort,
  type StaffStatus,
  type SystemRole,
} from '@/lib/api/school-staff-contract';
import { useCapabilities, useDebounced } from '../academics/_lib/hooks';
import { MissingBadge } from '../guardians/_lib/guardians-ui';
import { ROLE_LABELS, STAFF_STATUS_LABELS, StaffStatusBadge, staffKeys } from './_lib/staff-ui';

const LIMIT = 25;
const NO_ROWS: StaffDto[] = [];
type Flag = '' | 'true' | 'false';

/**
 * `q` is sent only when the API would accept it (contracts/slice-4.md §3.1): 2–100 characters
 * and never an identity number. Staff have no CNIC lookup, so a CNIC is refused with a message.
 */
function searchTerm(raw: string): { q?: string; identity?: boolean; hint?: string } {
  const q = raw.trim();
  if (q.length === 0) return {};
  // Spaces and dashes are ignored, so "35201 1234567 1" is caught too.
  if (containsIdentityNumber(q.replace(/[\s-]/g, ''))) return { identity: true };
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  return { q: q.slice(0, 100) };
}

export function StaffList() {
  const { can } = useCapabilities();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<StaffSort>('fullName');
  const [search, setSearch] = useState('');
  // The web asks for active staff by default (§3.1).
  const [status, setStatus] = useState<StaffStatus | ''>('active');
  const [role, setRole] = useState<SystemRole | ''>('');
  const [hasLogin, setHasLogin] = useState<Flag>('');
  const [hasCnic, setHasCnic] = useState<Flag>('');
  const ids = { search: useId(), status: useId(), role: useId(), login: useId(), cnic: useId() };

  // The identity check runs on the live text, so 13 digits are never sent, not even debounced.
  const live = searchTerm(search);
  const debounced = searchTerm(useDebounced(search));
  const q = live.identity ? undefined : debounced.q;

  const filterKey = [sort, q, status, role, hasLogin, hasCnic].join('|');
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

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
        cell: (info) =>
          info.getValue().length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {info.getValue().map((r) => (
                <Badge key={r} variant="outline">
                  {ROLE_LABELS[r]}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
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
  const result = staff.data;
  const hint = live.identity ? null : debounced.hint;

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
        <div className="grid w-full gap-1.5 sm:w-72">
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
              autoComplete="off"
              placeholder="Name, designation or phone"
              className="pl-8"
              aria-describedby={hint || live.identity ? `${ids.search}-hint` : undefined}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {(live.identity || hint) && (
            <p
              id={`${ids.search}-hint`}
              className={live.identity ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {live.identity
                ? 'Staff cannot be searched by CNIC. Search by name, designation or phone.'
                : hint}
            </p>
          )}
        </div>
        <FilterSelect id={ids.status} label="Status" value={status} onChange={(v) => setStatus(v as StaffStatus | '')}>
          <option value="">Any</option>
          {(Object.keys(STAFF_STATUS_LABELS) as StaffStatus[]).map((s) => (
            <option key={s} value={s}>
              {STAFF_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect id={ids.role} label="Role" value={role} onChange={(v) => setRole(v as SystemRole | '')}>
          <option value="">Any</option>
          {SYSTEM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect id={ids.login} label="Login" value={hasLogin} onChange={(v) => setHasLogin(v as Flag)}>
          <option value="">Any</option>
          <option value="true">Has login</option>
          <option value="false">No login</option>
        </FilterSelect>
        <FilterSelect id={ids.cnic} label="CNIC" value={hasCnic} onChange={(v) => setHasCnic(v as Flag)}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No CNIC</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        data={result?.data ?? NO_ROWS}
        getRowId={(row) => row.id}
        page={result?.page ?? page}
        limit={result?.limit ?? LIMIT}
        total={result?.total ?? 0}
        onPageChange={setPage}
        isLoading={staff.isPending || staff.isPlaceholderData}
        error={staff.error}
        onRetry={() => void staff.refetch()}
        emptyTitle={filtered ? 'No staff match' : 'No staff yet'}
        emptyDescription={
          filtered ? 'Try a different search or filter.' : 'Add each member of staff when they are hired.'
        }
      />
    </>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid w-full gap-1.5 sm:w-40">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </NativeSelect>
    </div>
  );
}
