'use client';

import { Capability, STUDENT_STATUSES, containsIdentityNumber, normaliseIdentityDigits } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import {
  studentsApi,
  type StudentDto,
  type StudentListQuery,
  type StudentSort,
  type StudentStatus,
} from '@/lib/api/school-students-contract';
import { formatDay } from '../academics/_lib/academics-ui';
import { useCapabilities, useDebounced } from '../academics/_lib/hooks';
import { formatIdentityInput } from '../guardians/_lib/guardians-ui';
import { NO_PLACEMENT, PlacementSelects, type Placement } from './_lib/placement';
import {
  STUDENT_STATUS_LABELS,
  StudentStatusBadge,
  placeLabel,
  studentsKeys,
} from './_lib/students-ui';

const LIMIT = 25;
const NO_ROWS: StudentDto[] = [];
type Flag = '' | 'true' | 'false';

/**
 * `q` is sent only when the API would accept it (contracts/slice-6.md §3.1): 2–100 characters
 * and never a B-Form number, which goes to the POST lookup instead.
 */
function searchTerm(raw: string): { q?: string; identity?: boolean; hint?: string } {
  const q = raw.trim();
  if (q.length === 0) return {};
  if (containsIdentityNumber(q.replace(/[\s-]/g, ''))) return { identity: true };
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  return { q: q.slice(0, 100) };
}

