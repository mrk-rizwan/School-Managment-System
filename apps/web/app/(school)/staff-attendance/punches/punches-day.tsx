'use client';

import { PUNCH_OUTCOME_LABELS } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { TablePagination } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { BackLink, EmptyState, ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { staffAttendanceApi, type DevicePunchesQuery } from '@/lib/api/school-staff-attendance-contract';
import { formatTime, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { attendanceKeys } from '../../attendance/_lib/attendance-ui';

// Phase 5 slice 44 (contracts/slice-44.md §2.4): one school day of biometric punches, in punch
// order. An unmapped punch names a device user id nobody holds; mapping it later on the staff
// record does not repair it (A11).

const LIMIT = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function PunchesDay() {
  const today = todayInSchool();
  const [date, setDate] = useState(today);
  const [only, setOnly] = useState<'' | 'unmapped'>('');
  const [page, setPage] = useListPage([date, only]);
  const valid = DATE.test(date) && date <= today;
  const query: DevicePunchesQuery = { date, page, limit: LIMIT, ...(only === 'unmapped' && { unmapped: true }) };
  const punches = useQuery({
    queryKey: [...attendanceKeys.all, 'punches', query],
    queryFn: () => unwrap(staffAttendanceApi.GET('/api/v1/device-punches', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: valid,
  });
  const rows = punches.data?.data ?? [];

  return (
    <>
      <BackLink href="/staff-attendance">Staff attendance</BackLink>
      <PageHeader
        title="Device punches"
        description="Every punch the biometric device sent for the day, and what it did. A day the office already marked is never changed by a punch."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="punches-date">Date</Label>
          <Input id="punches-date" type="date" max={today} value={date} className="w-44" onChange={(e) => setDate(e.target.value)} />
        </div>
        <FilterSelect<'' | 'unmapped'> label="Show" value={only} onChange={setOnly}>
          <option value="">All punches</option>
          <option value="unmapped">Unknown device users</option>
        </FilterSelect>
      </div>
      {!valid ? (
        <p className="text-sm text-destructive">Choose a date that is not in the future.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          {punches.error ? (
            isPermissionDenied(punches.error) ? (
              <NoPermissionState />
            ) : (
              <ErrorState error={punches.error} onRetry={() => void punches.refetch()} />
            )
          ) : punches.isPending ? (
            <LoadingState rows={6} />
          ) : rows.length === 0 ? (
            <EmptyState title="No punches" description="Nothing came from the device for this day." />
          ) : (
            <Table aria-busy={punches.isPlaceholderData} data-testid="punches-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4 text-muted-foreground">Time</TableHead>
                  <TableHead className="px-4 text-muted-foreground">Staff member</TableHead>
                  <TableHead className="px-4 text-muted-foreground">Device user id</TableHead>
                  <TableHead className="px-4 text-muted-foreground">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} data-punch={p.id}>
                    <TableCell className="px-4 tabular-nums">
                      {formatTime(p.punchedAt)}
                      {p.direction && <span className="ml-1 text-xs text-muted-foreground">{p.direction === 'in' ? 'in' : 'out'}</span>}
                    </TableCell>
                    <TableCell className="px-4">{p.staffName ?? <span className="text-muted-foreground">Nobody</span>}</TableCell>
                    <TableCell className="px-4 font-mono text-xs">{p.deviceUserId}</TableCell>
                    <TableCell className="px-4">
                      <Badge variant={p.outcome === 'marked' ? 'default' : p.outcome === 'stored' ? 'outline' : 'destructive'}>
                        {PUNCH_OUTCOME_LABELS[p.outcome]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {rows.length > 0 && !punches.error && (
            <TablePagination
              page={punches.data?.page ?? page}
              limit={LIMIT}
              total={punches.data?.total ?? 0}
              loading={punches.isPlaceholderData}
              onPageChange={setPage}
            />
          )}
        </div>
      )}
    </>
  );
}
