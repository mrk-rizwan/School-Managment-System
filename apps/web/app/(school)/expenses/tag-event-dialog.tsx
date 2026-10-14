'use client';

import { formatRupees } from '@asms/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { eventsApi } from '@/lib/api/school-events-contract';
import type { ExpenseDto } from '@/lib/api/school-expenses-contract';
import { formatDateTime } from '@/lib/format';
import { eventErrorMessage, eventKeys } from '../events/_lib/events-ui';

// contracts/slice-38.md §3.4: an expense is tagged to one published or completed event, once, so
// the event report counts it. The latest events of each status are offered.

export function TagEventDialog({ expense, onDone }: { expense: ExpenseDto; onDone: (message: string | null) => void }) {
  const selectId = useId();
  const [eventId, setEventId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const events = useQuery({
    queryKey: [...eventKeys.list, 'taggable'],
    queryFn: async () => {
      const page = (status: 'published' | 'completed') =>
        unwrap(eventsApi.GET('/api/v1/events', { params: { query: { status, limit: OPTIONS_LIMIT, sort: '-startsAt' } } }));
      const published = await page('published');
      const completed = await page('completed');
      return [...published.data, ...completed.data];
    },
  });
  const tag = useMutation({
    mutationFn: () =>
      unwrap(eventsApi.POST('/api/v1/expenses/{id}/tag-event', { params: { path: { id: expense.id } }, body: { eventId } })),
    onMutate: () => setProblem(null),
    onSuccess: () => onDone(`Expense ${expense.expenseNo} tagged to the event.`),
    onError: (error) => setProblem(eventErrorMessage(error)),
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (eventId) tag.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Tag expense {expense.expenseNo} to an event</DialogTitle>
        <DialogDescription>
          {formatRupees(expense.amount)} for {expense.description}. The event report counts it; an expense is tagged once.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>Event</Label>
        <NativeSelect id={selectId} value={eventId} disabled={events.isPending} onChange={(event) => setEventId(event.target.value)}>
          <option value="">
            {events.isPending ? 'Loading…' : events.isError ? 'Could not load events' : events.data.length === 0 ? 'No published events' : 'Choose an event'}
          </option>
          {(events.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} · {formatDateTime(e.startsAt)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={tag.isPending} onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!eventId || tag.isPending}>
          {tag.isPending ? 'Tagging…' : 'Tag to event'}
        </Button>
      </DialogFooter>
    </form>
  );
}
