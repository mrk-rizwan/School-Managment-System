import { BACKOFF_MS, backoff } from './backoff';
import { canDiscard, isDue, transition, type OutboxItem, type Outcome } from './machine';

// Every row of slice-15 §7.4 as a named test.

const T0 = new Date('2026-10-04T04:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function item(patch: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    naturalKey: null,
    body: '{"platform":"android","pushToken":"x"}',
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    sendingSince: null,
    responseStatus: null,
    responseCode: null,
    responseMessage: null,
    responseDetails: null,
    domainTable: null,
    domainId: null,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...patch,
  };
}

const response = (
  status: number,
  code: string | null = null,
  message: string | null = null,
  retryAfterSeconds: number | null = null,
): Outcome => ({
  kind: 'response',
  status,
  code,
  message,
  retryAfterSeconds,
});

function sending(patch: Partial<OutboxItem> = {}) {
  return transition(item(patch), { type: 'send', now: T0 }).item;
}

describe('pending → sending', () => {
  test('a due item in an idle lane is sent', () => {
    expect(isDue(item(), false, T0)).toBe(true);
    const next = sending();
    expect(next).toMatchObject({ state: 'sending', attempts: 1, sendingSince: T0.toISOString() });
  });

  test.each([
    ['the lane is busy', true, item()],
    ['next_attempt_at is in the future', false, item({ nextAttemptAt: at(1000).toISOString() })],
    ['the item is not pending', false, item({ state: 'failed' })],
  ])('not sent when %s', (_name, busy, candidate) => {
    expect(isDue(candidate, busy, T0)).toBe(false);
  });
});

describe('sending → done', () => {
  test.each([200, 201, 204])('%i: done, "saved on server" only now', (status) => {
    const { item: next, effects } = transition(sending(), {
      type: 'outcome',
      outcome: response(status),
      now: at(10),
    });
    expect(next.state).toBe('done');
    expect(next.responseStatus).toBe(status);
    expect(effects).toEqual(['saved_on_server']);
  });
});

describe('sending → pending, queue paused (401)', () => {
  test('401 gives the attempt back and pauses the queue', () => {
    const { item: next, effects } = transition(sending(), {
      type: 'outcome',
      outcome: response(401, 'AUTH_REQUIRED', 'Sign in again.'),
      now: at(10),
    });
    expect(next).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      sendingSince: null,
    });
    expect(effects).toEqual(['pause']);
  });

  test('a 401 to a replaced token (review L1): back to pending, attempt given back, no pause', () => {
    const { item: next, effects } = transition(sending(), {
      type: 'outcome',
      outcome: { kind: 'stale_token' },
      now: at(10),
    });
    expect(next).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      sendingSince: null,
    });
    expect(effects).toEqual([]);
  });
});

describe('sending → failed (terminal)', () => {
  test.each([
    [403, 'PERMISSION_DENIED', 'You do not have access.'],
    [404, 'NOT_FOUND', 'Not found.'],
    [409, 'STALE_STATUS', 'The register was changed by someone else.'],
    [422, 'VALIDATION_FAILED', 'The request is not valid.'],
  ])('%i is terminal with the server message', (status, code, message) => {
    const { item: next, effects } = transition(sending(), {
      type: 'outcome',
      outcome: response(status, code, message),
      now: at(10),
    });
    expect(next).toMatchObject({
      state: 'failed',
      responseStatus: status,
      responseCode: code,
      responseMessage: message,
    });
    expect(effects).toEqual([]);
  });
});

describe('sending → pending, queue blocked (426)', () => {
  test('426 gives the attempt back and blocks the queue', () => {
    const { item: next, effects } = transition(sending(), {
      type: 'outcome',
      outcome: response(426, 'UPGRADE_REQUIRED', 'Update the app.'),
      now: at(10),
    });
    expect(next).toMatchObject({ state: 'pending', attempts: 0, nextAttemptAt: null });
    expect(effects).toEqual(['block']);
  });
});

describe('sending → pending (429)', () => {
  test('with Retry-After: next attempt after that many seconds', () => {
    const { item: next } = transition(sending(), {
      type: 'outcome',
      outcome: response(429, 'RATE_LIMITED', 'Slow down', 17),
      now: T0,
    });
    expect(next).toMatchObject({ state: 'pending', nextAttemptAt: at(17_000).toISOString() });
  });

  test('without Retry-After: 60 seconds', () => {
    const { item: next } = transition(sending(), {
      type: 'outcome',
      outcome: response(429),
      now: T0,
    });
    expect(next.nextAttemptAt).toBe(at(60_000).toISOString());
  });
});

describe('sending → pending with backoff (network, timeout, 5xx)', () => {
  test('the schedule is 5 s, 30 s, 2 min, 10 min, 30 min, then every 30 min — no give-up', () => {
    expect(BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000]);
    let current = item();
    const waits: number[] = [];
    let now = T0;
    for (let i = 0; i < 8; i++) {
      current = transition(current, { type: 'send', now }).item;
      current = transition(current, { type: 'outcome', outcome: { kind: 'network' }, now }).item;
      expect(current.state).toBe('pending');
      const wait = Date.parse(current.nextAttemptAt!) - now.getTime();
      waits.push(wait);
      now = new Date(Date.parse(current.nextAttemptAt!));
    }
    expect(waits).toEqual([
      5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
    expect(current.attempts).toBe(8);
  });

  test.each([500, 502, 503])('%i retries with backoff', (status) => {
    const { item: next } = transition(sending(), {
      type: 'outcome',
      outcome: response(status),
      now: T0,
    });
    expect(next).toMatchObject({
      state: 'pending',
      nextAttemptAt: at(backoff(1)).toISOString(),
      responseStatus: status,
    });
  });

  test('backoff of the first attempt is 5 s under fake timers too', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(T0);
      const { item: next } = transition(sending(), {
        type: 'outcome',
        outcome: { kind: 'network' },
        now: new Date(),
      });
      jest.advanceTimersByTime(5_000);
      expect(Date.parse(next.nextAttemptAt!)).toBeLessThanOrEqual(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('crash recovery', () => {
  test('a sending row older than 60 s is pending again on restart', () => {
    const stale = sending();
    const { item: next } = transition(stale, { type: 'recover', now: at(61_000) });
    expect(next).toMatchObject({ state: 'pending', sendingSince: null, nextAttemptAt: null });
  });

  test('a sending row younger than 60 s is left alone', () => {
    const fresh = sending();
    expect(transition(fresh, { type: 'recover', now: at(30_000) }).item).toBe(fresh);
  });

  test('recover ignores other states', () => {
    const pending = item();
    expect(transition(pending, { type: 'recover', now: at(120_000) }).item).toBe(pending);
  });
});

describe('discard and remedy', () => {
  test('discard is offered on pending and failed, never on sending or done', () => {
    expect(canDiscard(item({ state: 'pending' }))).toBe(true);
    expect(canDiscard(item({ state: 'failed' }))).toBe(true);
    expect(canDiscard(item({ state: 'sending' }))).toBe(false);
    expect(canDiscard(item({ state: 'done' }))).toBe(false);
  });
});

describe('illegal transitions', () => {
  test('only pending items are sent and only sending items take an outcome', () => {
    expect(() => transition(item({ state: 'done' }), { type: 'send', now: T0 })).toThrow();
    expect(() =>
      transition(item(), { type: 'outcome', outcome: response(200), now: T0 }),
    ).toThrow();
  });
});
