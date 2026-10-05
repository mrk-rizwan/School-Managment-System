'use client';

import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_TITLE_MAX,
  ErrorCode,
  audiencesProblem,
  containsIdentityNumber,
  newIdempotencyKey,
  type AnnouncementCategory,
  type AnnouncementPriority,
  type AudienceInput,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { AudiencePicker } from '@/components/audience-picker/audience-picker';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { BackLink, NoPermissionState, StateCard } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  announcementsApi,
  type AnnouncementDto,
  type AudiencePreviewDto,
  type CreateAnnouncementBody,
  type PreviewAudienceBody,
  type UpdateAnnouncementBody,
} from '@/lib/api/school-announcements-contract';
import type { StagedUploadDto } from '@/lib/api/school-students-contract';
import { formatBytes, formatDateTime, todayInSchool } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { ACCEPTED_TYPES, ACCEPT_ATTRIBUTE, MAX_UPLOAD_BYTES, uploadFile } from '../students/_lib/documents';
import {
  SENDING_TOAST,
  announcementErrorMessage,
  announcementHref,
  announcementKeys,
  instantToLocal,
  localToInstant,
  senderReach,
} from './_lib/announcements-ui';

// contracts/slice-14.md §5.4, §5.5, §5.7, §12 "Compose / edit": the fields of concept slide 03 in
// its order; the audience picker; a debounced preview (500 ms) giving people, SMS units and
// segments; Save draft, or Send / Schedule through a confirm that repeats the preview numbers.
// One Idempotency-Key per opening of the composer (§3); once the draft exists, saves are PATCHes.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const noId = (v: string) => !containsIdentityNumber(v.replace(/[\s+-]/g, ''));
const schema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Write a title.')
    .max(ANNOUNCEMENT_TITLE_MAX, `Use at most ${ANNOUNCEMENT_TITLE_MAX} characters.`)
    .regex(/^\P{Cc}*$/u, 'Keep the title on one line.')
    .refine(noId, 'Remove the identity number.'),
  body: z
    .string()
    .trim()
    .min(1, 'Write the message.')
    .max(ANNOUNCEMENT_BODY_MAX, `Use at most ${ANNOUNCEMENT_BODY_MAX} characters.`)
    .refine(noId, 'Remove the identity number.'),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  priority: z.enum(['normal', 'urgent']),
  schedule: z.boolean(),
  scheduledAt: z.string(),
  expiresOn: z.string(),
});
type Values = z.infer<typeof schema>;

type Attachment = { kind: 'saved' } | { kind: 'staged'; upload: StagedUploadDto; name: string } | { kind: 'none' };

