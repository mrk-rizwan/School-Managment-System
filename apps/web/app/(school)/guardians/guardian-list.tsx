'use client';

import { CONTACT_CAPABILITIES, Capability, DEFAULT_TIMEZONE, containsIdentityNumber } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import {
  guardiansApi,
  type ContactCapability,
  type GuardianDto,
  type GuardianListQuery,
  type GuardianSort,
} from '@/lib/api/school-guardians-contract';
import { useCapabilities, useDebounced } from '../academics/_lib/hooks';
import { GuardianLookupDialog } from './_lib/guardian-lookup';
import {
  CONTACT_CAPABILITY_LABELS,
  MissingBadge,
  guardiansKeys,
} from './_lib/guardians-ui';

const LIMIT = 25;
const NO_ROWS: GuardianDto[] = [];
type Flag = '' | 'true' | 'false';

/**
 * `q` is sent only when the API would accept it (contracts/slice-5.md §3.1): 2–100 characters
 * and never an identity number, which goes to the POST lookup instead.
 */
function searchTerm(raw: string): { q?: string; identity?: boolean; hint?: string } {
  const q = raw.trim();
  if (q.length === 0) return {};
  // Spaces and dashes are ignored, so "35201 1234567 1" is caught too.
  if (containsIdentityNumber(q.replace(/[\s-]/g, ''))) {
    return { identity: true };
  }
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  return { q: q.slice(0, 100) };
}

export function GuardianList() {
  const { can } = useCapabilities();
  const canCreate = can(Capability.GUARDIAN_MANAGE);
  const canLookup = can(Capability.GUARDIAN_MANAGE) || can(Capability.STUDENT_CREATE);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<GuardianSort>('fullName');
  const [search, setSearch] = useState('');
  const [capability, setCapability] = useState<ContactCapability | ''>('');
  const [hasCnic, setHasCnic] = useState<Flag>('');
  const [hasPhone, setHasPhone] = useState<Flag>('');
  const [hasLogin, setHasLogin] = useState<Flag>('');
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupCnic, setLookupCnic] = useState<string | undefined>();
  const ids = { search: useId(), capability: useId(), cnic: useId(), phone: useId(), login: useId() };

  // The identity check runs on the live text, so 13 digits are never sent, not even debounced.
  const live = searchTerm(search);
  const debounced = searchTerm(useDebounced(search));
  const q = live.identity ? undefined : debounced.q;

  const filterKey = [sort, q, capability, hasCnic, hasPhone, hasLogin].join('|');
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query: GuardianListQuery = {
    page,
    limit: LIMIT,
    sort,
    status: 'active',
    ...(q && { q }),
    ...(capability && { contactCapability: capability }),
    ...(hasCnic && { hasCnic: hasCnic === 'true' }),
    ...(hasPhone && { hasPhone: hasPhone === 'true' }),
    ...(hasLogin && { hasLogin: hasLogin === 'true' }),
  };
  const guardians = useQuery({
    queryKey: [...guardiansKeys.list, query],
    queryFn: () => unwrap(guardiansApi.GET('/api/v1/guardians', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const openLookupWithSearch = () => {
    // The digits move into the lookup form and leave the search box.
    setLookupCnic(search.replace(/\D/g, ''));
    setSearch('');
    setLookupOpen(true);
  };

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, GuardianDto>();
    return [
      column.accessor('fullName', {
        header: () => <SortHeader field="fullName" label="Name" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <Link
            href={`/guardians/${info.row.original.id}`}
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
        cell: (info) =>
          info.getValue() ? (
            <span className="tabular-nums">{info.getValue()}</span>
          ) : (
            <MissingBadge>No phone</MissingBadge>
          ),
      }),
      column.accessor('contactCapability', {
        header: 'Reached by',
        cell: (info) => CONTACT_CAPABILITY_LABELS[info.getValue()],
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
      column.accessor('createdAt', {
        header: () => <SortHeader field="createdAt" label="Added" sort={sort} onSort={setSort} />,
        cell: (info) => formatDate(info.getValue()),
      }),
    ];
  }, [sort]);

  const filtered = Boolean(q || capability || hasCnic || hasPhone || hasLogin);
  const result = guardians.data;
  const hint = live.identity ? null : debounced.hint;

  return (
    <>
      <PageHeader
        title="Guardians"
        description="Parents and other guardians of the school's students."
        actions={
          <>
            {canLookup && (
              <Button variant="outline" onClick={() => setLookupOpen(true)}>
                <SearchIcon />
                Find by CNIC or phone
              </Button>
            )}
            {canCreate && (
              <Link href="/guardians/new" className={buttonVariants()}>
                <PlusIcon />
                New guardian
              </Link>
            )}
          </>
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
              placeholder="Name or phone"
              className="pl-8"
              aria-describedby={hint || live.identity ? `${ids.search}-hint` : undefined}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {live.identity ? (
            <p id={`${ids.search}-hint`} className="text-xs text-muted-foreground">
              That looks like a CNIC.{' '}
              {canLookup ? (
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={openLookupWithSearch}
                >
                  Use Find by CNIC
                </button>
              ) : (
                'Search by name or phone.'
              )}
            </p>
          ) : (
            hint && (
              <p id={`${ids.search}-hint`} className="text-xs text-muted-foreground">
                {hint}
              </p>
            )
          )}
        </div>
        <FilterSelect id={ids.capability} label="Reached by" value={capability} onChange={(v) => setCapability(v as ContactCapability | '')}>
          <option value="">Any</option>
          {CONTACT_CAPABILITIES.map((c) => (
            <option key={c} value={c}>
              {CONTACT_CAPABILITY_LABELS[c]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect id={ids.cnic} label="CNIC" value={hasCnic} onChange={(v) => setHasCnic(v as Flag)}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No CNIC</option>
        </FilterSelect>
        <FilterSelect id={ids.phone} label="Phone" value={hasPhone} onChange={(v) => setHasPhone(v as Flag)}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No phone</option>
        </FilterSelect>
        <FilterSelect id={ids.login} label="Login" value={hasLogin} onChange={(v) => setHasLogin(v as Flag)}>
          <option value="">Any</option>
          <option value="true">Has login</option>
          <option value="false">No login</option>
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
        isLoading={guardians.isPending || guardians.isPlaceholderData}
        error={guardians.error}
        onRetry={() => void guardians.refetch()}
        emptyTitle={filtered ? 'No guardians match' : 'No guardians yet'}
        emptyDescription={
          filtered
            ? 'Try a different search or filter.'
            : 'Guardians are added at admission, or here.'
        }
      />
      <GuardianLookupDialog
        open={lookupOpen}
        initialCnic={lookupCnic}
        onOpenChange={(open) => {
          setLookupOpen(open);
          if (!open) setLookupCnic(undefined);
        }}
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

// Pakistan time (CLAUDE.md: Asia/Karachi is assumed for every school); fixed so server and browser agree.
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: DEFAULT_TIMEZONE });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));
