import { formatDateTime } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap, unwrapWithDate } from '../api/client';
import type { AnnouncementDto, DeliverySummaryDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, NoDataState, OfflineNotice } from '../ui/states';
import { colors, fontSize } from '../ui/theme';
import {
  audienceLabel,
  deliveryLines,
  SEND_FAILED_TEXT,
  sendFailure,
  SENDING_REFRESH_MS,
  statusWord,
} from './announce-model';

// One announcement — /announce/[id] (slice-16 §7.2): its fields and, once sent, the delivery
// summary per channel as accepted / delivered / failed / suppressed (R150). A draft is sent from
// here (online only). Audience names are classes and sections, never a child: not secure.

export function AnnouncementScreen({ id }: { id: string }) {
  const client = useQueryClient();
  const online = useOnline();
  const sendGate = useOnlineOnly('send_announcement');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const one = useCachedQuery<AnnouncementDto>(
    queryKeys.announcement(id),
    `/api/v1/announcements/${id}`,
    {},
    () =>
      unwrapWithDate(api.GET('/api/v1/announcements/{id}', { params: { path: { id } } })),
  );
  // `sending` is a send that succeeded and is being delivered: its counts are already live.
  const status = one.data?.body.status;
  const sent = status === 'sent' || status === 'sending';
  const delivery = useCachedQuery<DeliverySummaryDto>(
    queryKeys.delivery(id),
    `/api/v1/announcements/${id}/delivery`,
    {},
    () =>
      unwrapWithDate(
        api.GET('/api/v1/announcements/{id}/delivery', { params: { path: { id } } }),
      ),
    { enabled: sent, staleTime: 0 },
  );

  // While delivery runs, fetch the announcement (and its delivery) again every 3 s while this
  // screen is open, as the web does; stop when it leaves `sending` or the screen closes. A timer
  // here, not a query refetchInterval (lint, R160: no polling outside an open screen).
  const { refetch } = one;
  const refetchDelivery = delivery.refetch;
  useEffect(() => {
    if (status !== 'sending' || !online) return undefined;
    const timer = setInterval(() => {
      void refetch();
      void refetchDelivery();
    }, SENDING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [status, online, refetch, refetchDelivery]);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await unwrap(
        api.POST('/api/v1/announcements/{id}/send', { params: { path: { id } } }),
      );
      // Send-now answers `sending` (a job delivers it); the page shows it at once.
      client.setQueryData(queryKeys.announcement(id), { ...one.data!, body: result });
      await client.invalidateQueries({ queryKey: ['announcements'] });
    } catch (error) {
      setMessage(sendFailure(error, true).message);
    } finally {
      setBusy(false);
    }
  }

  const cached = one.data;
  if (cached === undefined) {
    return (
      <Screen title="Announcement" testID="announcement.screen">
        <NoDataState
          isError={one.isError}
          error={one.error}
          onRetry={() => void one.refetch()}
          offlineMessage="This announcement is not on this phone yet."
        />
      </Screen>
    );
  }
  const a = cached.body;
  return (
    <Screen
      title={a.title}
      testID="announcement.screen"
      banner={
        !online || one.isError ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
      footer={
        a.status === 'draft' ? (
          <>
            {a.sendFailedAt !== null ? (
              <Text style={styles.error} testID="announcement.sendFailed">
                {SEND_FAILED_TEXT}
              </Text>
            ) : null}
            {message ? <Text style={styles.error}>{message}</Text> : null}
            {sendGate.reason ? <Text style={styles.note}>{sendGate.reason}</Text> : null}
            <Button
              label="Send"
              disabled={!sendGate.enabled}
              busy={busy}
              onPress={() => void send()}
              testID="announcement.send"
            />
          </>
        ) : null
      }
    >
      <Text style={styles.caption} testID="announcement.status">
        {statusWord(a)}
        {a.sentAt ? ` · ${formatDateTime(a.sentAt)}` : ''}
        {a.priority === 'urgent' ? ' · Urgent' : ''}
      </Text>
      <Text selectable style={styles.body}>
        {a.body}
      </Text>
      <Text style={styles.caption}>
        To: {a.audiences.map(audienceLabel).join(', ')}
      </Text>
      <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
      {sent ? (
        <Sheet title="Delivery" testID="announcement.delivery">
          {delivery.data === undefined ? (
            <NoDataState
              isError={delivery.isError}
              error={delivery.error}
              onRetry={() => void delivery.refetch()}
              offlineMessage="The delivery summary needs a connection."
            />
          ) : (
            <>
              <Text style={styles.body}>{`${delivery.data.body.recipients.total} people`}</Text>
              {deliveryLines(delivery.data.body).map((line) => (
                <Text key={line} style={styles.caption}>
                  {line}
                </Text>
              ))}
            </>
          )}
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
