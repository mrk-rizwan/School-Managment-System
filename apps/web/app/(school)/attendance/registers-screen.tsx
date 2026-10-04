'use client';

import { Capability } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ClipboardCheckIcon, DoorOpenIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import {
  attendanceApi,
  type RegisterListQuery,
  type RegisterListSort,
  type SectionDayDto,
} from '@/lib/api/school-attendance-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../students/_lib/placement';
import { ArrivalDialog } from './_lib/arrival-dialog';
import { AttendanceTabs, registerHref } from './_lib/attendance-nav';
import { attendanceKeys, timeOf } from './_lib/attendance-ui';

// contracts/slice-11.md §10.1, §13: the registers of a day, live (never the summary table), and
// the principal's "not recorded" tile above them.

const LIMIT = 25;
/** The tile is the console's live view: it refreshes on its own while the screen is open. */
const LIVE_MS = 60_000;

export function RegistersScreen() {
  const { can } = useCapabilities();
  const canMark = can(Capability.ATTENDANCE_STUDENT_MARK);
  const [arrivalOpen, setArrivalOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Attendance"
        description="Who has recorded today’s registers, and who has not."
        actions={
          canMark && (
            <>
              <Button variant="outline" onClick={() => setArrivalOpen(true)}>
                <DoorOpenIcon />
                Record arrival
              </Button>
              <Link href="/attendance/register" className={buttonVariants()}>
                <ClipboardCheckIcon />
                Take register
              </Link>
            </>
          )
        }
      />
      <AttendanceTabs />
      <div className="grid gap-6">
        <UnrecordedTile />
        <RegisterList />
      </div>
      <ArrivalDialog open={arrivalOpen} onOpenChange={setArrivalOpen} />
    </>
  );
}

