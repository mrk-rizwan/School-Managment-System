'use client';

import { Capability } from '@asms/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { EmptyState, ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import {
  academics,
  type AcademicYearDto,
  type ClassDto,
  type ClassListQuery,
  type ClassSort,
} from '@/lib/api/school-academics-contract';
import { useCapabilities } from '../_lib/hooks';
import {
  ATTENDANCE_MODE_LABELS,
  ArchiveDialog,
  ArchivedBadge,
  ShowArchivedToggle,
  RowActions,
  YEAR_STATUS_LABELS,
  academicsKeys,
  type RowAction,
} from '../_lib/academics-ui';
import { ClassFormDialog, CopySectionsDialog, useYearOptions } from './class-dialogs';

const LIMIT = 25;
const NO_ROWS: ClassDto[] = [];

/** The year shown when none is chosen: the first active one, else the newest. */
function defaultYear(years: AcademicYearDto[]): AcademicYearDto | undefined {
  return years.find((y) => y.status === 'active') ?? years[0];
}

/** contracts/slice-3.md §8: the year select drives the table. */
export function ClassList({ initialYearId }: { initialYearId?: string }) {
  const years = useYearOptions();
  const [chosenYearId, setChosenYearId] = useState(initialYearId ?? '');
  const yearSelectId = useId();

  const frame = (children: React.ReactNode) => (
    <div className="rounded-lg border bg-card">{children}</div>
  );
  if (years.isPending) return frame(<LoadingState rows={4} />);
  if (years.error) {
    return frame(
      isPermissionDenied(years.error) ? (
        <NoPermissionState />
      ) : (
        <ErrorState error={years.error} onRetry={() => void years.refetch()} />
      ),
    );
  }
  const yearList = years.data.data;
  if (yearList.length === 0) {
    return frame(
      <EmptyState
        title="No academic years yet"
        description="Classes belong to an academic year. Create one first."
        action={
          <Link href="/academics/years" className={buttonVariants({ variant: 'outline' })}>
            Go to academic years
          </Link>
        }
      />,
    );
  }

  const year = yearList.find((y) => y.id === chosenYearId) ?? defaultYear(yearList)!;
  const chooseYear = (id: string) => {
    setChosenYearId(id);
    // Keeps the choice in the address (for Back from a class) without a server round trip.
    window.history.replaceState(null, '', `?year=${encodeURIComponent(id)}`);
  };

  return (
    <ClassesOfYear
      key={year.id}
      year={year}
      years={yearList}
      yearSelect={
        <div className="grid w-full gap-1.5 sm:w-56">
          <Label htmlFor={yearSelectId}>Academic year</Label>
          <NativeSelect
            id={yearSelectId}
            value={year.id}
            onChange={(event) => chooseYear(event.target.value)}
          >
            {yearList.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name} ({YEAR_STATUS_LABELS[y.status].toLowerCase()})
              </option>
            ))}
          </NativeSelect>
        </div>
      }
    />
  );
}

function ClassesOfYear({
  year,
  years,
  yearSelect,
}: {
  year: AcademicYearDto;
  years: AcademicYearDto[];
  yearSelect: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const yearOpen = year.status !== 'closed';
  const canManage = can(Capability.CLASS_MANAGE) && yearOpen;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<ClassSort>('sortOrder');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ClassDto | { yearId: string } | null>(null);
  const [copyInto, setCopyInto] = useState<ClassDto | null>(null);
  const [archiving, setArchiving] = useState<ClassDto | null>(null);

  const filterKey = `${sort}|${showArchived}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query: ClassListQuery = {
    academicYearId: year.id,
    page,
    limit: LIMIT,
    sort,
    ...(!showArchived && { status: 'active' }),
  };
  const classes = useQuery({
    queryKey: [...academicsKeys.classes, 'list', query],
    queryFn: () => unwrap(academics.GET('/api/v1/classes', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ClassDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Class" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <span className="flex items-center gap-2">
            <Link
              href={`/academics/classes/${info.row.original.id}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {info.getValue()}
            </Link>
            {info.row.original.status === 'archived' && <ArchivedBadge />}
          </span>
        ),
      }),
      column.accessor('sortOrder', {
        header: () => <SortHeader field="sortOrder" label="Order" sort={sort} onSort={setSort} />,
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
      column.accessor('attendanceMode', {
        header: 'Attendance',
        cell: (info) => ATTENDANCE_MODE_LABELS[info.getValue()],
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const klass = info.row.original;
          const actions: RowAction[] =
            canManage && klass.status === 'active'
              ? [
                  { label: 'Edit', onSelect: () => setEditing(klass) },
                  { label: 'Copy sections from…', onSelect: () => setCopyInto(klass) },
                  { label: 'Archive', onSelect: () => setArchiving(klass), destructive: true },
                ]
              : [];
          return <RowActions label={klass.name} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage]);

  const result = classes.data;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          {yearSelect}
          <ShowArchivedToggle checked={showArchived} onChange={setShowArchived} />
        </div>
        {canManage && (
          <Button onClick={() => setEditing({ yearId: year.id })}>
            <PlusIcon />
            New class
          </Button>
        )}
      </div>
      {!yearOpen && (
        <p className="mb-4 text-sm text-muted-foreground">
          {year.name} is closed. Its classes are kept for the record and cannot be changed.
        </p>
      )}
      <DataTable
        columns={columns}
        data={result?.data ?? NO_ROWS}
        getRowId={(row) => row.id}
        page={result?.page ?? page}
        limit={result?.limit ?? LIMIT}
        total={result?.total ?? 0}
        onPageChange={setPage}
        isLoading={classes.isPending || classes.isPlaceholderData}
        error={classes.error}
        onRetry={() => void classes.refetch()}
        emptyTitle={`No classes in ${year.name}`}
        emptyDescription={
          canManage ? 'Add the classes this session teaches.' : 'Classes added to this year appear here.'
        }
      />
      <ClassFormDialog target={editing} years={years} onClose={() => setEditing(null)} />
      <CopySectionsDialog target={copyInto} years={years} onClose={() => setCopyInto(null)} />
      <ArchiveDialog
        target={archiving?.name ?? null}
        noun="class"
        onClose={() => setArchiving(null)}
        archive={(reason) =>
          unwrap(
            academics.POST('/api/v1/classes/{id}/archive', {
              params: { path: { id: archiving!.id } },
              body: reason ? { reason } : {},
            }),
          )
        }
        onArchived={() => void queryClient.invalidateQueries({ queryKey: academicsKeys.classes })}
      />
    </>
  );
}
