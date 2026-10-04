'use client';

import { ANNOUNCEMENT_CATEGORIES, INBOX_ITEM_KINDS, type AnnouncementCategory, type InboxItemKind } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PaperclipIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { TablePagination } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
import { unwrap } from '@/lib/api/client';
import { announcementsApi, type InboxQuery } from '@/lib/api/school-announcements-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS, announcementKeys } from '../announcements/_lib/announcements-ui';
import { InboxTags, aboutLine } from './_lib/inbox-ui';

// contracts/slice-14.md §7.3: every signed-in person's messages, newest first: announcements and
// the school's notices (absence alerts, diary, remarks, holidays). No images in the list (R160);
// an attachment opens from the item.

const LIMIT = 20;
const KIND_LABELS: Record<InboxItemKind, string> = { announcement: 'Announcements', notice: 'Notices' };

export function InboxList() {
  const [kind, setKind] = useState<InboxItemKind | ''>('');
  const [category, setCategory] = useState<AnnouncementCategory | ''>('');
  const [page, setPage] = useListPage([kind, category]);
  const query: InboxQuery = { page, limit: LIMIT, ...(kind && { kind }), ...(category && { category }) };
  const inbox = useQuery({
    queryKey: [...announcementKeys.inbox, 'list', query],
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/me/inbox', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const loading = inbox.isPending || inbox.isPlaceholderData;
  const filtered = Boolean(kind || category);

  return (
    <>
      <PageHeader title="Inbox" description="Messages the school has sent you, newest first." />
      <section className="grid gap-4" aria-label="Inbox">
        <div className="flex flex-wrap items-start gap-3">
          <FilterSelect label="Show" value={kind} onChange={setKind}>
            <option value="">Everything</option>
            {INBOX_ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Category" value={category} onChange={setCategory}>
            <option value="">Any</option>
            {ANNOUNCEMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </FilterSelect>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          {inbox.error ? (
            isPermissionDenied(inbox.error) ? (
              <NoPermissionState />
            ) : (
              <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
            )
          ) : !inbox.data ? (
            <LoadingState />
          ) : inbox.data.data.length === 0 ? (
            <EmptyState
              title={filtered ? 'No messages match' : 'No messages yet'}
              description={filtered ? 'Try a different filter.' : 'Announcements and notices from the school appear here.'}
            />
          ) : (
            <>
              <ul aria-busy={loading} className={cn('divide-y', loading && 'opacity-60')}>
                {inbox.data.data.map((item) => {
                  const about = aboutLine(item);
                  return (
                    <li
                      key={item.id}
                      data-testid="inbox-item"
                      className={cn('border-l-4', item.priority === 'urgent' ? 'border-l-destructive' : 'border-l-transparent')}
                    >
                      <Link href={`/inbox/${item.id}`} className="grid gap-1 px-4 py-3 hover:bg-muted/40">
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{item.title}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(item.sentAt)}</span>
                        </span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">{item.body}</span>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <InboxTags item={item} />
                          {about && <span>{about}</span>}
                          {item.hasAttachment && (
                            <span className="inline-flex items-center gap-1">
                              <PaperclipIcon className="size-3.5" aria-hidden="true" />
                              Attachment
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <TablePagination
                page={inbox.data.page}
                limit={inbox.data.limit}
                total={inbox.data.total}
                loading={loading}
                onPageChange={setPage}
              />
            </>
          )}
        </div>
      </section>
    </>
  );
}
