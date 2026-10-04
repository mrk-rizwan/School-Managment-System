import { toApiError } from '@asms/shared';
import { useCallback, useEffect, useState } from 'react';
import { currentBearerToken, sendRaw } from '../api/client';
import * as outbox from '../db/outbox.repository';
import { isOnline } from '../net/connectivity';
import { onDeviceRegistered } from '../push/registration';
import { laneOf } from './lanes';
import { transition, type OutboxItem, type Outcome } from './machine';
import { OutboxWorker, type QueueStatus } from './worker';

// The app's one outbox worker, wired to the real client, store and connectivity.

/** One send: the stored request through the shared client, the response reduced to an Outcome. */
export async function sendItem(item: OutboxItem): Promise<Outcome> {
  const lane = laneOf(item.lane);
  const headers: Record<string, string> = lane?.idempotencyHeader
    ? { 'Idempotency-Key': item.id }
    : {};
  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendRaw(item.method, item.path, item.body, headers);
  } catch {
    return { kind: 'network' };
  }
  // A 401 to a token since replaced (or already dropped by a loss): the item waits, unblamed.
  // A 401 to no token at all is the ordinary pause.
  if (response.status === 401 && sentWith !== null && sentWith !== currentBearerToken()) {
    return { kind: 'stale_token' };
  }
  if (response.ok)
    return {
      kind: 'response',
      status: response.status,
      code: null,
      message: null,
      retryAfterSeconds: null,
    };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = toApiError(response, body);
  return {
    kind: 'response',
    status: response.status,
    code: error.code,
    message: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

export const outboxWorker = new OutboxWorker({
  store: outbox,
  send: sendItem,
  isOnline,
  onSaved: onDeviceRegistered,
});

/** App start: a `sending` row left by a crash is sent again (every lane is idempotent). */
export async function recoverStaleItems(now: Date = new Date()): Promise<void> {
  for (const item of await outbox.listByState('sending')) {
    const recovered = transition(item, { type: 'recover', now }).item;
    if (recovered !== item) await outbox.saveItem(recovered);
  }
}

/** The sync sheet's view: unfinished items and the queue flags, refreshed on every change. */
export function useOutbox(): {
  items: OutboxItem[];
  status: QueueStatus;
  /** When the list was read (ms): the sheet computes "retrying in" from it. */
  refreshedAt: number;
  refresh: () => void;
} {
  const [view, setView] = useState({
    items: [] as OutboxItem[],
    status: outboxWorker.status(),
    refreshedAt: 0,
  });
  const refresh = useCallback(() => {
    void outbox
      .listUnfinished()
      .catch(() => [] as OutboxItem[])
      .then((items) => setView({ items, status: outboxWorker.status(), refreshedAt: Date.now() }));
  }, []);
  useEffect(() => {
    refresh();
    return outboxWorker.subscribe(refresh);
  }, [refresh]);
  return { ...view, refresh };
}
