'use client';

import { weekdayOf, type StaffAttendanceStatus } from '@asms/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { RowActions, TablePagination } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { EmptyState, ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { calendarApi } from '@/lib/api/school-calendar-contract';
import { staffAttendanceApi, type StaffDayDto, type StaffDayQuery } from '@/lib/api/school-staff-attendance-contract';
import { formatDay, formatTime, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, StatusButtons, attendanceErrorMessage, attendanceKeys } from '../attendance/_lib/attendance-ui';
import { AmendmentsDialog, useMarkSheet, type MarkDraft } from '../attendance/_lib/mark-sheet';
import { addDays, calendarKeys } from '../calendar/_lib/calendar-ui';
import { STAFF_STATUS_LABELS } from '../staff/_lib/staff-ui';
import { AmendStaffMarkDialog } from './amend-staff-mark-dialog';

// contracts/slice-12.md §4.1, §4.2, §8 "Staff attendance — day view": every active member on
// the date, P/A/L/O and a note per row. "Save" sends every row touched (on any page); a change to
// a saved mark asks for a reason. The caller's own row is read-only (R134).

const LIMIT = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;


export function StaffAttendanceScreen() {
  const today = todayInSchool();
  const [date, setDate] = useState(today);
  const valid = DATE.test(date) && date <= today;
  return (
    <>
      <PageHeader
        title="Staff attendance"
        description="Record each member of staff for the day. Only the rows you change are saved."
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="staff-day-date">Date</Label>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label="Previous day" onClick={() => setDate(shift(date, -1))}>
              <ChevronLeftIcon />
            </Button>
            <Input
              id="staff-day-date"
              type="date"
              max={today}
              value={date}
              className="w-44"
              onChange={(event) => setDate(event.target.value)}
            />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next day"
              disabled={!valid || date >= today}
              onClick={() => setDate(shift(date, 1))}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </div>
      {valid ? (
        <StaffDaySheet key={date} date={date} />
      ) : (
        <p className="text-sm text-destructive">Choose a date that is not in the future.</p>
      )}
    </>
  );
}

const shift = (date: string, days: number) => (DATE.test(date) ? addDays(date, days) : todayInSchool());

