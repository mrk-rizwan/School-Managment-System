'use client';

import { Capability, EVENT_TYPE_LABELS, formatRupees } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartColumnIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { eventsApi, type EventDto } from '@/lib/api/school-events-contract';
import { formatDateTime, formatDay } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import {
  CAMPAIGN_STATUS_LABELS,
  EventStatusBadge,
  eventErrorMessage,
  eventHref,
  eventKeys,
  eventSpan,
  sectionsLabel,
} from '../_lib/events-ui';
import { EventDuties } from './event-duties';
import { EventParticipation } from './event-participation';
import { EventPayments } from './event-payments';

// contracts/slice-38.md §2.4–§2.8, §6: the event, Publish / Cancel / Complete and Edit for
// holiday.manage holders, the duties, the participation roster for whoever the API lets read it
// (a 404 hides the panel), the event's payments for a collector or a payment.record holder, and
// the link to the report.

type Confirming = 'publish' | 'complete' | null;

export function EventDetail({ id }: { id: string }) {
  const event = useQuery({
    queryKey: eventKeys.detail(id),
    queryFn: () => unwrap(eventsApi.GET('/api/v1/events/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/events">Events</BackLink>
      <QueryStates query={event} notFound={{ title: 'Event not found', description: 'It may have been removed, or it is a draft you cannot see.' }}>
        {(e) => <Detail event={e} />}
      </QueryStates>
    </>
  );
}

function Detail({ event: e }: { event: EventDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canManage = can(Capability.HOLIDAY_MANAGE);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [cancelling, setCancelling] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const refresh = (row: EventDto) => {
    queryClient.setQueryData(eventKeys.detail(row.id), row);
    void queryClient.invalidateQueries({ queryKey: eventKeys.list });
    void queryClient.invalidateQueries({ queryKey: eventKeys.roster(row.id) });
    void queryClient.invalidateQueries({ queryKey: eventKeys.report(row.id) });
  };
  const path = { params: { path: { id: e.id } } };
  const transition = useMutation({
    mutationFn: (action: 'publish' | 'complete') =>
      unwrap(
        action === 'publish'
          ? eventsApi.POST('/api/v1/events/{id}/publish', path)
          : eventsApi.POST('/api/v1/events/{id}/complete', path),
      ),
    onMutate: () => setRefusal(null),
    onSuccess: (row, action) => {
      refresh(row);
      setConfirming(null);
      toast.success(action === 'publish' ? 'Published. The invitation is going out to the families.' : 'Event marked completed.');
    },
    onError: (error) => {
      setConfirming(null);
      setRefusal(eventErrorMessage(error));
    },
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => unwrap(eventsApi.POST('/api/v1/events/{id}/cancel', { ...path, body: { reason } })),
    onMutate: () => setRefusal(null),
    onSuccess: (row) => {
      refresh(row);
      setCancelling(false);
      toast.success(row.cancelAnnouncementId ? 'Event cancelled. The families are being told.' : 'Event cancelled.');
    },
    onError: (error) => {
      setCancelling(false);
      setRefusal(eventErrorMessage(error));
    },
  });

  const live = e.status === 'published' || e.status === 'completed';
  const canReport = live && (canManage || can(Capability.FINANCE_REPORT_VIEW));
  const canCollect = e.myDuties.includes('collection') || can(Capability.PAYMENT_RECORD);

  return (
    <>
      <PageHeader
        title={e.title}
        description={`${EVENT_TYPE_LABELS[e.type]} · ${eventSpan(e)}`}
        actions={
          <>
            {canReport && (
              <Link href={`${eventHref(e.id)}/report`} className={buttonVariants({ variant: 'outline' })}>
                <ChartColumnIcon />
                Report
              </Link>
            )}
            {canManage && e.status === 'draft' && (
              <Link href={`${eventHref(e.id)}/edit`} className={buttonVariants({ variant: 'outline' })}>
                <PencilIcon />
                Edit
              </Link>
            )}
            {canManage && (e.status === 'draft' || e.status === 'published') && (
              <Button variant="outline" onClick={() => setCancelling(true)}>
                Cancel event
              </Button>
            )}
            {canManage && e.status === 'published' && <Button onClick={() => setConfirming('complete')}>Mark completed</Button>}
            {canManage && e.status === 'draft' && <Button onClick={() => setConfirming('publish')}>Publish…</Button>}
          </>
        }
      />
      <div className="grid gap-6">
        {refusal && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <EventStatusBadge status={e.status} />
              <span className="text-sm text-muted-foreground">{e.academicYearName}</span>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Venue">{e.venue}</Field>
              <Field label="When">{eventSpan(e)}</Field>
              <Field label="Sections">{sectionsLabel(e)}</Field>
              <Field label="Charge">
                {e.charge ? (
                  <span data-testid="event-charge">
                    {formatRupees(e.charge.amount)} per student, due {formatDay(e.charge.dueOn)}
                    {e.campaignStatus && (
                      <span className="block text-xs text-muted-foreground">
                        {CAMPAIGN_STATUS_LABELS[e.campaignStatus] ?? e.campaignStatus}
                      </span>
                    )}
                  </span>
                ) : (
                  'No charge'
                )}
              </Field>
              <Field label="Created">
                {e.createdByName}, {formatDateTime(e.createdAt)}
              </Field>
              {e.completedAt && <Field label="Completed">{formatDateTime(e.completedAt)}</Field>}
              {e.cancelledAt && (
                <Field label="Cancelled">
                  {formatDateTime(e.cancelledAt)}: {e.cancelReason ?? ''}
                </Field>
              )}
            </dl>
            {e.details && <p className="whitespace-pre-wrap text-sm">{e.details}</p>}
          </CardContent>
        </Card>
        {(canManage || e.duties.length > 0) && <EventDuties event={e} canManage={canManage} />}
        {live && <EventParticipation event={e} />}
        {live && e.campaignId !== null && canCollect && <EventPayments event={e} />}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && !transition.isPending && setConfirming(null)}>
        <DialogContent showCloseButton={!transition.isPending}>
          <DialogHeader>
            <DialogTitle>{confirming === 'publish' ? 'Publish this event?' : 'Mark this event completed?'}</DialogTitle>
            <DialogDescription>
              {confirming === 'publish'
                ? `The families of ${sectionsLabel(e)} are sent the invitation${
                    e.charge ? `, and each student is charged ${formatRupees(e.charge.amount)}` : ''
                  }. A published event cannot be edited.`
                : 'Participation can no longer be recorded once the event is completed.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={transition.isPending} onClick={() => setConfirming(null)}>
              Back
            </Button>
            <Button disabled={transition.isPending} onClick={() => confirming && transition.mutate(confirming)}>
              {transition.isPending ? 'Working…' : confirming === 'publish' ? 'Publish' : 'Mark completed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this event?"
        description={
          e.status === 'published'
            ? `The families are told it is cancelled.${e.charge ? ' Unpaid event charges are voided; what families paid is credited to them.' : ''}`
            : 'Nothing has been sent for this draft, and nothing will be.'
        }
        confirmLabel="Cancel event"
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
