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
    responseDetails: null,
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

describe('slice-16 §10.4', () => {
  test('a photo stuck in a 30-second upload never delays a register queued after it', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const photo = item('diary_attachment');
      const register = item('submit_register');
      const store = memoryStore([photo, register]);
      const finished: string[] = [];
      const worker = new OutboxWorker({
        store,
        isOnline: () => true,
        now: () => T0,
        send: (i) =>
          i.lane === 'diary_attachment'
            ? new Promise((resolve) => setTimeout(() => resolve(ok), 30_000))
            : Promise.resolve(ok),
        onSaved: (i) => {
          finished.push(i.lane);
        },
      });
      void worker.trigger('enqueued');
      // The register is done while the photo is still uploading.
      for (let i = 0; i < 20 && !finished.includes('submit_register'); i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toEqual(['submit_register']);
      expect(store.items.find((i) => i.id === photo.id)!.state).toBe('sending');
      jest.advanceTimersByTime(30_000);
      await worker.idle();
      expect(finished).toEqual(['submit_register', 'diary_attachment']);
      worker.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a register refused for good does not stop the next register in the lane', async () => {
    const first = item('submit_register');
    const second = item('submit_register');
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
                code: 'ATTENDANCE_LOCKED',
                message: 'Locked',
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

  // Wave G audit L1: a 401 or 426 from a send in flight lands while the scan reads the store.
  test.each(['pause', 'block'] as const)(
    'a %s raised while the store is read stops that scan from sending',
    async (stop) => {
      const store = memoryStore([item('a'), item('b')]);
      const read = store.listDue.bind(store);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      store.listDue = async (now: Date) => {
        const due = await read(now);
        await gate;
        return due;
      };
      const send = jest.fn(() => Promise.resolve(ok));
      const worker = new OutboxWorker({ store, isOnline: () => true, now: () => T0, send });
      const ticking = worker.trigger('foreground');
      await Promise.resolve();
      worker[stop]();
      release();
      await ticking;
      await worker.idle();
      expect(send).not.toHaveBeenCalled();
      expect(store.items.every((i) => i.state === 'pending')).toBe(true);
    },
  );

  test('enqueued tells the views offline too; a plain offline tick does not', async () => {
    const worker = new OutboxWorker({
      store: memoryStore([item('a')]),
      isOnline: () => false,
      send: () => Promise.resolve(ok),
    });
    const heard = jest.fn();
    worker.subscribe(heard);
    await worker.trigger('online');
    expect(heard).not.toHaveBeenCalled();
    await worker.trigger('enqueued');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  test('401 pauses the queue and 426 blocks it', async () => {
    const store = memoryStore([item('a'), item('b')]);
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      now: () => T0,
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

  test('a send that throws a network error is retried; any other throw fails the item, once', async () => {
    const offline = item('offline');
    const broken = item('broken');
    const store = memoryStore([offline, broken]);
    let brokenCalls = 0;
    const worker = new OutboxWorker({
      store,
      isOnline: () => true,
      send: (i) => {
        if (i.lane === 'offline') return Promise.reject(new TypeError('Network request failed'));
        brokenCalls += 1;
        return Promise.reject(new Error('Unsupported FormDataPart implementation'));
      },
    });
    await worker.trigger('foreground');
    await worker.idle();
    const [a, b] = store.items;
    expect(a).toMatchObject({ state: 'pending', responseStatus: null });
    expect(a!.nextAttemptAt).not.toBeNull();
    expect(b).toMatchObject({
      state: 'failed',
      responseStatus: 422,
      responseCode: 'SEND_FAILED_ON_PHONE',
      nextAttemptAt: null,
    });
    await worker.trigger('retry_now');
    await worker.idle();
    expect(brokenCalls).toBe(1);
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
