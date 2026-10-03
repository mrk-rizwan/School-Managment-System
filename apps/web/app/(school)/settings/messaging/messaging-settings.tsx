'use client';

import {
  Capability,
  ErrorCode,
  MESSAGE_TYPES,
  MESSAGE_TYPE_TABLE,
  SMS_ELIGIBLE_TYPES,
  type MessageType,
} from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { NoPermissionState, QueryStates, StateCard } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  messagingApi,
  type MessagingUsageDto,
  type SchoolSettingsDto,
  type SmsCapExceeded,
  type TestChannel,
  type UsageChannel,
} from '@/lib/api/school-messaging-contract';
import { schoolKeys, useCapabilities } from '@/lib/school-session';
import { MESSAGE_TYPE_LABELS } from '../_lib/settings-ui';
import { messagingKeys } from './messaging-keys';
import { WhatsAppCard } from './whatsapp-card';

// contracts/slice-9.md §5 and §14: the school's WhatsApp number, the SMS allow list, SMS usage
// against the platform's cap, and a test message per channel. Everything needs
// school.settings.manage.

export function MessagingSettings() {
  const { can } = useCapabilities();
  return (
    <>
      <PageHeader
        title="Messaging"
        description="How messages reach guardians and staff: WhatsApp, SMS and the app."
        actions={
          <Link href="/settings" className="text-sm underline-offset-4 hover:underline">
            School settings
          </Link>
        }
      />
      {can(Capability.SCHOOL_SETTINGS_MANAGE) ? (
        <div className="grid max-w-3xl gap-6">
          <WhatsAppCard />
          <SmsAllowListCard />
          <UsageCard />
          <TestMessageCard />
        </div>
      ) : (
        <StateCard>
          <NoPermissionState description="Messaging settings need the school settings permission. Ask your principal if you need it." />
        </StateCard>
      )}
    </>
  );
}

// ---- SMS allow list (§4: smsAllowedTypes) ----

/** Types that never travel by SMS, shown disabled so the list is complete; internal types are not offered. */
const NEVER_BY_SMS: readonly MessageType[] = MESSAGE_TYPES.filter(
  (type) => !MESSAGE_TYPE_TABLE[type].smsEligible && MESSAGE_TYPE_TABLE[type].priority === 'low',
);

function SmsAllowListCard() {
  const settings = useQuery({
    queryKey: schoolKeys.settings,
    queryFn: () => unwrap(messagingApi.GET('/api/v1/school/settings')),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>What may go by SMS</CardTitle>
        <CardDescription>
          SMS is paid per message. Ticked types are sent by SMS to guardians without WhatsApp, or when WhatsApp
          fails. Everything else reaches guardians by WhatsApp and the app only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={settings} loadingRows={4}>
          {/* Keyed by the last update so the boxes restart from the saved list. */}
          {(data) => <AllowListForm key={data.updatedAt} settings={data} />}
        </QueryStates>
      </CardContent>
    </Card>
  );
}

function AllowListForm({ settings }: { settings: SchoolSettingsDto }) {
  const queryClient = useQueryClient();
  const [allowed, setAllowed] = useState<ReadonlySet<MessageType>>(() => new Set(settings.smsAllowedTypes));
  // Sent in the message-type table's order, which is how the API returns it.
  const list = SMS_ELIGIBLE_TYPES.filter((type) => allowed.has(type));
  const dirty = list.join() !== settings.smsAllowedTypes.join();

  const save = useMutation({
    mutationFn: () =>
      unwrap(messagingApi.PATCH('/api/v1/school/settings', { body: { smsAllowedTypes: list } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(schoolKeys.settings, updated);
      toast.success('SMS allow list saved.');
    },
  });

  const toggle = (type: MessageType, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(type);
    else next.delete(type);
    setAllowed(next);
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }}
    >
      <fieldset className="grid gap-2.5">
        <legend className="sr-only">Message types allowed by SMS</legend>
        {SMS_ELIGIBLE_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={allowed.has(type)}
              disabled={save.isPending}
              onChange={(event) => toggle(type, event.target.checked)}
            />
            <span>
              {MESSAGE_TYPE_LABELS[type]}
              {!MESSAGE_TYPE_TABLE[type].smsAllowedByDefault && (
                <span className="text-muted-foreground"> · off by default</span>
              )}
            </span>
          </label>
        ))}
        {NEVER_BY_SMS.map((type) => (
          <label key={type} className="flex items-center gap-3 text-sm text-muted-foreground">
            <input type="checkbox" className="size-4" checked={false} disabled readOnly />
            <span>
              {MESSAGE_TYPE_LABELS[type]} · never sent by SMS
            </span>
          </label>
        ))}
      </fieldset>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(save.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save allow list'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => setAllowed(new Set(settings.smsAllowedTypes))}
        >
          Discard
        </Button>
      </div>
    </form>
  );
}

// ---- Usage (§5.2) ----

