'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import { announcementsApi } from '@/lib/api/school-announcements-contract';
import { STATUS_LABELS, announcementHref, announcementKeys, isEditable } from '../../_lib/announcements-ui';
import { AnnouncementCompose } from '../../announcement-compose';

// contracts/slice-14.md §5.7: content is editable while draft or scheduled only (R146).

export function AnnouncementEdit({ id }: { id: string }) {
  const announcement = useQuery({
    queryKey: announcementKeys.detail(id),
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/announcements/{id}', { params: { path: { id } } })),
  });
  return (
    <QueryStates
      query={announcement}
      notFound={{ title: 'Announcement not found', description: 'It may have been written by someone else. Find yours in the list.' }}
      noPermission="Announcements are sent by the principal, the office and teachers for their own classes."
    >
      {(a) =>
        isEditable(a) ? (
          <AnnouncementCompose key={a.id} announcement={a} />
        ) : (
          <>
            <BackLink href={announcementHref(a.id)}>Announcement</BackLink>
            <PageHeader title="Edit announcement" />
            <StateCard>
              <EmptyState
                title={`This announcement is ${STATUS_LABELS[a.status].toLowerCase()}`}
                description="A sent or cancelled announcement cannot change. Write a new one instead."
                action={
                  <Link href="/announcements/new" className={buttonVariants({ variant: 'outline' })}>
                    New announcement
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
