'use client';

import { Capability } from '@asms/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  DataTable,
  type DataTableFeatures,
  type RowAction,
  RowActions,
  SortHeader,
} from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Button, buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import {
  academics,
  type AcademicYearDto,
  type ClassDto,
  type ClassListQuery,
  type ClassSort,
} from '@/lib/api/school-academics-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import {
  academicsKeys,
  ArchivedBadge,
  ArchiveDialog,
  ATTENDANCE_MODE_LABELS,
  ShowArchivedToggle,
  YEAR_STATUS_LABELS,
} from '../_lib/academics-ui';
import { useYears } from '../_lib/options';
import { ClassFormDialog, CopySectionsDialog } from './class-dialogs';

const LIMIT = 25;

/** The year shown when none is chosen: the first active one, else the newest. */
function defaultYear(years: AcademicYearDto[]): AcademicYearDto | undefined {
  return years.find((y) => y.status === 'active') ?? years[0];
}

/** contracts/slice-3.md §8: the year select drives the table. */
export function ClassList({ initialYearId }: { initialYearId?: string }) {
  const years = useYears();
  const [chosenYearId, setChosenYearId] = useState(initialYearId ?? '');

  return (
    <QueryStates query={years} loadingRows={4}>
      {({ data: yearList }) => {
        if (yearList.length === 0) {
          return (
            <StateCard>
              <EmptyState
                title="No academic years yet"
                description="Classes belong to an academic year. Create one first."
                action={
                  <Link href="/academics/years" className={buttonVariants({ variant: 'outline' })}>
                    Go to academic years
                  </Link>
                }
              />
            </StateCard>
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
              <FilterSelect label="Academic year" value={year.id} onChange={chooseYear} className="sm:w-56">
                {yearList.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name} ({YEAR_STATUS_LABELS[y.status].toLowerCase()})
                  </option>
                ))}
              </FilterSelect>
            }
          />
        );
      }}
    </QueryStates>
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
  const [sort, setSort] = useState<ClassSort>('sortOrder');
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useListPage([sort, showArchived]);
  const [editing, setEditing] = useState<ClassDto | { yearId: string } | null>(null);
  const [copyInto, setCopyInto] = useState<ClassDto | null>(null);
  const [archiving, setArchiving] = useState<ClassDto | null>(null);

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
        query={classes}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
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
