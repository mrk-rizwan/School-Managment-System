'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ImageIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import { diaryApi, type DiaryEntryDto } from '@/lib/api/school-diary-contract';
import { formatBytes, formatDay, todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { addDays } from '../../../calendar/_lib/calendar-ui';
import {
  diaryKeys,
  diaryThumbnailUrl,
  downloadDiaryAttachment,
  entryEditability,
  isEdited,
  sectionStanding,
  useSectionTitle,
  type EntryEditability,
} from '../../../diary/_lib/diary-ui';
import { DiaryEntryDialog, type EntryAction } from './diary-entry-dialog';

// contracts/slice-13.md §4.1, §11 "Section → Diary": a day or a week of entries, grouped by date
// then subject. Thumbnails load only when asked for (R160's spirit on the web too).

type View = 'day' | 'week';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Monday of the week holding `date`. */
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

export function SectionDiary({ sectionId }: { sectionId: string }) {
  const today = todayInSchool();
  const me = useSchoolMe();
  const title = useSectionTitle(sectionId);
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [action, setAction] = useState<EntryAction | null>(null);
  const valid = DATE.test(anchor);
  const range =
    view === 'day' ? { dateFrom: anchor, dateTo: anchor } : { dateFrom: mondayOf(anchor), dateTo: addDays(mondayOf(anchor), 6) };

  const query = { ...range, limit: OPTIONS_LIMIT, sort: 'date' } as const;
  const entries = useQuery({
    queryKey: [...diaryKeys.section(sectionId), query],
    queryFn: () =>
      unwrap(diaryApi.GET('/api/v1/sections/{id}/diary-entries', { params: { path: { id: sectionId }, query } })),
    placeholderData: keepPreviousData,
    enabled: valid,
  });

  const standing = sectionStanding(me.data, sectionId, today);
  const step = view === 'day' ? 1 : 7;

  return (
    <>
      <BackLink href="/diary">Diary</BackLink>
      <PageHeader
        title={title ? `${title} diary` : 'Section diary'}
        description="Homework and class work by subject. Families are told of an entry written for today."
        actions={
          <Button onClick={() => setAction({ kind: 'create', date: anchor <= today ? anchor : today })}>
            <PlusIcon />
            New entry
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Diary view" className="inline-flex rounded-lg border p-0.5">
          {(['day', 'week'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-md px-3 py-1 text-sm capitalize transition-colors',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-1">
          <Button variant="outline" size="icon-sm" aria-label={`Previous ${view}`} disabled={!valid} onClick={() => setAnchor(addDays(anchor, -step))}>
            <ChevronLeftIcon />
          </Button>
          <div className="grid gap-1.5">
            <Label htmlFor="diary-date">{view === 'day' ? 'Date' : 'Week of'}</Label>
            <Input id="diary-date" type="date" className="w-44" value={anchor} onChange={(event) => setAnchor(event.target.value)} />
          </div>
          <Button variant="outline" size="icon-sm" aria-label={`Next ${view}`} disabled={!valid} onClick={() => setAnchor(addDays(anchor, step))}>
            <ChevronRightIcon />
          </Button>
        </div>
        {anchor !== today && (
          <Button variant="ghost" size="sm" onClick={() => setAnchor(today)}>
            Today
          </Button>
        )}
      </div>

      {!valid ? (
        <p className="text-sm text-destructive">Choose a date.</p>
      ) : (
        <QueryStates
          query={entries}
          loadingRows={4}
          notFound={{ title: 'Not one of your sections', description: 'This section’s diary is not open to you, or it does not exist.' }}
          noPermission="The diary is kept by the section’s teachers and the principal."
        >
          {(page) =>
            page.data.length === 0 ? (
              <StateCard>
                <EmptyState
                  title={view === 'day' ? `Nothing written for ${formatDay(anchor)}` : 'Nothing written this week'}
                  description="Entries appear here as teachers write them."
                />
              </StateCard>
            ) : (
              <div className="grid gap-6" aria-busy={entries.isPlaceholderData}>
                {groupByDate(page.data).map(([date, list]) => (
                  <section key={date} aria-label={formatDay(date)} className="grid gap-3">
                    <h2 className="text-sm font-semibold">{formatDay(date)}</h2>
                    {list.map((entry) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        today={today}
                        editState={entryEditability(entry, me.data, today).state}
                        onEdit={() => setAction({ kind: 'edit', entry })}
                      />
                    ))}
                  </section>
                ))}
              </div>
            )
          }
        </QueryStates>
      )}
      <DiaryEntryDialog
        sectionId={sectionId}
        subjectIds={standing.subjectIds}
        action={action}
        onAction={setAction}
      />
    </>
  );
}

function groupByDate(entries: DiaryEntryDto[]): [string, DiaryEntryDto[]][] {
  const groups = new Map<string, DiaryEntryDto[]>();
  for (const entry of entries) groups.set(entry.date, [...(groups.get(entry.date) ?? []), entry]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => [date, list.sort((x, y) => x.subjectName.localeCompare(y.subjectName))]);
}

function EntryCard({
  entry,
  today,
  editState: state,
  onEdit,
}: {
  entry: DiaryEntryDto;
  today: string;
  editState: EntryEditability['state'];
  onEdit: () => void;
}) {
  const [showImage, setShowImage] = useState(false);
  const isImage = entry.attachmentMime === 'image/jpeg' || entry.attachmentMime === 'image/png';
  return (
    <Card data-testid={`diary-entry-${entry.id}`}>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {entry.subjectName}
              {isEdited(entry) && (
                <Badge variant="outline" className="ml-2">
                  Edited
                </Badge>
              )}
            </p>
            <p className="text-base">{entry.topic}</p>
          </div>
          {state === 'editable' && (
            <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${entry.subjectName} entry`}>
              Edit
            </Button>
          )}
          {state === 'locked' && (
            <p className="text-xs text-muted-foreground" data-testid="edit-locked">
              The edit window closed on {formatDay(entry.editWindowEndsOn)}; ask the principal.
            </p>
          )}
        </div>
        {entry.assignment && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Homework</p>
            <p className="text-sm whitespace-pre-wrap">{entry.assignment}</p>
          </div>
        )}
        {entry.learningOutcome && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Learning outcome</p>
            <p className="text-sm whitespace-pre-wrap">{entry.learningOutcome}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>By {entry.authorName}</span>
          {entry.dueOn && (
            <span className={cn(entry.dueOn >= today && 'font-medium text-foreground')}>Due {formatDay(entry.dueOn)}</span>
          )}
        </div>
        {entry.hasAttachment && (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">
                {entry.attachmentMime === 'application/pdf' ? 'PDF' : 'Image'}
                {entry.attachmentSizeBytes !== null && `, ${formatBytes(entry.attachmentSizeBytes)}`}
              </span>
              {isImage && (
                <Button variant="ghost" size="sm" onClick={() => setShowImage((v) => !v)} aria-expanded={showImage}>
                  <ImageIcon />
                  {showImage ? 'Hide picture' : 'Show picture'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void downloadDiaryAttachment(entry.id).catch(toastApiError)}
              >
                <DownloadIcon />
                Download
              </Button>
            </div>
            {showImage && (
              // eslint-disable-next-line @next/next/no-img-element -- a private, cookie-authenticated thumbnail
              <img
                src={diaryThumbnailUrl(entry.id)}
                alt={`Attachment to the ${entry.subjectName} entry`}
                className="max-h-80 w-auto max-w-full rounded-lg border object-contain"
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
