'use client';

import { ANNOUNCEMENT_CATEGORY_LABELS, EXTERNAL_CHANNELS, type ExternalChannel } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, ImageIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import {
  announcementThumbnailUrl,
  announcementsApi,
  type AnnouncementDto,
  type DeliverySummaryDto,
} from '@/lib/api/school-announcements-contract';
import { formatBytes, formatDateTime, formatDay, todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { toastApiError } from '@/lib/api/errors';
import {
  AnnouncementStatusBadge,
  PriorityBadge,
  SENDING_TOAST,
  SUPPRESSION_LABELS,
  announcementErrorMessage,
  announcementKeys,
  audienceLabel,
  downloadAnnouncementAttachment,
  isEditable,
} from '../_lib/announcements-ui';
import { SendConfirmDialog } from '../announcement-compose';

// contracts/slice-14.md §5.3, §5.5, §5.8–§5.10, §12 "Announcement detail": the record, its
// attachment, Send (confirm repeats the preview numbers), Cancel with a reason, and the delivery
// summary, polled every 30 s while messages are still queued or sending. A send now answers
// `sending` (the server writes the messages in a background job), so the record is polled every
// few seconds until it is `sent`. A send the server gave up on comes back a draft with
// `sendFailedAt`, and says so. Delivery is tracked; whether anyone opened a message is not (rule
// 0.13), and nothing here says otherwise.

const POLL_MS = 30_000;
/** While `sending`: the job usually finishes within seconds; a school-wide send within a minute. */
const SENDING_POLL_MS = 3_000;

export function AnnouncementDetail({ id }: { id: string }) {
  const announcement = useQuery({
    queryKey: announcementKeys.detail(id),
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/announcements/{id}', { params: { path: { id } } })),
    refetchInterval: (query) => (query.state.data?.status === 'sending' ? SENDING_POLL_MS : false),
  });
  return (
    <>
      <BackLink href="/announcements">Announcements</BackLink>
      <QueryStates
        query={announcement}
        notFound={{ title: 'Announcement not found', description: 'It may have been written by someone else. Find yours in the list.' }}
        noPermission="Announcements are sent by the principal, the office and teachers for their own classes."
      >
        {(a) => <Detail announcement={a} />}
      </QueryStates>
    </>
  );
}

function Detail({ announcement: a }: { announcement: AnnouncementDto }) {
  const queryClient = useQueryClient();
  const me = useSchoolMe();
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showPicture, setShowPicture] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // When the screen opened: whether a draft's stored time is still ahead (the server decides at send).
  const [openedAt] = useState(Date.now);

  const refresh = (row: AnnouncementDto) => {
    queryClient.setQueryData(announcementKeys.detail(row.id), row);
    void queryClient.invalidateQueries({ queryKey: announcementKeys.list });
    void queryClient.invalidateQueries({ queryKey: announcementKeys.delivery(row.id) });
  };

  // The confirm repeats the numbers the send will act on: a fresh preview of the saved audience.
  const preview = useQuery({
    queryKey: [...announcementKeys.preview, 'detail', a.id, a.updatedAt],
    queryFn: () =>
      unwrap(
        announcementsApi.POST('/api/v1/announcements/preview-audience', {
          body: {
            audiences: a.audiences.map((x) => ({
              kind: x.kind,
              ...(x.targetId !== null && { targetId: x.targetId }),
              ...(x.roles.length === 1 && { roles: x.roles }),
            })),
            priority: a.priority,
            holiday: a.holidayId !== null,
            title: a.title,
            body: a.body,
            hasAttachment: a.hasAttachment,
          },
        }),
      ),
    enabled: confirmingSend,
    retry: false,
  });

  const send = useMutation({
    mutationFn: () => unwrap(announcementsApi.POST('/api/v1/announcements/{id}/send', { params: { path: { id: a.id } } })),
    onMutate: () => setRefusal(null),
    onSuccess: (row) => {
      refresh(row);
      setConfirmingSend(false);
      toast.success(
        row.status === 'scheduled' && row.scheduledAt
          ? `Scheduled for ${formatDateTime(row.scheduledAt)}.`
          : row.status === 'sending'
            ? SENDING_TOAST
            : `Sent to ${row.recipientCount} ${row.recipientCount === 1 ? 'person' : 'people'}.`,
      );
    },
    onError: (error) => {
      setConfirmingSend(false);
      setRefusal(announcementErrorMessage(error));
    },
  });
  const cancel = useMutation({
    mutationFn: (reason: string) =>
      unwrap(announcementsApi.POST('/api/v1/announcements/{id}/cancel', { params: { path: { id: a.id } }, body: { reason } })),
    onMutate: () => setRefusal(null),
    onSuccess: (row) => {
      refresh(row);
      setCancelling(false);
      toast.success('Announcement cancelled. Nothing was sent.');
    },
    onError: (error) => {
      setCancelling(false);
      setRefusal(announcementErrorMessage(error));
    },
  });

  const editable = isEditable(a);
  const isImage = a.attachmentMime === 'image/jpeg' || a.attachmentMime === 'image/png';
  const scheduledInFuture = a.scheduledAt !== null && new Date(a.scheduledAt).getTime() > openedAt;
  const expired = a.expiresOn !== null && a.expiresOn < todayInSchool();
  const byMe = me.data?.id === a.createdBy;

  return (
    <>
      <PageHeader
        title={a.title}
        description={`${ANNOUNCEMENT_CATEGORY_LABELS[a.category]} · written by ${byMe ? 'you' : a.createdByName}, ${formatDateTime(a.createdAt)}`}
        actions={
          editable && (
            <>
              <Link href={`/announcements/${a.id}/edit`} className={buttonVariants({ variant: 'outline' })}>
                <PencilIcon />
                Edit
              </Link>
              <Button variant="outline" onClick={() => setCancelling(true)}>
                Cancel announcement
              </Button>
              {a.status === 'draft' && (
                <Button onClick={() => setConfirmingSend(true)}>{scheduledInFuture ? 'Schedule…' : 'Send…'}</Button>
              )}
            </>
          )
        }
      />
      <div className="grid gap-6">
        {refusal && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}
        {a.sendFailedAt && (
          <Alert variant="destructive" data-testid="send-failed">
            <AlertDescription>
              Sending failed on {formatDateTime(a.sendFailedAt)} after several tries, so nobody was sent it. It is a
              draft again: check it and send it again, or cancel it.
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <AnnouncementStatusBadge status={a.status} />
              <PriorityBadge priority={a.priority} />
              {a.holidayId && <Badge variant="outline">Holiday notice</Badge>}
              {expired && <Badge variant="ghost">Expired</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-sm" data-testid="announcement-body">
              {a.body}
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Audience">
                <ul className="grid gap-0.5">
                  {a.audiences.map((x) => (
                    <li key={`${x.kind}:${x.targetId ?? ''}`}>{audienceLabel(x)}</li>
                  ))}
                </ul>
              </Field>
              <Field label={a.status === 'sent' ? 'Sent' : a.status === 'cancelled' ? 'Cancelled' : a.status === 'sending' ? 'Sending' : 'Send time'}>
                {a.status === 'sent' && a.sentAt
                  ? `${formatDateTime(a.sentAt)} to ${a.recipientCount} ${a.recipientCount === 1 ? 'person' : 'people'}`
                  : a.status === 'sending'
                    ? <span aria-live="polite" data-testid="sending-now">Going out now. This page updates when it has gone.</span>
                  : a.status === 'cancelled' && a.cancelledAt
                    ? `${formatDateTime(a.cancelledAt)}: ${a.cancelReason ?? ''}`
                    : a.scheduledAt
                      ? formatDateTime(a.scheduledAt)
                      : 'Not sent yet'}
              </Field>
              <Field label="Expires">{a.expiresOn ? formatDay(a.expiresOn) : 'Never'}</Field>
              <Field label="By SMS">{a.smsSegments === null ? 'Not sent by SMS' : `${a.smsSegments} ${a.smsSegments === 1 ? 'segment' : 'segments'} each`}</Field>
            </dl>
            {a.hasAttachment && (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    Attachment: {a.attachmentMime === 'application/pdf' ? 'PDF' : 'picture'}
                    {a.attachmentSizeBytes !== null && ` (${formatBytes(a.attachmentSizeBytes)})`}
                  </span>
                  {isImage && !showPicture && (
                    <Button variant="ghost" size="sm" onClick={() => setShowPicture(true)}>
                      <ImageIcon />
                      Show picture
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void downloadAnnouncementAttachment(a.id).catch(toastApiError)}>
                    <DownloadIcon />
                    Download
                  </Button>
                </div>
                {isImage && showPicture && (
                  // eslint-disable-next-line @next/next/no-img-element -- cookie-authenticated stream, loaded on tap only
                  <img src={announcementThumbnailUrl(a.id)} alt="Attachment to this announcement" className="max-h-64 w-auto rounded-lg border" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
        {a.status === 'sent' && <DeliverySummary id={a.id} />}
      </div>

      <SendConfirmDialog
        open={confirmingSend}
        pending={send.isPending}
        preview={preview.data}
        priority={a.priority}
        scheduledAt={scheduledInFuture ? a.scheduledAt : null}
        onCancel={() => setConfirmingSend(false)}
        onConfirm={() => send.mutate()}
      />
      <ConfirmWithReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this announcement?"
        description="Nothing has been sent, and nothing will be. The announcement stays on the list as cancelled."
        confirmLabel="Cancel announcement"
        minLength={3}
        destructive
        pending={cancel.isPending}
        onConfirm={(reason) => cancel.mutate(reason)}
      />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const CHANNEL_LABELS: Record<ExternalChannel, string> = {
  push: 'App notification',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
};

/** §5.9: computed live; polled while anything is still queued or sending. */
function DeliverySummary({ id }: { id: string }) {
  const summary = useQuery({
    queryKey: announcementKeys.delivery(id),
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/announcements/{id}/delivery', { params: { path: { id } } })),
    refetchInterval: (query) => {
      const m = query.state.data?.messages;
      return m && m.queued + m.sending > 0 ? POLL_MS : false;
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery</CardTitle>
        <CardDescription>What each channel did with the message. Delivered means it reached the phone.</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={summary} loadingRows={4}>
          {(d) => <DeliveryBody summary={d} />}
        </QueryStates>
      </CardContent>
    </Card>
  );
}

function DeliveryBody({ summary: d }: { summary: DeliverySummaryDto }) {
  const pending = d.messages.queued + d.messages.sending;
  const byChannel = EXTERNAL_CHANNELS.map(
    (channel) => d.byChannel.find((c) => c.channel === channel) ?? { channel, accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
  );
  return (
    <div className="grid gap-4" data-testid="delivery-summary">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Count label="People" value={d.recipients.total} />
        <Count label="Families" value={d.recipients.guardians} />
        <Count label="Students" value={d.recipients.students} />
        <Count label="Staff" value={d.recipients.staff} />
      </dl>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {pending > 0
          ? `${pending} still going out. This page updates every 30 seconds.`
          : `Finished. ${d.messages.delivered} delivered, ${d.messages.failed} failed, ${d.messages.suppressed} not sent.`}
        {d.smsSegmentsPerMessage !== null && ` SMS: ${d.smsUnitsReserved} units used, ${d.smsSegmentsPerMessage} per message.`}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Channel</TableHead>
              <TableHead className="px-4 text-right">Handed over</TableHead>
              <TableHead className="px-4 text-right">Delivered</TableHead>
              <TableHead className="px-4 text-right">Failed</TableHead>
              <TableHead className="px-4 text-right">Not sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byChannel.map((c) => (
              <TableRow key={c.channel} data-testid={`channel-${c.channel}`}>
                <TableCell className="px-4">{CHANNEL_LABELS[c.channel]}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{c.accepted}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{c.delivered}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{c.failed}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{c.suppressed}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {d.suppressions.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Why some were not sent</h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableBody>
                {d.suppressions.map((s) => (
                  <TableRow key={s.reason} data-testid={`suppression-${s.reason}`}>
                    <TableCell className="px-4">{SUPPRESSION_LABELS[s.reason]}</TableCell>
                    <TableCell className="px-4 text-right tabular-nums">{s.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">As of {formatDateTime(d.computedAt)}.</p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
