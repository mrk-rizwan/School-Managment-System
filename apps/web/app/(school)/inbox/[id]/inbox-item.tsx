'use client';

import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { BackLink, QueryStates } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import { announcementsApi, inboxThumbnailUrl, type InboxItemDto } from '@/lib/api/school-announcements-contract';
import { formatDateTime, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { announcementKeys, downloadInboxAttachment } from '../../announcements/_lib/announcements-ui';
import { InboxTags, aboutLine } from '../_lib/inbox-ui';

// contracts/slice-14.md §7.4, §7.5: one message, opened from the list or a push deep-link; an
// expired or withdrawn one is 404. The attachment loads only when asked for (R160).

export function InboxItem({ id }: { id: string }) {
  const item = useQuery({
    queryKey: announcementKeys.inboxItem(id),
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/me/inbox/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/inbox">Inbox</BackLink>
      <QueryStates
        query={item}
        notFound={{ title: 'Message not found', description: 'It may have expired. Your other messages are in the inbox.' }}
      >
        {(data) => <Item item={data} />}
      </QueryStates>
    </>
  );
}

function Item({ item }: { item: InboxItemDto }) {
  const [showPicture, setShowPicture] = useState(false);
  const isImage = item.attachmentMime === 'image/jpeg' || item.attachmentMime === 'image/png';
  const about = aboutLine(item);
  return (
    <>
      <PageHeader title={item.title} description={`Sent ${formatDateTime(item.sentAt)}`} />
      <Card className={cn('border-l-4', item.priority === 'urgent' ? 'border-l-destructive' : 'border-l-transparent')}>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <InboxTags item={item} />
            {about && <span>{about}</span>}
            {item.expiresOn && <span>Until {formatDay(item.expiresOn)}</span>}
          </div>
          <p className="whitespace-pre-wrap text-sm" data-testid="inbox-body">
            {item.body}
          </p>
          {item.hasAttachment && (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {isImage && !showPicture && (
                  <Button variant="outline" size="sm" onClick={() => setShowPicture(true)}>
                    <ImageIcon />
                    Show picture
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => void downloadInboxAttachment(item.id).catch(toastApiError)}>
                  <DownloadIcon />
                  {item.attachmentMime === 'application/pdf' ? 'Download PDF' : 'Download'}
                </Button>
              </div>
              {isImage && showPicture && (
                // eslint-disable-next-line @next/next/no-img-element -- cookie-authenticated stream, loaded on tap only
                <img src={inboxThumbnailUrl(item.id)} alt="Attachment to this message" className="max-h-80 w-auto rounded-lg border" />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