/** "N registers not recorded" today, with who should record each and who is covering (§13). */
export function UnrecordedTile() {
  const { can } = useCapabilities();
  const today = todayInSchool();
  const query = { date: today, recorded: false, limit: OPTIONS_LIMIT, sort: 'className' } as const;
  const unrecorded = useQuery({
    queryKey: [...attendanceKeys.registers, query],
    queryFn: () => unwrap(attendanceApi.GET('/api/v1/attendance-registers', { params: { query } })),
    refetchInterval: LIVE_MS,
  });
  const rows = unrecorded.data?.data ?? [];
  const total = unrecorded.data?.total ?? 0;

  return (
    <Card data-testid="unrecorded-tile">
      <CardHeader>
        <CardTitle>
          {unrecorded.data
            ? total === 0
              ? 'Every register is recorded'
              : `${total} register${total === 1 ? '' : 's'} not recorded`
            : 'Registers not recorded'}
        </CardTitle>
        <CardDescription>Today, {formatDay(today)}. Updates every minute.</CardDescription>
      </CardHeader>
      <CardContent>
        {unrecorded.error ? (
          isPermissionDenied(unrecorded.error) ? (
            <NoPermissionState />
          ) : (
            <ErrorState error={unrecorded.error} onRetry={() => void unrecorded.refetch()} />
          )
        ) : !unrecorded.data ? (
          <LoadingState rows={2} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is waiting. Sections with no children on roll are not listed.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.sectionId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {row.className} {row.sectionName}
                  </p>
                  <p className="text-xs text-muted-foreground">{teacherLine(row)}</p>
                </div>
                <div className="flex gap-2">
                  {can(Capability.ATTENDANCE_STUDENT_MARK) && (
                    <Link
                      href={registerHref(row.sectionId, row.date)}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      aria-label={`Record ${row.className} ${row.sectionName}`}
                    >
                      Record
                    </Link>
                  )}
                  {/* Cover is arranged on the class teacher's assignment row (slice-10 §6), so the
                      link opens their Teaching assignments; no class teacher, nothing to cover. */}
                  {can(Capability.CLASS_MANAGE) && row.coverStaffIds.length === 0 && row.classTeacherStaffId && (
                    <Link
                      href={`/staff/${row.classTeacherStaffId}?tab=assignments`}
                      className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                      aria-label={`Arrange cover for ${row.className} ${row.sectionName}`}
                    >
                      Arrange cover
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function teacherLine(row: SectionDayDto): string {
  const teacher = row.classTeacherName ? `Class teacher ${row.classTeacherName}` : 'No class teacher';
  return row.coverStaffName ? `${teacher} · covered by ${row.coverStaffName}` : teacher;
}

type RecordedFilter = '' | 'yes' | 'no';

function RegisterList() {
  const today = todayInSchool();
  const dateId = useId();
  const [date, setDate] = useState(today);
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const [recorded, setRecorded] = useState<RecordedFilter>('');
  const [sort, setSort] = useState<RegisterListSort>('className');
  const [page, setPage] = useListPage([date, placement.classId, placement.sectionId, recorded, sort]);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today;

  const query: RegisterListQuery = {
    date,
    page,
    limit: LIMIT,
    sort,
    ...(placement.classId && { classId: placement.classId }),
    ...(placement.sectionId && { sectionId: placement.sectionId }),
    ...(recorded && { recorded: recorded === 'yes' }),
  };
  const list = useQuery({
    queryKey: [...attendanceKeys.registers, query],
    queryFn: () => unwrap(attendanceApi.GET('/api/v1/attendance-registers', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: validDate,
    refetchInterval: date === today ? LIVE_MS : false,
  });

  const column = createColumnHelper<DataTableFeatures, SectionDayDto>();
  const columns = [
    column.accessor('className', {
      header: () => <SortHeader field="className" label="Class" sort={sort} onSort={(s) => setSort(s as RegisterListSort)} />,
      cell: ({ row }) => row.original.className,
    }),
    column.accessor('sectionName', {
      header: () => <SortHeader field="sectionName" label="Section" sort={sort} onSort={(s) => setSort(s as RegisterListSort)} />,
    }),
    column.display({
      id: 'recorded',
      header: 'Registers',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={r.recorded ? 'secondary' : 'outline'}>
              {r.recorded ? `${r.registersRecorded} of ${r.registersExpected}` : 'Not recorded'}
            </Badge>
            {r.declaredHolidayAfter && <Badge variant="outline">Recorded on a day later declared a holiday</Badge>}
          </div>
        );
      },
    }),
    column.display({
      id: 'by',
      header: 'Recorded by',
      cell: ({ row }) =>
        row.original.submittedByName && row.original.submittedAt
          ? `${row.original.submittedByName}, ${timeOf(row.original.submittedAt)}`
          : '—',
    }),
    column.display({ id: 'teacher', header: 'Class teacher', cell: ({ row }) => teacherLine(row.original) }),
    column.accessor('rosterCount', { header: 'On roll' }),
    column.display({
      id: 'open',
      header: () => <span className="sr-only">Open</span>,
      cell: ({ row }) => (
        <Link
          href={registerHref(row.original.sectionId, row.original.date)}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          aria-label={`Open the register of ${row.original.className} ${row.original.sectionName}`}
        >
          Open
        </Link>
      ),
    }),
  ];

  return (
    <section className="grid gap-4" aria-label="Registers">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={dateId}>Date</Label>
          <Input id={dateId} type="date" max={today} value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <PlacementSelects value={placement} onChange={setPlacement} anyLabel="Any" includeClosedYears compact />
        <FilterSelect<RecordedFilter> label="Recorded" value={recorded} onChange={setRecorded}>
          <option value="">Any</option>
          <option value="no">Not recorded</option>
          <option value="yes">Recorded</option>
        </FilterSelect>
      </div>
      {!validDate ? (
        <p className="text-sm text-destructive">Choose a date that is not in the future.</p>
      ) : (
        <DataTable
          columns={columns}
          query={list}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          getRowId={(row) => row.sectionId}
          emptyTitle="No registers for this day"
          emptyDescription="Sections with children on roll that day appear here."
        />
      )}
    </section>
  );
}
