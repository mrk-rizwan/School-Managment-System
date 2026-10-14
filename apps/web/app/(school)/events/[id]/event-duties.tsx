'use client';

import { DUTY_KINDS, type DutyKind } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { eventsApi, type EventDto, type EventDutyDto } from '@/lib/api/school-events-contract';
import { formatDateTime } from '@/lib/format';
import { useActiveStaff } from '../../timetable/_lib/timetable-ui';
import { DUTY_LABELS, eventErrorMessage, eventKeys } from '../_lib/events-ui';

// contracts/slice-38.md §2.3, rule 34: a holiday.manage holder sees every duty, adds one (a staff
// member holds one live duty of a kind) and ends one with a reason; anyone else sees only their own.

const NOTE_MAX = 200;

export function EventDuties({ event: e, canManage }: { event: EventDto; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState<EventDutyDto | null>(null);
  const open = e.status === 'draft' || e.status === 'published';
  const reload = () => void queryClient.invalidateQueries({ queryKey: eventKeys.detail(e.id) });

  const end = useMutation({
    mutationFn: ({ duty, reason }: { duty: EventDutyDto; reason: string }) =>
      unwrap(eventsApi.POST('/api/v1/event-duties/{id}/end', { params: { path: { id: duty.id } }, body: { reason } })),
    onSuccess: (duty) => {
      setEnding(null);
      reload();
      toast.success(`${duty.staffName}’s ${DUTY_LABELS[duty.duty].toLowerCase()} duty ended.`);
    },
    onError: (error) => {
      setEnding(null);
      toast.error(eventErrorMessage(error));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{canManage ? 'Staff duties' : 'Your duties'}</CardTitle>
        <CardDescription>
          {canManage
            ? 'Each member of staff sees only their own duties. A collection duty lets them take the event payments.'
            : 'Your duties on this event.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {e.duties.length === 0 ? (
          <p className="text-sm text-muted-foreground">No duties yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="Duties">
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Duty</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && open && <TableHead className="sr-only">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {e.duties.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.staffName}</TableCell>
                    <TableCell>{DUTY_LABELS[d.duty]}</TableCell>
                    <TableCell className="max-w-56 truncate">{d.note ?? '—'}</TableCell>
                    <TableCell>
                      {d.endedAt ? (
                        <span className="grid gap-0.5">
                          <Badge variant="ghost">Ended</Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(d.endedAt)}
                            {d.endReason && `: ${d.endReason}`}
                          </span>
                        </span>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </TableCell>
                    {canManage && open && (
                      <TableCell className="text-right">
                        {!d.endedAt && (
                          <Button variant="ghost" size="sm" onClick={() => setEnding(d)}>
                            End duty
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {canManage && open && <AddDuty event={e} onAdded={reload} />}
      </CardContent>
      <ConfirmWithReasonDialog
        open={ending !== null}
        onOpenChange={(o) => !o && setEnding(null)}
        title={`End ${ending?.staffName ?? ''}’s duty?`}
        description="The duty stays in the history with your reason."
        confirmLabel="End duty"
        minLength={3}
        destructive
        pending={end.isPending}
        onConfirm={(reason) => ending && end.mutate({ duty: ending, reason })}
      />
    </Card>
  );
}

function AddDuty({ event: e, onAdded }: { event: EventDto; onAdded: () => void }) {
  const staff = useActiveStaff();
  const staffId = useId();
  const dutyId = useId();
  const noteId = useId();
  const [member, setMember] = useState('');
  const [duty, setDuty] = useState<DutyKind>('supervision');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        eventsApi.POST('/api/v1/events/{id}/duties', {
          params: { path: { id: e.id } },
          body: { staffId: member, duty, ...(note.trim() && { note: note.trim() }) },
        }),
      ),
    onMutate: () => setProblem(null),
    onSuccess: (row) => {
      toast.success(`${row.staffName} has the ${DUTY_LABELS[row.duty].toLowerCase()} duty.`);
      setMember('');
      setNote('');
      onAdded();
    },
    onError: (error) => setProblem(eventErrorMessage(error)),
  });

  return (
    <form
      className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_12rem_1fr_auto] sm:items-end"
      aria-label="Add a duty"
      onSubmit={(event) => {
        event.preventDefault();
        if (member) add.mutate();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={staffId}>Staff member</Label>
        <NativeSelect id={staffId} value={member} disabled={staff.isPending} onChange={(event) => setMember(event.target.value)}>
          <option value="">{staff.isPending ? 'Loading…' : staff.isError ? 'Could not load staff' : 'Choose'}</option>
          {(staff.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={dutyId}>Duty</Label>
        <NativeSelect id={dutyId} value={duty} onChange={(event) => setDuty(event.target.value as DutyKind)}>
          {DUTY_KINDS.map((k) => (
            <option key={k} value={k}>
              {DUTY_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Input id={noteId} value={note} maxLength={NOTE_MAX} autoComplete="off" onChange={(event) => setNote(event.target.value)} />
      </div>
      <Button type="submit" disabled={!member || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add duty'}
      </Button>
      {problem && (
        <p role="alert" className="text-sm text-destructive sm:col-span-4">
          {problem}
        </p>
      )}
    </form>
  );
}
