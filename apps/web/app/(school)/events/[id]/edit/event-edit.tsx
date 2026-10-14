'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import { eventsApi } from '@/lib/api/school-events-contract';
import { EVENT_STATUS_LABELS, eventHref, eventKeys } from '../../_lib/events-ui';
import { EventForm } from '../../event-form';

// contracts/slice-38.md §2.2: only a draft is edited.

export function EventEdit({ id }: { id: string }) {
  const event = useQuery({
    queryKey: eventKeys.detail(id),
    queryFn: () => unwrap(eventsApi.GET('/api/v1/events/{id}', { params: { path: { id } } })),
  });
  return (
    <QueryStates query={event} notFound={{ title: 'Event not found', description: 'It may have been removed, or it is a draft you cannot see.' }}>
      {(e) =>
        e.status === 'draft' ? (
          <EventForm key={e.id} event={e} />
        ) : (
          <>
            <BackLink href={eventHref(e.id)}>Event</BackLink>
            <PageHeader title="Edit event" />
            <StateCard>
              <EmptyState
                title={`This event is ${EVENT_STATUS_LABELS[e.status].toLowerCase()}`}
                description="Only a draft can be changed. Cancel it and create a new one if it must change."
                action={
                  <Link href={eventHref(e.id)} className={buttonVariants({ variant: 'outline' })}>
                    Back to the event
                  </Link>
                }
              />
            </StateCard>
          </>
        )
      }
    </QueryStates>
  );
}
