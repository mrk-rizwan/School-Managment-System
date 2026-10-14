'use client';

import { Capability, formatRupees } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, NoPermissionState, QueryStates, StateCard } from '@/components/page-states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { eventsApi } from '@/lib/api/school-events-contract';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { EventStatusBadge, eventHref, eventKeys } from '../../_lib/events-ui';

// contracts/slice-38.md §2.8, R314: participants, collections, tagged expenses and the net, live,
// for finance.report.view or holiday.manage holders, once the event is published.

export function EventReport({ id }: { id: string }) {
  const me = useSchoolMe();
  const { can } = useCapabilities();
  const allowed = can(Capability.FINANCE_REPORT_VIEW) || can(Capability.HOLIDAY_MANAGE);
  const report = useQuery({
    queryKey: eventKeys.report(id),
    queryFn: () => unwrap(eventsApi.GET('/api/v1/events/{id}/report', { params: { path: { id } } })),
    enabled: allowed,
    retry: false,
  });

  if (me.data && !allowed) {
    return (
      <>
        <BackLink href={eventHref(id)}>Event</BackLink>
        <PageHeader title="Event report" />
        <StateCard>
          <NoPermissionState description="The event report is for the principal and staff who read the finance reports." />
        </StateCard>
      </>
    );
  }
  // 409 EVENT_NOT_PUBLISHED: a draft or cancelled event has nothing to report.
  if (report.error instanceof ApiError && report.error.status === 409) {
    return (
      <>
        <BackLink href={eventHref(id)}>Event</BackLink>
        <PageHeader title="Event report" />
        <StateCard>
          <EmptyState title="No report yet" description="The report is ready once the event is published." />
        </StateCard>
      </>
    );
  }
  return (
    <>
      <BackLink href={eventHref(id)}>Event</BackLink>
      <QueryStates query={report} notFound={{ title: 'Event not found', description: 'It may have been removed.' }}>
        {(r) => (
          <>
            <PageHeader title={`Report · ${r.title}`} description="Live figures: they change as payments, participation and expenses are recorded." />
            <div className="mb-4">
              <EventStatusBadge status={r.status} />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Section title="Participants">
                <Row label="On the roster" value={String(r.participants.roster)} />
                <Row label="Attended" value={String(r.participants.attended)} />
                <Row label="Absent" value={String(r.participants.absent)} />
                <Row label="Excused" value={String(r.participants.excused)} />
                <Row label="Not recorded" value={String(r.participants.unrecorded)} />
              </Section>
              <Section title="Collections">
                <Row label="Charges" value={String(r.collections.chargeCount)} />
                <Row label="Charged" value={formatRupees(r.collections.charged)} />
                <Row label="Collected" value={formatRupees(r.collections.collected)} />
                <Row label="Outstanding" value={formatRupees(r.collections.outstanding)} />
              </Section>
              <Section title="Expenses">
                <Row label="Tagged expenses" value={String(r.expenses.count)} />
                <Row label="Total" value={formatRupees(r.expenses.total)} />
              </Section>
            </div>
            <Card className="mt-4">
              <CardContent className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">Net (collected less expenses)</span>
                <span data-testid="event-net" className={cn('text-lg font-semibold tabular-nums', r.net < 0 && 'text-destructive')}>
                  {formatRupees(r.net)}
                </span>
              </CardContent>
            </Card>
          </>
        )}
      </QueryStates>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2 text-sm">{children}</dl>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
