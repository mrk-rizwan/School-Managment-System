'use client';

import { addDaysTo, Capability } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import {
  timetableApi,
  type SectionTimetableDayDto,
  type SectionTimetableDto,
} from '@/lib/api/school-timetable-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { mySections } from '../attendance/_lib/attendance-ui';
import { useDefaultYearId, YearFilter } from '../reports/_lib/reports-ui';
import { WEEKDAY_LABELS } from '../settings/_lib/settings-ui';
import { editHref, periodsOf, SectionSelect, timetableKeys } from './_lib/timetable-ui';

// contracts/slice-37.md §2.6, §7: a section's Monday-Sunday week. Each day shows the version
// live on it, its lessons and that day's substitutions; a lesson whose teacher no longer holds
// the assignment says "No assigned teacher" (R303). Every staff member reads any section;
// `timetable.manage` holders also get Edit.

export function TimetableWeek({ initialSectionId }: { initialSectionId?: string }) {
  const me = useSchoolMe();
  const { can } = useCapabilities();
  const today = todayInSchool();
  const [chosenSection, setChosenSection] = useState('');
  const [chosenYear, setChosenYear] = useState('');
  const [date, setDate] = useState(today);
  // The section: the one picked, else the link's, else the caller's first section today.
  const sectionId = chosenSection || initialSectionId || mySections(me.data, today)[0]?.sectionId || '';
  const week = useQuery({
    queryKey: timetableKeys.week(sectionId, date),
    queryFn: () =>
      unwrap(
        timetableApi.GET('/api/v1/sections/{id}/timetable', {
          params: { path: { id: sectionId }, query: { date } },
        }),
      ),
    enabled: sectionId !== '',
    placeholderData: keepPreviousData,
  });
  const defaultYear = useDefaultYearId(chosenYear);
  const yearId = chosenYear || week.data?.section.academicYearId || defaultYear;
  const canEdit = can(Capability.TIMETABLE_MANAGE);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
          <YearFilter
            value={yearId}
            onChange={(id) => {
              setChosenYear(id);
              setChosenSection('');
            }}
          />
          <SectionSelect yearId={yearId} value={sectionId} onChange={setChosenSection} />
        </div>
        {canEdit && sectionId !== '' && (
          <Link href={editHref(sectionId)} className={buttonVariants()}>
            <PencilIcon aria-hidden />
            Edit
          </Link>
        )}
      </div>
      {sectionId === '' ? (
        <StateCard>
          <EmptyState title="Choose a section" description="Pick a section to see its week." />
        </StateCard>
      ) : (
        <QueryStates
          query={week}
          loadingRows={8}
          notFound={{ title: 'Section not found', description: 'It may have been archived. Choose another section.' }}
        >
          {(data) => <WeekTable week={data} onWeek={setDate} canEdit={canEdit} />}
        </QueryStates>
      )}
    </>
  );
}

function WeekTable({
  week,
  onWeek,
  canEdit,
}: {
  week: SectionTimetableDto;
  onWeek: (date: string) => void;
  canEdit: boolean;
}) {
  const days = week.days.filter((d) => d.teachingDay || d.slots.length > 0);
  const offDays = week.days.filter((d) => !days.includes(d));
  const empty = week.days.every((d) => d.versionId === null);
  return (
    <section aria-label={`${week.section.className} ${week.section.name} timetable`} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {week.section.className} {week.section.name} · week of {formatDay(week.weekOf)}
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onWeek(addDaysTo(week.weekOf, -7))}>
            <ChevronLeftIcon aria-hidden />
            Previous week
          </Button>
          <Button variant="outline" size="sm" onClick={() => onWeek(addDaysTo(week.weekOf, 7))}>
            Next week
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      </div>
      {empty ? (
        <StateCard>
          <EmptyState
            title="No timetable this week"
            description={
              canEdit
                ? 'This section has no timetable in force this week. Use Edit to set one up.'
                : 'This section has no timetable in force this week.'
            }
          />
        </StateCard>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 px-4">Period</TableHead>
                {days.map((d) => (
                  <TableHead key={d.date} className="min-w-36">
                    <span className="grid">
                      <span>{WEEKDAY_LABELS[d.weekday]}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatDay(d.date)}
                        {!d.teachingDay && ' · no school'}
                      </span>
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {periodsOf(week.periodsPerDay).map((period) => (
                <TableRow key={period}>
                  <TableCell className="px-4 font-medium">{period}</TableCell>
                  {days.map((d) => (
                    <TableCell key={d.date} className="align-top">
                      <WeekCell day={d} period={period} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {offDays.length > 0 && (
        <p className="text-xs text-muted-foreground">
          No school on {offDays.map((d) => WEEKDAY_LABELS[d.weekday]).join(', ')}.
        </p>
      )}
    </section>
  );
}

function WeekCell({ day, period }: { day: SectionTimetableDayDto; period: number }) {
  const slot = day.slots.find((s) => s.period === period);
  const sub = day.substitutions.find((s) => s.period === period);
  if (!slot) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="grid gap-0.5 text-sm" data-testid={`week.cell.${day.weekday}.${period}`}>
      <span className="font-medium">{slot.subjectName}</span>
      <span className={sub ? 'text-muted-foreground line-through' : 'text-muted-foreground'}>{slot.teacherName}</span>
      {!slot.assignedTeacher && (
        <Badge variant="destructive" className="w-fit">
          No assigned teacher
        </Badge>
      )}
      {sub && (
        <Badge variant="secondary" className="w-fit">
          Substitute: {sub.teacherName}
        </Badge>
      )}
      {slot.room && <span className="text-xs text-muted-foreground">Room {slot.room}</span>}
    </div>
  );
}
