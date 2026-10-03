'use client';

import { CONTACT_CAPABILITIES, Capability } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import {
  DataTable,
  type DataTableFeatures,
  MissingBadge,
  SortHeader,
} from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import {
  guardiansApi,
  type ContactCapability,
  type GuardianDto,
  type GuardianListQuery,
  type GuardianSort,
} from '@/lib/api/school-guardians-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { useCapabilities } from '@/lib/school-session';
import { GuardianLookupDialog } from './_lib/guardian-lookup';
import { CONTACT_CAPABILITY_LABELS, guardiansKeys } from './_lib/guardians-ui';

const LIMIT = 25;
type Flag = '' | 'true' | 'false';

// `q` is sent only when the API would accept it (contracts/slice-5.md §3.1); an identity number
// goes to the POST lookup instead.
export function GuardianList() {
  const { can } = useCapabilities();
  const canCreate = can(Capability.GUARDIAN_MANAGE);
  const canLookup = can(Capability.GUARDIAN_MANAGE) || can(Capability.STUDENT_CREATE);
  const [sort, setSort] = useState<GuardianSort>('fullName');
  const [search, setSearch] = useState('');
  const [capability, setCapability] = useState<ContactCapability | ''>('');
  const [hasCnic, setHasCnic] = useState<Flag>('');
  const [hasPhone, setHasPhone] = useState<Flag>('');
  const [hasLogin, setHasLogin] = useState<Flag>('');
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupCnic, setLookupCnic] = useState<string | undefined>();
  const { q, identity, hint } = useListSearch(search);
  const [page, setPage] = useListPage([sort, q, capability, hasCnic, hasPhone, hasLogin]);

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
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Name or phone"
          hint={
            identity ? (
              <>
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
              </>
            ) : (
              hint
            )
          }
        />
        <FilterSelect label="Reached by" value={capability} onChange={setCapability}>
          <option value="">Any</option>
          {CONTACT_CAPABILITIES.map((c) => (
            <option key={c} value={c}>
              {CONTACT_CAPABILITY_LABELS[c]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="CNIC" value={hasCnic} onChange={setHasCnic}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No CNIC</option>
        </FilterSelect>
        <FilterSelect label="Phone" value={hasPhone} onChange={setHasPhone}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">No phone</option>
        </FilterSelect>
        <FilterSelect label="Login" value={hasLogin} onChange={setHasLogin}>
          <option value="">Any</option>
          <option value="true">Has login</option>
          <option value="false">No login</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={guardians}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
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
