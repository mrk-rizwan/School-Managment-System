import type { OutboxItem, Outcome } from './machine';
import { OutboxWorker, type WorkerStore } from './worker';

// slice-15 §7.3–§7.5, R158: lanes are independent; one in flight per lane; triggers tick once.

const T0 = new Date('2026-10-04T04:00:00.000Z');
let seq = 0;

function item(lane: string, patch: Partial<OutboxItem> = {}): OutboxItem {
  seq += 1;
  const created = new Date(T0.getTime() + seq).toISOString();
  return {
    id: `id-${seq}`,
    lane,
    method: 'POST',
    path: `/api/v1/${lane}`,
    naturalKey: null,
    body: '{}',
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    sendingSince: null,
    responseStatus: null,
    responseCode: null,
    responseMessage: null,
    domainTable: null,
    domainId: null,
    createdAt: created,
    updatedAt: created,
    ...patch,
  };
}

/** The worker's store over an array, so these tests need no database. */
function memoryStore(items: OutboxItem[]): WorkerStore & { items: OutboxItem[]; scans: number } {
  const store = {
    items,
    scans: 0,
    listDue(now: Date) {
      store.scans += 1;
      return Promise.resolve(
        store.items
          .filter(
            (i) =>
              i.state === 'pending' &&
              (i.nextAttemptAt === null || Date.parse(i.nextAttemptAt) <= now.getTime()),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },
    saveItem(next: OutboxItem) {
      store.items = store.items.map((i) => (i.id === next.id ? next : i));
      return Promise.resolve();
    },
    earliestAttempt() {
      const times = store.items
        .filter((i) => i.state === 'pending' && i.nextAttemptAt)
        .map((i) => i.nextAttemptAt!);
      return Promise.resolve(times.sort()[0] ?? null);
    },
  };
  return store;
}

const ok: Outcome = {
  kind: 'response',
  status: 201,
  code: null,
  message: null,
  retryAfterSeconds: null,
};

describe('lanes are independent', () => {
  test('a failing diary_attachment item never delays submit_register', async () => {
    const photo = item('diary_attachment');
    const register = item('submit_register');
    const store = memoryStore([photo, register]);
    const sent: string[] = [];
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      now: () => T0,
      send: (i) => {
        sent.push(i.lane);
        return Promise.resolve(i.lane === 'diary_attachment' ? { kind: 'network' } : ok);
      },
    });
    await worker.trigger('foreground');
    await worker.idle();
    expect(sent).toEqual(expect.arrayContaining(['diary_attachment', 'submit_register']));
    expect(store.items.find((i) => i.id === register.id)!.state).toBe('done');
    expect(store.items.find((i) => i.id === photo.id)!.state).toBe('pending');
    worker.stop();
  });

  test('a terminal failure never stops its own lane: the next item goes', async () => {
    const first = item('remark');
    const second = item('remark');
    const store = memoryStore([first, second]);
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      now: () => T0,
      send: (i) =>
        Promise.resolve(
          i.id === first.id
            ? {
                kind: 'response',
                status: 409,
                code: 'X',
                message: 'Refused',
                retryAfterSeconds: null,
              }
            : ok,
        ),
    });
    await worker.trigger('foreground');
    await worker.idle();
    expect(store.items.map((i) => i.state)).toEqual(['failed', 'done']);
  });
});

describe('one in flight per lane, at most three lanes', () => {
  test('within a lane, oldest first and never two at once; across lanes, concurrent up to three', async () => {
    const items = [item('a'), item('a'), item('b'), item('c'), item('d')];
    const store = memoryStore(items);
    let inFlight = 0;
    let maxInFlight = 0;
    const perLane = new Map<string, number>();
    const order: string[] = [];
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      now: () => T0,
      send: async (i) => {
        inFlight += 1;
        perLane.set(i.lane, (perLane.get(i.lane) ?? 0) + 1);
        expect(perLane.get(i.lane)).toBe(1);
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(i.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        perLane.set(i.lane, perLane.get(i.lane)! - 1);
        return ok;
      },
    });
    await worker.trigger('foreground');
    await worker.idle();
    expect(store.items.every((i) => i.state === 'done')).toBe(true);
    expect(maxInFlight).toBe(3);
    expect(order.indexOf(items[0]!.id)).toBeLessThan(order.indexOf(items[1]!.id));
  });
});

describe('triggers', () => {
  test.each(['foreground', 'online', 'sign_in'] as const)(
    '%s causes exactly one tick',
    async (reason) => {
      const store = memoryStore([]);
      const worker = new OutboxWorker({
        store,
        isOnline: () => true,
        send: () => Promise.resolve(ok),
      });
      await worker.trigger(reason);
      await worker.idle();
      expect(worker.ticks).toBe(1);
      expect(store.scans).toBe(1);
    },
  );

  test('offline, paused or blocked: a tick sends nothing', async () => {
    const store = memoryStore([item('a')]);
    let online = false;
    const send = jest.fn(() => Promise.resolve(ok));
    const worker = new OutboxWorker({ store, isOnline: () => online, send });
    await worker.trigger('foreground');
    online = true;
    worker.pause();
    await worker.trigger('online');
    worker.resume();
    worker.block();
    await worker.trigger('online');
    await worker.idle();
    expect(send).not.toHaveBeenCalled();
    worker.resume();
    await worker.trigger('online');
    await worker.idle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('401 pauses the queue and 426 blocks it', async () => {
    const effects: string[] = [];
    const store = memoryStore([item('a'), item('b')]);
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      now: () => T0,
      onEffect: (effect) => effects.push(effect),
      send: (i) =>
        Promise.resolve({
          kind: 'response',
          status: i.lane === 'a' ? 401 : 426,
          code: null,
          message: null,
          retryAfterSeconds: null,
        } as Outcome),
    });
    await worker.trigger('foreground');
    await worker.idle();
    expect(effects.sort()).toEqual(['block', 'pause']);
    expect(worker.status()).toMatchObject({ paused: true, blocked: true });
    expect(store.items.every((i) => i.state === 'pending')).toBe(true);
  });

  test('a backed-off item is retried by the foreground timer', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(T0);
      const store = memoryStore([item('a')]);
      let calls = 0;
      const worker = new OutboxWorker({
        store,
        isOnline: () => true,
        send: () => Promise.resolve(++calls === 1 ? { kind: 'network' } : ok),
      });
      await worker.trigger('foreground');
      await worker.idle();
      expect(store.items[0]!.state).toBe('pending');
      await jest.advanceTimersByTimeAsync(5_000);
      await worker.idle();
      expect(store.items[0]!.state).toBe('done');
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the saved-on-server follow-up runs only after a 2xx', async () => {
    const saved: string[] = [];
    const store = memoryStore([item('device_register')]);
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      send: () => Promise.resolve(ok),
      onSaved: (i) => {
        saved.push(i.state);
      },
    });
    await worker.trigger('sign_in');
    await worker.idle();
    expect(saved).toEqual(['done']);
  });
});
