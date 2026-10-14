'use client';

import { PARTICIPATION_STATUSES, type ParticipationStatus } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { eventsApi, type EventDto, type EventRosterDto } from '@/lib/api/school-events-contract';
import { PARTICIPATION_LABELS, eventErrorMessage, eventKeys } from '../_lib/events-ui';

// contracts/slice-38.md §2.6: the roster (the event's sections on the event day, plus anyone
// charged for it) as the API scopes it to the caller; anyone it does not reach gets a 404, and the
// panel is not shown. Recording is for a published event; completion freezes it. Only changed rows
// are sent, at most 500 per request.

const MAX_ROWS = 500;

/** The roster as the caller may read it, or null when the API does not let them (404). */
export function useEventRoster(eventId: string) {
  return useQuery({
    queryKey: eventKeys.roster(eventId),
    queryFn: async (): Promise<EventRosterDto | null> => {
      try {
        return await unwrap(eventsApi.GET('/api/v1/events/{id}/participation', { params: { path: { id: eventId } } }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function EventParticipation({ event: e }: { event: EventDto }) {
  const roster = useEventRoster(e.id);
  if (roster.data === null) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Participation</CardTitle>
        <CardDescription>
          {e.status === 'published'
            ? 'Record who attended. Students of the event’s sections on the day, and anyone charged for it.'
            : 'The event is completed, so participation can no longer change.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {roster.isPending ? (
          <LoadingState rows={4} />
        ) : roster.isError ? (
          <ErrorState error={roster.error} onRetry={() => void roster.refetch()} />
        ) : (
          <RosterForm key={roster.dataUpdatedAt} event={e} roster={roster.data} />
        )}
      </CardContent>
    </Card>
  );
}

function RosterForm({ event: e, roster }: { event: EventDto; roster: EventRosterDto }) {
  const queryClient = useQueryClient();
  const editable = e.status === 'published';
  const [marks, setMarks] = useState<Record<string, ParticipationStatus | ''>>(() =>
    Object.fromEntries(roster.rows.map((r) => [r.studentId, r.participation ?? ''])),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const changed = roster.rows
    .filter((r) => marks[r.studentId] !== '' && marks[r.studentId] !== (r.participation ?? ''))
    .map((r) => ({ studentId: r.studentId, status: marks[r.studentId] as ParticipationStatus }));

  const save = useMutation({
    mutationFn: async () => {
      let latest: EventRosterDto | null = null;
      for (let i = 0; i < changed.length; i += MAX_ROWS) {
        latest = await unwrap(
          eventsApi.POST('/api/v1/events/{id}/record-participation', {
            params: { path: { id: e.id } },
            body: { rows: changed.slice(i, i + MAX_ROWS) },
          }),
        );
      }
      return latest;
    },
    onMutate: () => setProblem(null),
    onSuccess: (latest) => {
      if (latest) queryClient.setQueryData(eventKeys.roster(e.id), latest);
      void queryClient.invalidateQueries({ queryKey: eventKeys.report(e.id) });
      toast.success(`Participation saved for ${changed.length} ${changed.length === 1 ? 'student' : 'students'}.`);
    },
    onError: (error) => {
      setProblem(eventErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: eventKeys.roster(e.id) });
    },
  });

  if (roster.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody is on this event’s roster.</p>;
  }
  const counts = PARTICIPATION_STATUSES.map((s) => `${roster.rows.filter((r) => r.participation === s).length} ${PARTICIPATION_LABELS[s].toLowerCase()}`);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground" data-testid="participation-counts">
        {roster.rows.length} on the roster · {counts.join(' · ')}
      </p>
      <div className="overflow-x-auto">
        <Table aria-label="Roster">
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Class</TableHead>
              <TableHead className="text-right">Roll</TableHead>
              <TableHead>Participation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roster.rows.map((r) => (
              <TableRow key={r.studentId}>
                <TableCell>
                  <span className="grid">
                    <span className="font-medium">{r.fullName}</span>
                    <span className="text-xs text-muted-foreground">{r.admissionNo}</span>
                  </span>
                </TableCell>
                <TableCell>
                  {r.className} {r.sectionName}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.rollNo ?? '—'}</TableCell>
                <TableCell>
                  {editable ? (
                    <NativeSelect
                      aria-label={`Participation of ${r.fullName}`}
                      value={marks[r.studentId] ?? ''}
                      onChange={(event) => setMarks((m) => ({ ...m, [r.studentId]: event.target.value as ParticipationStatus | '' }))}
                      className="w-36"
                    >
                      <option value="" disabled={r.participation !== null}>
                        Not recorded
                      </option>
                      {PARTICIPATION_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {PARTICIPATION_LABELS[s]}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : r.participation ? (
                    PARTICIPATION_LABELS[r.participation]
                  ) : (
                    <span className="text-muted-foreground">Not recorded</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={changed.length === 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save participation'}
          </Button>
          <span className="text-sm text-muted-foreground">
            {changed.length === 0 ? 'No changes.' : `${changed.length} ${changed.length === 1 ? 'change' : 'changes'} to save.`}
          </span>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
