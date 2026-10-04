import { backoff } from './backoff';

// The outbox state machine (slice-15 §7.4, R157), pure: (item, event) -> (item', effects). No I/O,
// no clock — the event carries `now`. Every row of the §7.4 table has a named test.

export type OutboxState = 'pending' | 'sending' | 'done' | 'failed';

export type OutboxItem = {
  /** newIdempotencyKey(); also the Idempotency-Key on header lanes. */
  id: string;
  lane: string;
  method: string;
  path: string;
  naturalKey: string | null;
  body: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string | null;
  sendingSince: string | null;
  responseStatus: number | null;
  responseCode: string | null;
  responseMessage: string | null;
  domainTable: string | null;
  domainId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What came back from one send. */
export type Outcome =
  | {
      kind: 'response';
      status: number;
      code: string | null;
      message: string | null;
      retryAfterSeconds: number | null;
    }
  | { kind: 'network' }
  /** A 401 to a token the app no longer holds (replaced mid-flight): not this session's loss. */
  | { kind: 'stale_token' };

export type MachineEvent =
  | { type: 'send'; now: Date }
  | { type: 'outcome'; outcome: Outcome; now: Date }
  /** App start: a `sending` row older than STALE_SENDING_MS is sent again (every lane is idempotent). */
  | { type: 'recover'; now: Date };

/** Queue-level consequences; item state never carries them. */
export type Effect = 'pause' | 'block' | 'saved_on_server';

export type QueueFlags = { online: boolean; paused: boolean; blocked: boolean };

export const STALE_SENDING_MS = 60_000;
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Terminal statuses: a bad body, a missing row, a refusal or a conflict never heals by retrying. */
export const TERMINAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422]);

/** pending -> sending is allowed: the lane is idle, the queue runs and the item is due. */
export function isDue(item: OutboxItem, flags: QueueFlags, laneBusy: boolean, now: Date): boolean {
  return (
    item.state === 'pending' &&
    !laneBusy &&
    flags.online &&
    !flags.paused &&
    !flags.blocked &&
    (item.nextAttemptAt === null || Date.parse(item.nextAttemptAt) <= now.getTime())
  );
}

const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

function back(item: OutboxItem, now: Date, patch: Partial<OutboxItem>): OutboxItem {
  return { ...item, state: 'pending', sendingSince: null, updatedAt: now.toISOString(), ...patch };
}

export function transition(
  item: OutboxItem,
  event: MachineEvent,
): { item: OutboxItem; effects: Effect[] } {
  const now = event.now;
  const stamp = now.toISOString();

  if (event.type === 'send') {
    if (item.state !== 'pending') throw new Error(`cannot send an item in state ${item.state}`);
    return {
      item: {
        ...item,
        state: 'sending',
        attempts: item.attempts + 1,
        sendingSince: stamp,
        updatedAt: stamp,
      },
      effects: [],
    };
  }

  if (event.type === 'recover') {
    const stale =
      item.state === 'sending' &&
      (item.sendingSince === null ||
        now.getTime() - Date.parse(item.sendingSince) > STALE_SENDING_MS);
    return { item: stale ? back(item, now, { nextAttemptAt: null }) : item, effects: [] };
  }

  if (item.state !== 'sending') throw new Error(`an outcome for an item in state ${item.state}`);
  const { outcome } = event;

  if (outcome.kind === 'stale_token') {
    // Back to pending at once with the attempt given back; the queue is not paused (review L1).
    return {
      item: back(item, now, { attempts: item.attempts - 1, nextAttemptAt: null }),
      effects: [],
    };
  }

  if (outcome.kind === 'network') {
    return {
      item: back(item, now, { nextAttemptAt: later(now, backoff(item.attempts)) }),
      effects: [],
    };
  }

  const status = outcome.status;
  const recorded = {
    responseStatus: status,
    responseCode: outcome.code,
    responseMessage: outcome.message,
  };

  if (status >= 200 && status < 300) {
    return {
      item: {
        ...item,
        ...recorded,
        state: 'done',
        sendingSince: null,
        nextAttemptAt: null,
        updatedAt: stamp,
      },
      effects: ['saved_on_server'],
    };
  }
  if (status === 401) {
    // Not the item's fault: attempts are given back, and the queue waits for sign-in.
    return {
      item: back(item, now, { ...recorded, attempts: item.attempts - 1, nextAttemptAt: null }),
      effects: ['pause'],
    };
  }
  if (status === 426) {
    return {
      item: back(item, now, { ...recorded, attempts: item.attempts - 1, nextAttemptAt: null }),
      effects: ['block'],
    };
  }
  if (TERMINAL_STATUSES.has(status)) {
    return {
      item: {
        ...item,
        ...recorded,
        state: 'failed',
        sendingSince: null,
        nextAttemptAt: null,
        updatedAt: stamp,
      },
      effects: [],
    };
  }
  if (status === 429) {
    const wait = (outcome.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000;
    return { item: back(item, now, { ...recorded, nextAttemptAt: later(now, wait) }), effects: [] };
  }
  // 5xx and anything unexpected: retry with backoff, never give up.
  return {
    item: back(item, now, { ...recorded, nextAttemptAt: later(now, backoff(item.attempts)) }),
    effects: [],
  };
}

/** "Discard" is offered on pending and failed items (a sending one is in flight). */
export function canDiscard(item: OutboxItem): boolean {
  return item.state === 'pending' || item.state === 'failed';
}

/**
 * A lane's remedy on a failed item: a NEW pending row (the failed row stays until its 7-day
 * purge). `body` replaces the body when the remedy changes it (a register's added reason).
 */
export function remedyItem(
  failed: OutboxItem,
  id: string,
  now: Date,
  body: string = failed.body,
): OutboxItem {
  if (failed.state !== 'failed') throw new Error('a remedy applies to a failed item only');
  const stamp = now.toISOString();
  return {
    ...failed,
    id,
    body,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    sendingSince: null,
    responseStatus: null,
    responseCode: null,
    responseMessage: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
