'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryStates } from '@/components/page-states';
import { unwrap } from '@/lib/api/client';
import {
  staffAttendanceApi,
  type MyStaffAttendanceDayDto,
  type StaffAttendanceDayDto,
} from '@/lib/api/school-staff-attendance-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { STATUS_LABELS, attendanceKeys } from '../../attendance/_lib/attendance-ui';
import { MonthHeatMap, MonthNav, monthOf, monthRange, type HeatMapDay } from '../../attendance/_lib/month-heat-map';

// One member's month of attendance (contracts/slice-12.md §4.4, §8): the staff detail's tab
// (`GET /staff/:id/attendance`, with notes and who marked) and "My attendance"
// (`GET /me/staff/attendance`, neither — decision 6).

type Source = { kind: 'staff'; staffId: string; name: string } | { kind: 'me' };

export function StaffAttendanceMonth({ source }: { source: Source }) {
  const [month, setMonth] = useState(monthOf(todayInSchool()));
  const { from, to } = monthRange(month);
  const query = { dateFrom: from, dateTo: to };
  const attendance = useQuery({
    queryKey: source.kind === 'me' ? [...attendanceKeys.mine, query] : [...attendanceKeys.staff(source.staffId), query],
    queryFn: () =>
      source.kind === 'me'
        ? unwrap(staffAttendanceApi.GET('/api/v1/me/staff/attendance', { params: { query } }))
        : unwrap(
            staffAttendanceApi.GET('/api/v1/staff/{id}/attendance', {
              params: { path: { id: source.staffId }, query },
            }),
          ),
  });

  return (
    <section className="grid gap-4" aria-label="Attendance">
      <MonthNav month={month} onChange={setMonth} />
      <QueryStates query={attendance} loadingRows={6}>
        {(data) => {
          const days: (StaffAttendanceDayDto | MyStaffAttendanceDayDto)[] = data.days;
          const map: HeatMapDay[] = days.map((d) => ({
            date: d.date,
            status: d.status,
            counts: d.workingDay && d.employed,
            detail: 'note' in d && d.note ? d.note : undefined,
          }));
          const notes = days.filter((d): d is StaffAttendanceDayDto => 'markedByName' in d && d.status !== null);
          return (
            <>
              <p className="text-sm" data-testid="staff-attendance-counts">
                <span className="font-medium">
                  {data.unrecorded} unrecorded of {data.workingDays} working day{data.workingDays === 1 ? '' : 's'}
                </span>
                <span className="text-muted-foreground">
                  {' '}
                  · Present {data.present} · Late {data.late} · Absent {data.absent} · On leave {data.onLeave}
                </span>
              </p>
              <MonthHeatMap
                month={month}
                days={map}
                countedLabel="working day"
                label={source.kind === 'me' ? 'Your attendance' : `${source.name}'s attendance`}
              />
              {source.kind === 'staff' && notes.length > 0 && (
                <ul className="grid gap-1 text-sm" aria-label="Marks this month">
                  {notes.map((d) => (
                    <li key={d.date} className="flex flex-wrap gap-x-2">
                      <span className="w-28 shrink-0 text-muted-foreground">{formatDay(d.date)}</span>
                      <span className="font-medium">{STATUS_LABELS[d.status!]}</span>
                      {d.note && <span>“{d.note}”</span>}
                      <span className="text-muted-foreground">
                        marked by {d.markedByName ?? 'unknown'}
                        {d.amended && ', amended'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </QueryStates>
    </section>
  );
}