/** contracts/slice-6.md §3.1 and §10. A teacher sees only their sections: the API scopes the rows. */
export function StudentList() {
  const { can } = useCapabilities();
  const canAdmit = can(Capability.STUDENT_CREATE);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<StudentSort>('fullName');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StudentStatus | ''>('active');
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const [hasLogin, setHasLogin] = useState<Flag>('');
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupDigits, setLookupDigits] = useState<string | undefined>();
  const ids = { search: useId(), status: useId(), login: useId() };

  // The identity check runs on the live text, so 13 digits are never sent, not even debounced.
  const live = searchTerm(search);
  const debounced = searchTerm(useDebounced(search));
  const q = live.identity ? undefined : debounced.q;

  const { academicYearId, classId, sectionId } = placement;
  const filterKey = [sort, q, status, academicYearId, classId, sectionId, hasLogin].join('|');
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query: StudentListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(q && { q }),
    ...(academicYearId && { academicYearId }),
    ...(classId && { classId }),
    ...(sectionId && { sectionId }),
    ...(hasLogin && { hasLogin: hasLogin === 'true' }),
  };
  const students = useQuery({
    queryKey: [...studentsKeys.list, query],
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const openLookupWithSearch = () => {
    // The digits move into the lookup form and leave the search box.
    setLookupDigits(search.replace(/\D/g, ''));
    setSearch('');
    setLookupOpen(true);
  };

  const columns = useMemo(() => {
    // SortHeader toggles to `-field`; every sortable column here allows both directions.
    const onSort = (value: string) => setSort(value as StudentSort);
    const column = createColumnHelper<DataTableFeatures, StudentDto>();
    return [
      column.accessor('fullName', {
        header: () => <SortHeader field="fullName" label="Name" sort={sort} onSort={onSort} />,
        cell: (info) => (
          <Link
            href={`/students/${info.row.original.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('admissionNo', {
        header: () => (
          <SortHeader field="admissionNo" label="Admission no." sort={sort} onSort={onSort} />
        ),
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
      column.display({
        id: 'class',
        header: 'Class',
        cell: (info) => placeLabel(info.row.original.current) ?? <span className="text-muted-foreground">—</span>,
      }),
      column.display({
        id: 'rollNo',
        // rollNo sorts ascending only (nulls last), so it has no descending toggle.
        header: () => (
          <button
            type="button"
            className="-mx-1 rounded px-1 font-medium hover:text-foreground"
            aria-pressed={sort === 'rollNo'}
            onClick={() => setSort('rollNo')}
          >
            Roll no.
          </button>
        ),
        cell: (info) => info.row.original.current?.rollNo ?? '—',
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <StudentStatusBadge status={info.getValue()} />,
      }),
      column.accessor('admittedOn', {
        header: () => (
          <SortHeader field="admittedOn" label="Admitted" sort={sort} onSort={onSort} />
        ),
        cell: (info) => formatDay(info.getValue()),
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
    ];
  }, [sort]);

  const filtered = Boolean(q || status !== 'active' || academicYearId || hasLogin);
  const result = students.data;
  const hint = live.identity ? null : debounced.hint;

  return (
    <>
      <PageHeader
        title="Students"
        description="Admissions, guardians, classes and documents."
        actions={
          canAdmit && (
            <>
              <Button variant="outline" onClick={() => setLookupOpen(true)}>
                <SearchIcon />
                Find by B-Form
              </Button>
              <Link href="/admissions/new" className={buttonVariants()}>
                <PlusIcon />
                New admission
              </Link>
            </>
          )
        }
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
              autoComplete="off"
              placeholder="Name or admission no."
              className="pl-8"
              aria-describedby={hint || live.identity ? `${ids.search}-hint` : undefined}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {live.identity ? (
            <p id={`${ids.search}-hint`} className="text-xs text-muted-foreground">
              That looks like a B-Form number.{' '}
              {canAdmit ? (
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={openLookupWithSearch}
                >
                  Use Find by B-Form
                </button>
              ) : (
                'Search by name or admission number.'
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
        <div className="grid w-full gap-1.5 sm:w-36">
          <Label htmlFor={ids.status}>Status</Label>
          <NativeSelect
            id={ids.status}
            value={status}
            onChange={(event) => setStatus(event.target.value as StudentStatus | '')}
          >
            <option value="">Any</option>
            {STUDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STUDENT_STATUS_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <PlacementSelects
          value={placement}
          onChange={setPlacement}
          anyLabel="Any"
          includeClosedYears
          compact
        />
        <div className="grid w-full gap-1.5 sm:w-36">
          <Label htmlFor={ids.login}>Login</Label>
          <NativeSelect
            id={ids.login}
            value={hasLogin}
            onChange={(event) => setHasLogin(event.target.value as Flag)}
          >
            <option value="">Any</option>
            <option value="true">Has login</option>
            <option value="false">No login</option>
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
        isLoading={students.isPending || students.isPlaceholderData}
        error={students.error}
        onRetry={() => void students.refetch()}
        emptyTitle={filtered ? 'No students match' : 'No students yet'}
        emptyDescription={
          filtered ? 'Try a different search or filter.' : 'Students are added by admission.'
        }
        emptyAction={
          canAdmit &&
          !filtered && (
            <Link href="/admissions/new" className={buttonVariants({ variant: 'outline' })}>
              New admission
            </Link>
          )
        }
      />
      {canAdmit && (
        <StudentLookupDialog
          open={lookupOpen}
          initialDigits={lookupDigits}
          onOpenChange={(open) => {
            setLookupOpen(open);
            if (!open) setLookupDigits(undefined);
          }}
        />
      )}
    </>
  );
}

/** POST /students/lookup (§3.4). The digits are cleared as soon as the request is sent. */
function StudentLookupDialog({
  open,
  onOpenChange,
  initialDigits,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDigits?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <LookupForm initialDigits={initialDigits} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function LookupForm({ initialDigits, onDone }: { initialDigits?: string; onDone: () => void }) {
  const id = useId();
  const [value, setValue] = useState(initialDigits ? formatIdentityInput(initialDigits) : '');
  const lookup = useMutation({
    mutationFn: (bForm: string) =>
      unwrap(studentsApi.POST('/api/v1/students/lookup', { body: { bForm } })),
  });
  const digits = normaliseIdentityDigits(value);
  const hit = lookup.data?.data[0];

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!digits || lookup.isPending) return;
        lookup.mutate(digits);
        setValue('');
      }}
    >
      <DialogHeader>
        <DialogTitle>Find by B-Form</DialogTitle>
        <DialogDescription>Look a student up by their B-Form or CRC number.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={id}>B-Form number</Label>
        <Input
          id={id}
          value={value}
          autoComplete="off"
          autoFocus
          inputMode="numeric"
          maxLength={15}
          placeholder="35201-1234567-1"
          onChange={(event) => setValue(formatIdentityInput(event.target.value))}
        />
      </div>
      {lookup.error && (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(lookup.error)}
        </p>
      )}
      {lookup.data && (
        <div role="status" className="text-sm">
          {hit ? (
            <p className="rounded-lg border p-3">
              <Link
                href={`/students/${hit.student.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {hit.student.fullName}
              </Link>
              <span className="text-muted-foreground">
                {' '}
                — admission no. {hit.student.admissionNo},{' '}
                {STUDENT_STATUS_LABELS[hit.student.status].toLowerCase()}
                {hit.student.current ? `, ${placeLabel(hit.student.current)}` : ''}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">No student has this B-Form number.</p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Close
        </Button>
        <Button type="submit" disabled={!digits || lookup.isPending}>
          {lookup.isPending ? 'Searching…' : 'Search'}
        </Button>
      </DialogFooter>
    </form>
  );
}