const CHANNEL_LABELS: Record<UsageChannel, string> = {
  sms: 'SMS (billed parts)',
  whatsapp: 'WhatsApp',
  push: 'App notifications',
  email: 'Email',
};
const CHANNEL_ORDER: UsageChannel[] = ['sms', 'whatsapp', 'push', 'email'];

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (yearMonth: string) => monthFormat.format(new Date(`${yearMonth}-01T00:00:00Z`));
const countOf = (month: MessagingUsageDto['months'][number] | undefined, channel: UsageChannel) =>
  month?.byChannel.find((c) => c.channel === channel)?.count ?? 0;

function UsageCard() {
  const usage = useQuery({
    queryKey: messagingKeys.usage,
    queryFn: () => unwrap(messagingApi.GET('/api/v1/messaging/usage')),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Messages sent</CardTitle>
        <CardDescription>This month and last month. A long SMS is billed as several parts.</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={usage} loadingRows={4}>
          {(data) => {
            const [thisMonth, lastMonth] = data.months;
            const used = countOf(thisMonth, 'sms');
            return (
              <div className="grid gap-4">
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-4">Channel</TableHead>
                        <TableHead className="px-4 text-right">{thisMonth ? monthLabel(thisMonth.yearMonth) : 'This month'}</TableHead>
                        <TableHead className="px-4 text-right">{lastMonth ? monthLabel(lastMonth.yearMonth) : 'Last month'}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {CHANNEL_ORDER.map((channel) => (
                        <TableRow key={channel}>
                          <TableCell className="px-4">{CHANNEL_LABELS[channel]}</TableCell>
                          <TableCell className="px-4 text-right tabular-nums">{countOf(thisMonth, channel)}</TableCell>
                          <TableCell className="px-4 text-right tabular-nums">{countOf(lastMonth, channel)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="sms-cap">
                  <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">Monthly SMS limit</dt>
                    <dd className="tabular-nums">
                      {data.cap} <span className="text-muted-foreground">· set by the platform</span>
                    </dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">Used this month</dt>
                    <dd className="tabular-nums">{used}</dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">Remaining</dt>
                    <dd className="tabular-nums">{data.remaining}</dd>
                  </div>
                </dl>
                {data.remaining === 0 && (
                  <Alert>
                    <AlertDescription>
                      The SMS limit for this month is reached. Further SMS are held back until next month; WhatsApp and
                      the app keep working. Ask the platform to raise the limit if you need more.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            );
          }}
        </QueryStates>
      </CardContent>
    </Card>
  );
}

// ---- Test message (§5.1) ----

const TEST_CHANNELS: { channel: TestChannel; label: string }[] = [
  { channel: 'whatsapp', label: 'Send WhatsApp test' },
  { channel: 'sms', label: 'Send SMS test' },
  { channel: 'push', label: 'Send app test' },
];

function testErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    switch (error.code) {
      case ErrorCode.CONTACT_PHONE_MISSING:
        return 'Your staff record has no mobile number. Add one to your staff record first.';
      case ErrorCode.WHATSAPP_NUMBER_MISSING:
        return 'The school has no WhatsApp number connected. Connect one above first.';
      case ErrorCode.SMS_CAP_EXCEEDED: {
        const details = error.details as Partial<SmsCapExceeded> | null;
        return details?.cap !== undefined
          ? `The monthly SMS limit is reached (${details.used ?? details.cap} of ${details.cap}). A test would go over it.`
          : 'The monthly SMS limit is reached.';
      }
    }
  }
  return describeApiError(error);
}

function TestMessageCard() {
  const queryClient = useQueryClient();
  const [sent, setSent] = useState<{ channel: TestChannel; messageId: string } | null>(null);
  const test = useMutation({
    mutationFn: (channel: TestChannel) =>
      unwrap(messagingApi.POST('/api/v1/messaging/test', { body: { channel } })),
    onMutate: () => setSent(null),
    onSuccess: (result, channel) => {
      setSent({ channel, messageId: result.messageId });
      // A test counts against the SMS limit.
      void queryClient.invalidateQueries({ queryKey: messagingKeys.usage });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a test message</CardTitle>
        <CardDescription>
          Sent to you: by WhatsApp or SMS to the mobile number on your staff record, or to the app on your phone. An
          SMS test counts against the monthly limit.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          {TEST_CHANNELS.map(({ channel, label }) => (
            <Button
              key={channel}
              type="button"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate(channel)}
            >
              {test.isPending && test.variables === channel ? 'Sending…' : label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          A WhatsApp test that fails falls back to SMS. An app test reaches you only if you are signed in to the app;
          otherwise it is recorded as not sent.
        </p>
        {sent && (
          <Alert role="status">
            <AlertDescription>
              Test queued. Message reference <span className="font-mono">{sent.messageId}</span>.
            </AlertDescription>
          </Alert>
        )}
        {test.error && (
          <Alert variant="destructive">
            <AlertDescription>{testErrorMessage(test.error)}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
