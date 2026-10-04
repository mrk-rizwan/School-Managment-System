'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { SearchField } from '@/components/list-filters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { unwrap } from '@/lib/api/client';
import { attendanceApi } from '@/lib/api/school-attendance-contract';
import { studentsApi, type StudentDto } from '@/lib/api/school-students-contract';
import { todayInSchool } from '@/lib/format';
import { useListSearch } from '@/lib/list-search';
import { placeLabel, studentsKeys } from '../../students/_lib/students-ui';
import { TIME_PATTERN, arrivalRefusal, attendanceKeys, nowInSchool } from './attendance-ui';

// The gate's arrival dialog (contracts/slice-11.md §4.4, §13): find the child, confirm the time,
// and the day's first absent mark becomes late with "Arrived at HH:MM" as its reason.

export function ArrivalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <ArrivalForm onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ArrivalForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const timeId = useId();
  const [raw, setRaw] = useState('');
  const [picked, setPicked] = useState<StudentDto | null>(null);
  const [time, setTime] = useState(nowInSchool());
  const search = useListSearch(raw);
  const query = { q: search.q, status: 'active', limit: 8 } as const;
  const students = useQuery({
    queryKey: [...studentsKeys.all, 'arrival-search', query],
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students', { params: { query } })),
    enabled: !!search.q && picked === null,
    placeholderData: keepPreviousData,
  });

  const record = useMutation({
    mutationFn: (student: StudentDto) =>
      unwrap(
        attendanceApi.POST('/api/v1/attendance-arrivals', {
          body: { studentId: student.id, date: todayInSchool(), arrivedAt: time },
        }),
      ),
    onSuccess: (_mark, student) => {
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
      toast.success(`${student.fullName} recorded as arrived at ${time}.`);
      onDone();
    },
  });

  const timeValid = TIME_PATTERN.test(time);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked && timeValid && !record.isPending) record.mutate(picked);
      }}
    >
      <DialogHeader>
        <DialogTitle>Record a late arrival</DialogTitle>
        <DialogDescription>
          For a child marked absent today who has now arrived. The mark becomes late, and the absence alert to the family
          is cancelled or corrected.
        </DialogDescription>
      </DialogHeader>
      {picked ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{picked.fullName}</p>
            <p className="text-xs text-muted-foreground">
              {[`Adm. ${picked.admissionNo}`, placeLabel(picked.current)].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={record.isPending}
            onClick={() => {
              setPicked(null);
              record.reset();
            }}
          >
            Change
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <SearchField
            value={raw}
            onChange={setRaw}
            placeholder="Name or admission number"
            className="w-full"
            hint={search.identity ? 'Search by name or admission number, not an identity number.' : search.hint}
            hintTone={search.identity ? 'destructive' : 'muted'}
          />
          {search.q && (
            <ul className="grid max-h-60 gap-1 overflow-y-auto" aria-label="Matching students" aria-busy={students.isFetching}>
              {students.data?.data.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(s)}
                    className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="font-medium">{s.fullName}</span>
                    <span className="text-muted-foreground"> · {placeLabel(s.current) || `Adm. ${s.admissionNo}`}</span>
                  </button>
                </li>
              ))}
              {students.data && students.data.data.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">No active student matches.</li>
              )}
              {students.error ? (
                <li className="px-3 py-2 text-sm text-destructive">The search failed. Try again.</li>
              ) : null}
            </ul>
          )}
        </div>
      )}
      <div className="grid gap-1.5 sm:w-40">
        <Label htmlFor={timeId}>Arrived at</Label>
        <Input
          id={timeId}
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          aria-invalid={timeValid ? undefined : true}
        />
      </div>
      {record.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{arrivalRefusal(record.error, picked?.fullName ?? 'This child')}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={record.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!picked || !timeValid || record.isPending}>
          {record.isPending ? 'Recording…' : 'Record arrival'}
        </Button>
      </DialogFooter>
    </form>
  );
}