function StaffDaySheet({ date }: { date: string }) {
  const queryClient = useQueryClient();
  const me = useSchoolMe();
  const ownStaffId = me.data?.staffId ?? null;
  const [raw, setRaw] = useState('');
  const search = useListSearch(raw);
  const [status, setStatus] = useState<'' | StaffAttendanceStatus | 'unrecorded'>('');
  const [page, setPage] = useListPage([search.q, status]);
  const [amendingId, setAmendingId] = useState<string | null>(null);

  // Weekly days off and staff holidays come from the calendar (§3, R136): a holiday that applies to
  // staff blocks the sheet up front; one staff work through only says so. The server still refuses
  // a write on either (409 NOT_A_TEACHING_DAY), which covers a holiday published meanwhile.
  const days = useQuery({
    queryKey: [...calendarKeys.teachingDays, date, date],
    queryFn: () =>
      unwrap(calendarApi.GET('/api/v1/calendar/teaching-days', { params: { query: { dateFrom: date, dateTo: date } } })),
  });
  const weeklyOff = days.data?.weeklyOffDays.includes(weekdayOf(date)) ?? false;
  const staffHoliday = days.data?.holidays.find((h) => h.appliesToStaff);
  const workedHoliday = days.data?.holidays.find((h) => !h.appliesToStaff);

  const query: StaffDayQuery = {
    date,
    page,
    limit: LIMIT,
    sort: 'fullName',
    ...(search.q && { q: search.q }),
    ...(status && { status }),
  };
  const list = useQuery({
    queryKey: [...attendanceKeys.staffDay, query],
    queryFn: () => unwrap(staffAttendanceApi.GET('/api/v1/staff-attendance', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const rows = list.data?.data ?? [];
  // Looked up on every render, so a reload after STALE_STATUS hands the dialog the new mark.
  const amending = rows.find((row) => row.staffId === amendingId) ?? null;
  const isOwn = (row: StaffDayDto) => ownStaffId !== null && row.staffId === ownStaffId;
  const editable = !weeklyOff && !staffHoliday;
  const sheet = useMarkSheet({
    idKey: 'staffId',
    rowCount: rows.length,
    nameOf: () => 'A member of staff',
    // Every row touched, on any page.
    submit: (changed, reason) =>
      unwrap(
        staffAttendanceApi.POST('/api/v1/staff-attendance/submit', {
          body: {
            date,
            ...(reason && { reason }),
            marks: changed.map(({ id, draft }) => ({
              staffId: id,
              status: draft.status!,
              ...(draft.note.trim() && { note: draft.note.trim() }),
            })),
          },
        }),
      ),
    onSaved: (result) => {
      sheet.clear();
      const s = result.summary;
      toast.success(`Saved. ${s.marked} of ${s.staff} recorded: ${s.present} present, ${s.absent} absent, ${s.late} late, ${s.onLeave} on leave.`);
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
    onRaceDropped: () => void queryClient.invalidateQueries({ queryKey: attendanceKeys.staffDay }),
  });
  const setRow = (row: StaffDayDto, patch: Partial<MarkDraft>) => sheet.update(row.staffId, row.fullName, row.mark, patch);
  const touchedCount = sheet.changed.length;

  return (
    <div className="grid gap-4">
      {weeklyOff && (
        <Alert data-testid="staff-day-off">
          <AlertTitle>Weekly day off</AlertTitle>
          <AlertDescription>{formatDay(date)} is a weekly day off, so staff attendance is not recorded.</AlertDescription>
        </Alert>
      )}
      {!weeklyOff && staffHoliday && (
        <Alert data-testid="staff-day-off">
          <AlertTitle>{staffHoliday.name}</AlertTitle>
          <AlertDescription>
            {formatDay(date)} is a holiday for staff, so staff attendance is not recorded.
          </AlertDescription>
        </Alert>
      )}
      {!weeklyOff && !staffHoliday && workedHoliday && (
        <Alert>
          <AlertTitle>{workedHoliday.name}</AlertTitle>
          <AlertDescription>Staff work through this holiday, so record their attendance as usual.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <SearchField
          value={raw}
          onChange={setRaw}
          placeholder="Name"
          hint={search.identity ? 'Search by name, not an identity number.' : search.hint}
          hintTone={search.identity ? 'destructive' : 'muted'}
        />
        <FilterSelect<'' | StaffAttendanceStatus | 'unrecorded'> label="Mark" value={status} onChange={setStatus}>
          <option value="">Any</option>
          <option value="unrecorded">Not recorded</option>
          <option value="present">Present</option>
          <option value="absent">Absent</option>
          <option value="late">Late</option>
          <option value="on_leave">On leave</option>
        </FilterSelect>
      </div>

      {sheet.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{attendanceErrorMessage(sheet.error)}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        {list.error ? (
          isPermissionDenied(list.error) ? (
            <NoPermissionState />
          ) : (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          )
        ) : list.isPending ? (
          <LoadingState rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nobody to show" description="Active staff who had joined by this date appear here." />
        ) : (
          <Table aria-busy={list.isPlaceholderData} aria-describedby="staff-keys">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-muted-foreground">Name</TableHead>
                <TableHead className="px-4 text-muted-foreground">Mark</TableHead>
                <TableHead className="px-4 text-muted-foreground">Note</TableHead>
                <TableHead className="px-4 text-muted-foreground">Recorded</TableHead>
                <TableHead className="w-10 px-2">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const own = isOwn(row);
                const draft = sheet.draftFor(row.staffId, row.mark);
                const value = draft.status;
                const rowEditable = editable && !own && row.staffStatus === 'active';
                return (
                  <TableRow
                    key={row.staffId}
                    {...sheet.rowProps(index, rowEditable ? (status) => setRow(row, { status }) : null)}
                    data-staff={row.staffId}
                    aria-label={`${row.fullName}, ${value ? STATUS_LABELS[value] : 'not recorded'}${own ? ', your own row' : ''}`}
                    className={cn(
                      'focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      sheet.isChanged(row.staffId) && 'bg-primary/5',
                      own && 'bg-muted/40',
                    )}
                  >
                    <TableCell className="px-4">
                      <div className="font-medium">{row.fullName}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.designation ?? 'Staff'}
                        {row.staffStatus !== 'active' && ` · ${STAFF_STATUS_LABELS[row.staffStatus]}`}
                      </div>
                      {own && (
                        <p className="text-xs text-muted-foreground" data-testid="own-row-hint">
                          You cannot mark your own attendance. Another member of staff records it.
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="px-4">
                      <StatusButtons
                        value={value}
                        label={row.fullName}
                        inRow
                        disabled={!rowEditable}
                        onChange={(next) => setRow(row, { status: next })}
                      />
                    </TableCell>
                    <TableCell className="px-4">
                      <Input
                        aria-label={`Note for ${row.fullName}`}
                        className="h-8 min-w-32"
                        maxLength={200}
                        disabled={!rowEditable || value === null}
                        value={draft.note}
                        onChange={(event) => setRow(row, { note: event.target.value })}
                      />
                    </TableCell>
                    <TableCell className="px-4 text-xs text-muted-foreground">
                      {row.mark ? (
                        <>
                          {row.mark.markedByName ?? 'Unknown'}, {formatTime(row.mark.markedAt)}
                          {row.mark.amended && (
                            <Badge variant="ghost" className="ml-1">
                              Amended{row.mark.lastAmendedByName ? ` by ${row.mark.lastAmendedByName}` : ''}
                            </Badge>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="px-2">
                      {row.mark && !own && (
                        <RowActions
                          label={row.fullName}
                          actions={[{ label: 'Amend with reason', onSelect: () => setAmendingId(row.staffId) }]}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 && !list.error && (
          <TablePagination
            page={list.data?.page ?? page}
            limit={LIMIT}
            total={list.data?.total ?? 0}
            loading={list.isPlaceholderData}
            onPageChange={setPage}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="staff-keys" className="hidden text-xs text-muted-foreground sm:block">
          Keyboard: ↑ ↓ move between people; P, A, L or O marks and moves on.
        </p>
        {editable && (
          <Button onClick={sheet.save} disabled={sheet.pending || touchedCount === 0}>
            {sheet.pending ? 'Saving…' : `Save${touchedCount ? ` (${touchedCount})` : ''}`}
          </Button>
        )}
      </div>

      <AmendmentsDialog
        dialog={sheet.dialog}
        raceDescription="Someone recorded these people after you opened the day. Saving yours changes their marks, so a reason is needed."
        unmarked="not recorded"
      />
      <AmendStaffMarkDialog row={amending} onClose={() => setAmendingId(null)} />
    </div>
  );
}
