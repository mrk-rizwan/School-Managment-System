import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import {
  discardItem,
  discardWaitingAttachment,
  listWaitingAttachments,
  type LocalAttachment,
} from '../../../db/local.repository';
import { makeAllDue } from '../../../db/outbox.repository';
import { useOnline } from '../../../net/connectivity';
import { laneOf, remedyFor } from '../../../outbox/lanes';
import { canDiscard, type OutboxItem } from '../../../outbox/machine';
import { outboxWorker, useOutbox } from '../../../outbox/runtime';
import { Button } from '../../../ui/Button';
import { ListRow } from '../../../ui/ListRow';
import { Screen } from '../../../ui/Screen';
import { Sheet } from '../../../ui/Sheet';
import { EmptyState, formatAsOf } from '../../../ui/states';
import { colors, fontSize } from '../../../ui/theme';

// The sync status sheet (slice-15 §7.7): every item not yet on the server, by lane, with the
// server's reason for anything refused. Nothing gets a tick before the server's 2xx (R157).

/** Where a failed item's own remedy is offered (slice-16 §9): the screen that shows the row. */
const REMEDY_HINT: Record<string, string> = {
  add_reason: 'Open the register to add a reason and resend.',
  reload: 'Open the register to reload and save again.',
  open_existing: 'Open the diary to open the existing entry.',
  edit_resend: 'Open it to edit and resend.',
  retry: 'Open the diary to try again.',
};

function describe(item: OutboxItem, now: number): { title: string; detail: string | null } {
  if (item.state === 'sending') return { title: 'Sending', detail: null };
  if (item.state === 'failed')
    return {
      title: `Not saved: ${item.responseMessage ?? 'refused'}`,
      detail: REMEDY_HINT[remedyFor(item.lane, item.responseCode)] ?? null,
    };
  const due = item.nextAttemptAt === null ? 0 : Date.parse(item.nextAttemptAt) - now;
  const retry = due > 0 ? `Retrying in ${Math.ceil(due / 60_000)} min` : null;
  return { title: 'Saved on device', detail: retry };
}

export default function SyncScreen() {
  const online = useOnline();
  const { items, status, refresh: refreshItems, refreshedAt: now } = useOutbox();
  const lanes = [...new Set(items.map((item) => item.lane))];
  // Photos waiting for their diary entry have no outbox row yet (slice-16 §4.5).
  const [waiting, setWaiting] = useState<LocalAttachment[]>([]);
  const refresh = useCallback(() => {
    refreshItems();
    void listWaitingAttachments().then(setWaiting, () => setWaiting([]));
  }, [refreshItems]);
  useEffect(() => {
    void listWaitingAttachments().then(setWaiting, () => setWaiting([]));
  }, [items]);

  const flag = status.blocked
    ? 'Update the app to continue.'
    : status.paused
      ? 'Paused — sign in to continue.'
      : !online
        ? 'Offline. Items are sent when the connection returns.'
        : null;

  function discard(item: OutboxItem) {
    Alert.alert('Discard this item?', 'It has not reached the school and will be lost.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        // The item's local row (and a photo's file) go with it.
        onPress: () => void discardItem(item.id).then(refresh),
      },
    ]);
  }

  async function retryNow() {
    await makeAllDue();
    await outboxWorker.trigger('retry_now');
    refresh();
  }

  return (
    <Screen testID="sync.screen">
      {flag ? (
        <Text style={styles.flag} testID="sync.flag">
          {flag}
        </Text>
      ) : null}
      {waiting.length > 0 ? (
        <Sheet title="Diary photo" testID="sync.waiting">
          {waiting.map((photo) => (
            <ListRow
              key={photo.id}
              title="Waiting for its diary entry"
              value="Discard"
              onPress={() =>
                Alert.alert(
                  'Discard this photo?',
                  'It has not reached the school and will be lost.',
                  [
                    { text: 'Keep', style: 'cancel' },
                    {
                      text: 'Discard',
                      style: 'destructive',
                      onPress: () => void discardWaitingAttachment(photo.id).then(refresh),
                    },
                  ],
                )
              }
              testID="sync.item.waiting"
            />
          ))}
        </Sheet>
      ) : null}
      {items.length === 0 && waiting.length === 0 ? (
        <EmptyState title="Everything is on the server" />
      ) : (
        lanes.map((lane) => (
          <Sheet key={lane} title={laneOf(lane)?.label ?? lane} testID={`sync.lane.${lane}`}>
            {items
              .filter((item) => item.lane === lane)
              .map((item) => {
                const { title, detail } = describe(item, now);
                return (
                  <ListRow
                    key={item.id}
                    title={title}
                    detail={[detail, `Created ${formatAsOf(item.createdAt).replace('as of ', '')}`]
                      .filter(Boolean)
                      .join(' · ')}
                    destructive={item.state === 'failed'}
                    value={canDiscard(item) ? 'Discard' : null}
                    onPress={canDiscard(item) ? () => discard(item) : undefined}
                    testID={`sync.item.${item.state}`}
                  />
                );
              })}
          </Sheet>
        ))
      )}
      <Button
        label="Retry now"
        variant="secondary"
        onPress={() => void retryNow()}
        disabled={items.length === 0}
        testID="sync.retryNow"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flag: { fontSize: fontSize.small, color: colors.foreground },
});
