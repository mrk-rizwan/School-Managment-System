'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryStates } from '@/components/page-states';
import { unwrap } from '@/lib/api/client';
import { attendanceApi, type StudentDayDto } from '@/lib/api/school-attendance-contract';
import type { StudentDetailDto } from '@/lib/api/school-students-contract';
import { todayInSchool } from '@/lib/format';
import { STATUS_LABELS, attendanceKeys } from '../../attendance/_lib/attendance-ui';
import { MonthHeatMap, MonthNav, monthOf, monthRange, type HeatMapDay } from '../../attendance/_lib/month-heat-map';

// contracts/slice-11.md §10.4, §13 "Student → Attendance tab": a month's heat map and its
// percentage, "{n} recorded of {m} teaching days", or "no recorded days" — never 100 or 0 for
// a month with nothing counted.

const periodWords = (day: StudentDayDto) =>
  day.periods.length > 1
    ? day.periods
        .map((p) => `P${p.period} ${STATUS_LABELS[p.status].toLowerCase()}${p.arrivedAt ? ` ${p.arrivedAt}` : ''}`)
        .join(', ')
    : day.periods[0]?.arrivedAt
      ? `arrived ${day.periods[0].arrivedAt}`
      : undefined;

export function StudentAttendanceTab({ student }: { student: StudentDetailDto }) {
  const [month, setMonth] = useState(monthOf(todayInSchool()));
  const { from, to } = monthRange(month);
  const attendance = useQuery({
    queryKey: [...attendanceKeys.student(student.id), from, to],
    queryFn: () =>
      unwrap(
        attendanceApi.GET('/api/v1/students/{id}/attendance', {
          params: { path: { id: student.id }, query: { dateFrom: from, dateTo: to } },
        }),
      ),
  });

  return (
    <section className="grid gap-4" aria-label="Attendance">
      <MonthNav month={month} onChange={setMonth} />
      <QueryStates query={attendance} loadingRows={6}>
        {(data) => {
          const days: HeatMapDay[] = data.days.map((d) => ({
            date: d.date,
            status: d.status,
            counts: d.teachingDay && d.enrolled,
            detail: periodWords(d),
          }));
          return (
            <>
              <div className="grid gap-1" data-testid="attendance-percentage">
                {data.percentage === null ? (
                  <p className="text-base font-semibold">No recorded days</p>
                ) : (
                  <p className="text-base">
                    <span className="text-2xl font-semibold tabular-nums">{data.percentage.toFixed(1)}%</span>
                    <span className="text-muted-foreground">
                      {' '}
                      — {data.countedDays} recorded of {data.teachingDays} teaching day{data.teachingDays === 1 ? '' : 's'}
                    </span>
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  Present {data.present} · Late {data.late} · Absent {data.absent} · Part of the day {data.partial} · On leave{' '}
                  {data.onLeave}
                  {data.excludedLeaveDays > 0 && ` (${data.excludedLeaveDays} excused, not counted)`} · Not recorded{' '}
                  {data.unrecorded}
                </p>
              </div>
              <MonthHeatMap month={month} days={days} label={`${student.fullName}'s attendance`} />
            </>
          );
        }}
      </QueryStates>
    </section>
  );
}
