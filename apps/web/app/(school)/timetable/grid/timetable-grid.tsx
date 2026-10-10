'use client';

import { weekdayOf } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useState } from 'react';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { timetableApi, type TimetableGridDto } from '@/lib/api/school-timetable-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useDefaultYearId, YearFilter } from '../../reports/_lib/reports-ui';
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from '../../settings/_lib/settings-ui';
import { periodsOf, timetableKeys, weekHref } from '../_lib/timetable-ui';

// contracts/slice-37.md §2.8: the year's sections × periods for one weekday, each section from
// its version live on the date.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function TimetableGrid() {
  const today = todayInSchool();
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const [date, setDate] = useState(today);
  const [weekday, setWeekday] = useState('');
  const dateValid = DATE.test(date);
  const day = weekday === '' && dateValid ? String(weekdayOf(date)) : weekday;
  const query = { academicYearId: yearId, date, weekday: Number(day) };
  const grid = useQuery({
    queryKey: timetableKeys.grid(query),
    queryFn: () => unwrap(timetableApi.GET('/api/v1/timetable/grid', { params: { query } })),
    enabled: yearId !== '' && dateValid && day !== '',
    placeholderData: keepPreviousData,
  });
  const dateId = useId();
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={yearId} onChange={setChosenYear} />
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={dateId}>Timetables in use on</Label>
          <Input id={dateId} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <FilterSelect label="Day" value={day} onChange={setWeekday}>
          {WEEKDAY_ORDER.map((w) => (
            <option key={w} value={String(w)}>
              {WEEKDAY_LABELS[w]}
            </option>
          ))}
        </FilterSelect>
      </div>
      {!dateValid ? (
        <StateCard>
          <EmptyState title="Choose a date" description="The grid shows the timetables in use on that date." />
        </StateCard>
      ) : (
        <QueryStates query={grid} loadingRows={8}>
          {(data) => <GridTable grid={data} />}
        </QueryStates>
      )}
    </>
  );
}

function GridTable({ grid }: { grid: TimetableGridDto }) {
  if (grid.sections.length === 0) {
    return (
      <StateCard>
        <EmptyState title="No sections" description="This academic year has no sections yet." />
      </StateCard>
    );
  }
  const off = grid.weeklyOffDays.includes(grid.weekday);
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        {WEEKDAY_LABELS[grid.weekday]}, from the timetables in use on {formatDay(grid.date)}
        {off && ' · a weekly-off day'}.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Section</TableHead>
              {periodsOf(grid.periodsPerDay).map((p) => (
                <TableHead key={p} className="min-w-32">
                  Period {p}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.sections.map((s) => (
              <TableRow key={s.sectionId}>
                <TableCell className="px-4 align-top font-medium whitespace-nowrap">
                  <Link href={weekHref(s.sectionId)} className="hover:underline">
                    {s.className} {s.sectionName}
                  </Link>
                  {s.versionId === null && <span className="block text-xs font-normal text-muted-foreground">No timetable</span>}
                </TableCell>
                {periodsOf(grid.periodsPerDay).map((p) => {
                  const cell = s.cells.find((c) => c.period === p);
                  return (
                    <TableCell key={p} className="align-top" data-testid={`grid.cell.${s.sectionId}.${p}`}>
                      {cell ? (
                        <span className="grid gap-0.5 text-sm">
                          <span className="font-medium">{cell.subjectName}</span>
                          <span className="text-muted-foreground">{cell.teacherName}</span>
                          {!cell.assignedTeacher && (
                            <Badge variant="destructive" className="w-fit">
                              No assigned teacher
                            </Badge>
                          )}
                          {cell.room && <span className="text-xs text-muted-foreground">Room {cell.room}</span>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