const CATEGORY_OPTIONS = ANNOUNCEMENT_CATEGORIES.map((c) => ({ value: c, label: ANNOUNCEMENT_CATEGORY_LABELS[c] }));
const PRIORITY_OPTIONS = [
  { value: 'normal', label: 'Normal: WhatsApp and the app' },
  { value: 'urgent', label: 'Urgent: WhatsApp and SMS together' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The preview line of §12: "N people · M SMS units of R remaining · K segments". */
export function previewLine(p: AudiencePreviewDto): string {
  const people = plural(p.recipients.total, 'person', 'people');
  if (!p.sms.allowed) return `${people} · not sent by SMS`;
  return `${people} · ${plural(p.sms.units, 'SMS unit')} of ${p.sms.remaining} remaining · ${plural(p.sms.segments, 'segment')}`;
}

export const WARNING_MESSAGES: Record<AudiencePreviewDto['warnings'][number], (p: AudiencePreviewDto) => string> = {
  sms_too_long: () => 'Over 3 SMS segments; shorten or send as normal.',
  sms_cap_short: (p) => `Needs ${plural(p.sms.units, 'SMS unit')}; ${p.sms.remaining} remain this month. Send as normal, or shorten.`,
  no_recipients: () => 'Nobody is in this audience today.',
  whatsapp_not_connected: () => 'The school’s WhatsApp is not connected: families will be reached by SMS or the app instead.',
};

/** The index of a refused audience item, from a 422's `audiences[i]…` path. */
function audienceFieldError(error: unknown): { index: number; message: string } | null {
  if (!(error instanceof ApiError)) return null;
  for (const field of error.fieldErrors) {
    const match = /^audiences\[(\d+)\]/.exec(field.path);
    if (match) {
      const message =
        field.code === ErrorCode.REFERENCE_NOT_FOUND ? 'Not found, or outside the classes and students you can reach.' : field.message;
      return { index: Number(match[1]), message };
    }
  }
  return null;
}

export function AnnouncementCompose({ announcement }: { announcement?: AnnouncementDto }) {
  const me = useSchoolMe();
  const today = todayInSchool();
  const reach = senderReach(me.data, today);
  if (me.data && !reach.canSend) {
    return (
      <>
        <BackLink href="/announcements">Announcements</BackLink>
        <PageHeader title={announcement ? 'Edit announcement' : 'New announcement'} />
        <StateCard>
          <NoPermissionState description="Announcements are sent by the principal, the office and teachers for their own classes." />
        </StateCard>
      </>
    );
  }
  return <ComposeForm announcement={announcement} reach={reach} today={today} />;
}

function ComposeForm({
  announcement,
  reach,
  today,
}: {
  announcement?: AnnouncementDto;
  reach: ReturnType<typeof senderReach>;
  today: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const bodyId = useId();
  const fileId = useId();
  const scheduleId = useId();
  // §3: one key per opening of the composer; a retried create is a replay, never a second row.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  // The row once it exists (edited, or created by an earlier save here): later saves PATCH it.
  const [saved, setSaved] = useState<AnnouncementDto | null>(announcement ?? null);
  const [audiences, setAudiences] = useState<AudienceInput[]>(
    () =>
      announcement?.audiences.map((a) => ({
        kind: a.kind,
        ...(a.targetId !== null && { targetId: a.targetId }),
        ...(a.roles.length === 1 && { roles: a.roles }),
      })) ?? [],
  );
  const [invalidAudience, setInvalidAudience] = useState<{ index: number; message: string } | null>(null);
  const [attachment, setAttachment] = useState<Attachment>(announcement?.hasAttachment ? { kind: 'saved' } : { kind: 'none' });
  const [confirming, setConfirming] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: announcement?.title ?? '',
      body: announcement?.body ?? '',
      category: announcement?.category ?? 'general',
      priority: announcement?.priority ?? 'normal',
      schedule: announcement?.scheduledAt != null,
      scheduledAt: announcement?.scheduledAt ? instantToLocal(announcement.scheduledAt) : '',
      expiresOn: announcement?.expiresOn ?? '',
    },
  });
  const [title, body, priority, schedule] = useWatch({ control: form.control, name: ['title', 'body', 'priority', 'schedule'] });

  // ---- The live preview (§4.6), 500 ms after the last audience, priority, title or body change ----
  const problem = audiencesProblem(audiences);
  const liveInput: PreviewAudienceBody = {
    audiences,
    priority: priority as AnnouncementPriority,
    hasAttachment: attachment.kind !== 'none',
    // Both or neither: with both the segment count is exact (§4.6).
    ...(title.trim() && body.trim() && title.trim().length <= ANNOUNCEMENT_TITLE_MAX && body.trim().length <= ANNOUNCEMENT_BODY_MAX
      ? { title: title.trim(), body: body.trim() }
      : {}),
  };
  // Debounced as text: a string settles, a fresh object every render would not.
  const previewInput = JSON.parse(useDebounced(JSON.stringify(liveInput), 500)) as PreviewAudienceBody;
  const previewProblem = audiencesProblem(previewInput.audiences);
  const preview = useQuery({
    queryKey: [...announcementKeys.preview, previewInput],
    queryFn: () => unwrap(announcementsApi.POST('/api/v1/announcements/preview-audience', { body: previewInput })),
    enabled: previewProblem === null,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const previewData = problem === null && previewProblem === null ? preview.data : undefined;
  const previewRefusal = problem === null && preview.error ? preview.error : null;
  const previewAudienceError = audienceFieldError(previewRefusal);

  // ---- Attachment: staged through POST /uploads the moment it is chosen (R148) ----
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(file),
    onSuccess: (staged, file) => setAttachment({ kind: 'staged', upload: staged, name: file.name }),
  });
  const pickFile = (file: File | undefined) => {
    upload.reset();
    form.clearErrors('root.server');
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) return form.setError('root.server', { message: 'Choose a JPEG, PNG or PDF file.' });
    if (file.size > MAX_UPLOAD_BYTES) return form.setError('root.server', { message: 'The file is larger than 5 MB.' });
    upload.mutate(file);
  };

  // ---- Save (create or patch), then optionally send ----
  const bodyOf = (v: Values): CreateAnnouncementBody => ({
    title: v.title.trim(),
    body: v.body.trim(),
    category: v.category as AnnouncementCategory,
    priority: v.priority as AnnouncementPriority,
    audiences,
    ...(v.schedule && v.scheduledAt && { scheduledAt: localToInstant(v.scheduledAt) }),
    ...(v.expiresOn && { expiresOn: v.expiresOn }),
    ...(attachment.kind === 'staged' && { stagedUploadId: attachment.upload.id }),
  });
  /** Only what changed against the saved row (§5.7: absent = unchanged). */
  const changesOf = (v: Values, row: AnnouncementDto): UpdateAnnouncementBody => {
    const next = bodyOf(v);
    const rowAudiences = JSON.stringify(
      row.audiences.map((a) => ({ kind: a.kind, ...(a.targetId !== null && { targetId: a.targetId }), ...(a.roles.length === 1 && { roles: a.roles }) })),
    );
    const scheduledAt = next.scheduledAt ?? null;
    const expiresOn = next.expiresOn ?? null;
    return {
      ...(next.title !== row.title && { title: next.title }),
      ...(next.body !== row.body && { body: next.body }),
      ...(next.category !== row.category && { category: next.category }),
      ...(next.priority !== row.priority && { priority: next.priority }),
      ...(JSON.stringify(audiences) !== rowAudiences && { audiences }),
      ...(scheduledAt !== row.scheduledAt && { scheduledAt }),
      ...(expiresOn !== row.expiresOn && { expiresOn }),
      ...(attachment.kind === 'staged' && { stagedUploadId: attachment.upload.id }),
      ...(attachment.kind === 'none' && row.hasAttachment && { stagedUploadId: null }),
    };
  };

  const save = useMutation({
    mutationFn: async ({ values, send }: { values: Values; send: boolean }) => {
      let row = saved;
      if (!row) {
        row = await unwrap(
          announcementsApi.POST('/api/v1/announcements', {
            params: { header: { 'Idempotency-Key': idempotencyKey } },
            body: bodyOf(values),
          }),
        );
      } else {
        const changes = changesOf(values, row);
        if (Object.keys(changes).length > 0) {
          row = await unwrap(announcementsApi.PATCH('/api/v1/announcements/{id}', { params: { path: { id: row.id } }, body: changes }));
        }
      }
      setSaved(row);
      if (row.hasAttachment) setAttachment({ kind: 'saved' });
      return send ? unwrap(announcementsApi.POST('/api/v1/announcements/{id}/send', { params: { path: { id: row.id } } })) : row;
    },
    onMutate: () => {
      setInvalidAudience(null);
      form.clearErrors();
    },
    onSuccess: (row, { send }) => {
      queryClient.setQueryData(announcementKeys.detail(row.id), row);
      void queryClient.invalidateQueries({ queryKey: announcementKeys.list });
      setConfirming(false);
      toast.success(
        !send
          ? 'Draft saved.'
          : row.status === 'scheduled' && row.scheduledAt
            ? `Scheduled for ${formatDateTime(row.scheduledAt)}.`
            : row.status === 'sending'
              ? SENDING_TOAST
              : `Sent to ${plural(row.recipientCount, 'person', 'people')}.`,
      );
      router.push(announcementHref(row.id));
    },
    onError: (error) => {
      setConfirming(false);
      if (!(error instanceof ApiError)) return form.setError('root.server', { message: announcementErrorMessage(error) });
      if (error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
      if (error.code === ErrorCode.SMS_TOO_LONG) {
        form.setError('body', { message: announcementErrorMessage(error) }, { shouldFocus: true });
        return;
      }
      const refused = audienceFieldError(error);
      if (refused) {
        setInvalidAudience(refused);
        const others = error.fieldErrors.filter((f) => !f.path.startsWith('audiences'));
        if (others.length === 0) return;
      }
      if (error.fieldErrors.some((f) => f.path === 'stagedUploadId')) {
        setAttachment({ kind: 'none' });
        return form.setError('root.server', { message: 'The attachment expired before it was saved. Choose the file again.' });
      }
      if (error.fieldErrors.some((f) => f.path === 'scheduledAt')) {
        return form.setError('scheduledAt', { message: 'Choose a time at least a minute from now and within 90 days.' });
      }
      if (!applyApiFieldErrors(form, error)) form.setError('root.server', { message: announcementErrorMessage(error) });
    },
  });

  /** Client checks the server repeats (§5.4): schedule window, expiry, a usable audience. */
  const validated = (then: (v: Values) => void) =>
    form.handleSubmit((v) => {
      if (problem) return form.setError('root.server', { message: 'Choose who receives it.' });
      if (v.schedule) {
        if (!v.scheduledAt) return form.setError('scheduledAt', { message: 'Choose the date and time to send it.' });
        const at = new Date(localToInstant(v.scheduledAt)).getTime();
        if (at < Date.now() + MINUTE || at > Date.now() + 90 * DAY) {
          return form.setError('scheduledAt', { message: 'Choose a time at least a minute from now and within 90 days.' });
        }
      }
      if (v.expiresOn && v.expiresOn < today) return form.setError('expiresOn', { message: 'The expiry cannot be in the past.' });
      then(v);
    });

  const busy = save.isPending || upload.isPending;
  const segmentsLine = previewData
    ? previewData.sms.allowed
      ? ` · ${plural(previewData.sms.segments, 'SMS segment')}`
      : ' · not sent by SMS'
    : '';
  const tooLong = previewData?.warnings.includes('sms_too_long') ?? false;
  const bodyError = form.formState.errors.body?.message;
  const valuesNow = form.getValues();

  return (
    <>
      <BackLink href={saved ? announcementHref(saved.id) : '/announcements'}>{saved ? 'Announcement' : 'Announcements'}</BackLink>
      <PageHeader
        title={announcement ? 'Edit announcement' : 'New announcement'}
        description="Families get it once each, on WhatsApp, SMS or the app, whatever their phone allows."
      />
      <form noValidate className="grid max-w-3xl gap-5" onSubmit={validated((v) => save.mutate({ values: v, send: false }))}>
        <FormRootError form={form} />
        <FormField control={form.control} name="title" label="Title" maxLength={ANNOUNCEMENT_TITLE_MAX} hint="The short headline families see first." />

        <div className="grid gap-1.5">
          <Label htmlFor={bodyId}>Message</Label>
          <Textarea
            id={bodyId}
            rows={6}
            maxLength={ANNOUNCEMENT_BODY_MAX}
            {...form.register('body')}
            aria-invalid={bodyError || tooLong ? true : undefined}
            aria-describedby={`${bodyId}-count`}
          />
          <p id={`${bodyId}-count`} className="text-xs text-muted-foreground tabular-nums" data-testid="body-counter" aria-live="polite">
            {body.length} of {ANNOUNCEMENT_BODY_MAX} characters{segmentsLine}
          </p>
          {(bodyError ?? (tooLong ? WARNING_MESSAGES.sms_too_long(previewData as AudiencePreviewDto) : null)) && (
            <p className="text-xs text-destructive" data-testid="body-error">
              {bodyError ?? WARNING_MESSAGES.sms_too_long(previewData as AudiencePreviewDto)}
            </p>
          )}
        </div>

        <section className="grid gap-2" aria-label="Audience">
          <h2 className="text-sm font-medium">Audience</h2>
          <AudiencePicker
            value={audiences}
            onChange={(next) => (setAudiences(next), setInvalidAudience(null))}
            canSchoolWide={reach.canSchoolWide}
            sectionScope={reach.scope}
            initialLabels={announcement?.audiences}
            preview={{
              byAudience: previewData?.byAudience,
              total: previewData?.recipients.total,
              pending: preview.isFetching,
            }}
            invalid={invalidAudience ?? previewAudienceError}
            disabled={save.isPending}
          />
          {previewRefusal && !previewAudienceError && (
            <p className="text-sm text-destructive" role="alert">
              {announcementErrorMessage(previewRefusal)}
            </p>
          )}
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="priority" label="Priority" options={PRIORITY_OPTIONS} />
          <FormField control={form.control} name="category" label="Category" options={CATEGORY_OPTIONS} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={fileId}>Attachment (optional)</Label>
          {attachment.kind === 'none' ? (
            <input
              id={fileId}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              disabled={busy}
              className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1 file:text-sm"
              onChange={(event) => pickFile(event.target.files?.[0])}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="announcement-attachment">
              <span className="truncate">
                {attachment.kind === 'staged'
                  ? `${attachment.name} (${formatBytes(attachment.upload.sizeBytes)})`
                  : `Saved ${saved?.attachmentMime === 'application/pdf' ? 'PDF' : 'picture'}`}
              </span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove the attachment" disabled={busy} onClick={() => setAttachment({ kind: 'none' })}>
                <XIcon />
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {upload.isPending ? 'Uploading…' : 'One JPEG, PNG or PDF, up to 5 MB. SMS says “open the app to view it”.'}
          </p>
          {upload.error && <p className="text-xs text-destructive">{announcementErrorMessage(upload.error)}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <div className="flex h-8 items-center gap-2">
              <input id={scheduleId} type="checkbox" className="size-4 accent-primary" {...form.register('schedule')} />
              <Label htmlFor={scheduleId}>Schedule for later</Label>
            </div>
            {schedule && (
              <FormField control={form.control} name="scheduledAt" label="Send at (Pakistan time)" type="datetime-local" />
            )}
          </div>
          <FormField control={form.control} name="expiresOn" label="Expires on (optional)" type="date" hint="It leaves families’ inboxes after this day." />
        </div>

        {previewData && (
          <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-testid="preview-summary" aria-live="polite">
            <span className={cn('tabular-nums', preview.isFetching && 'text-muted-foreground')}>{previewLine(previewData)}</span>
            {previewData.warnings
              .filter((w) => w !== 'sms_too_long')
              .map((w) => (
                <span key={w} className={w === 'whatsapp_not_connected' ? 'text-muted-foreground' : 'text-destructive'}>
                  {WARNING_MESSAGES[w](previewData)}
                </span>
              ))}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="outline" disabled={busy}>
            {save.isPending && !confirming ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" disabled={busy} onClick={validated(() => setConfirming(true))}>
            {schedule ? 'Schedule…' : 'Send…'}
          </Button>
        </div>
      </form>

      <SendConfirmDialog
        open={confirming}
        pending={save.isPending}
        preview={previewData}
        priority={priority as AnnouncementPriority}
        scheduledAt={schedule && valuesNow.scheduledAt ? localToInstant(valuesNow.scheduledAt) : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => save.mutate({ values: form.getValues(), send: true })}
      />
    </>
  );
}

/** §12 "Send confirm repeats the preview numbers and 'Urgent: WhatsApp and SMS together'". */
export function SendConfirmDialog({
  open,
  pending,
  preview,
  priority,
  scheduledAt,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  preview: AudiencePreviewDto | undefined;
  priority: AnnouncementPriority;
  scheduledAt: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{scheduledAt ? 'Schedule this announcement?' : 'Send this announcement now?'}</DialogTitle>
          <DialogDescription>
            {scheduledAt
              ? `It goes at ${formatDateTime(scheduledAt)}, to the audience as it stands then. You can edit or cancel it until then.`
              : 'Once sent it cannot be recalled. A correction is a new announcement.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 text-sm" data-testid="send-confirm-numbers">
          {preview ? <span className="tabular-nums">{previewLine(preview)}</span> : <span className="text-muted-foreground">Counting the audience…</span>}
          {priority === 'urgent' && <span className="font-medium">Urgent: WhatsApp and SMS together.</span>}
          {preview?.warnings
            .filter((w) => w !== 'whatsapp_not_connected')
            .map((w) => (
              <span key={w} className="text-destructive">
                {WARNING_MESSAGES[w](preview)}
              </span>
            ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Back
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {pending ? 'Working…' : scheduledAt ? 'Schedule' : 'Send now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
