import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { MAX_CONCURRENT_LANES } from './lanes';
import { isDue, transition, type Effect, type OutboxItem, type Outcome } from './machine';

// The outbox runner (slice-15 §7.4, §7.5, R157, R158). It picks the oldest due item of every idle
// lane, at most three lanes at once, sends it, and applies the pure machine's transition. Lanes
// never wait on each other: a failing photo never delays a register.
//
// Triggers: app foreground, connectivity online, a successful sign-in, each finished item, and a
// timer for the earliest next attempt — only while the app is in the foreground. No background
// task and no push-triggered sync (data cost).

export type TickReason =
  'foreground' | 'online' | 'sign_in' | 'finished' | 'timer' | 'enqueued' | 'retry_now';

export type WorkerStore = {
  listDue(now: Date): Promise<OutboxItem[]>;
  saveItem(item: OutboxItem): Promise<void>;
  earliestAttempt(): Promise<string | null>;
};

export type WorkerDeps = {
  store: WorkerStore;
  send(item: OutboxItem): Promise<Outcome>;
  isOnline(): boolean;
  now?: () => Date;
  /** After the server's 2xx: the lane's follow-up (device_register stores the push token). */
  onSaved?: (item: OutboxItem) => Promise<void> | void;
  /** Queue-level effects: 'pause' on 401, 'block' on 426. */
  onEffect?: (effect: Effect, item: OutboxItem) => void;
};

export type QueueStatus = { paused: boolean; blocked: boolean; running: boolean };

export class OutboxWorker {
  private paused = false;
  private blocked = false;
  private foreground = true;
  private readonly busyLanes = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private ticking: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  /** How many scans of the queue have run; tests count ticks with it. */
  ticks = 0;

  constructor(private readonly deps: WorkerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  status(): QueueStatus {
    return { paused: this.paused, blocked: this.blocked, running: this.busyLanes.size > 0 };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 401: wait for sign-in. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
    this.notify();
  }

  /** 426: nothing sends until a request succeeds. */
  block(): void {
    this.blocked = true;
    this.clearTimer();
    this.notify();
  }

  /** A request succeeded past the version floor. */
  unblock(): void {
    this.blocked = false;
    this.notify();
  }

  /** A signed-in, up-to-date session: the queue may run. */
  resume(): void {
    this.paused = false;
    this.blocked = false;
    this.notify();
  }

  /** App to background: no timers; foreground triggers a tick. */
  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground) this.clearTimer();
  }

  /** Stops timers and forgets nothing on disk; used on sign-out and wipe. */
  stop(): void {
    this.paused = true;
    this.clearTimer();
  }

  trigger(reason: TickReason): Promise<void> {
    log('debug', 'outbox.tick', { reason });
    return this.tick();
  }

  /** Resolves when no scan and no send is in progress. */
  async idle(): Promise<void> {
    while (this.ticking !== null || this.inFlight.size > 0) {
      await Promise.all([this.ticking, ...this.inFlight]);
    }
  }

  private tick(): Promise<void> {
    if (this.ticking !== null) {
      this.again = true;
      return this.ticking;
    }
    const run = (async () => {
      do {
        this.again = false;
        await this.scan();
      } while (this.again);
    })();
    this.ticking = run.finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async scan(): Promise<void> {
    this.ticks += 1;
    if (this.paused || this.blocked || !this.deps.isOnline()) return;
    const now = this.now();
    let due: OutboxItem[];
    try {
      due = await this.deps.store.listDue(now);
    } catch (error) {
      log('warn', 'outbox.scan_failed', errorFields(error));
      return;
    }
    const flags = { online: true, paused: this.paused, blocked: this.blocked };
    for (const item of due) {
      if (this.busyLanes.size >= MAX_CONCURRENT_LANES) break;
      if (!isDue(item, flags, this.busyLanes.has(item.lane), now)) continue;
      this.busyLanes.add(item.lane);
      const job = this.process(item).finally(() => {
        this.inFlight.delete(job);
      });
      this.inFlight.add(job);
    }
    await this.schedule();
  }

  private async process(item: OutboxItem): Promise<void> {
    let finished: OutboxItem | null = null;
    try {
      const sending = transition(item, { type: 'send', now: this.now() }).item;
      await this.deps.store.saveItem(sending);
      this.notify();
      let outcome: Outcome;
      try {
        outcome = await this.deps.send(sending);
      } catch {
        outcome = { kind: 'network' };
      }
      const { item: next, effects } = transition(sending, {
        type: 'outcome',
        outcome,
        now: this.now(),
      });
      await this.deps.store.saveItem(next);
      finished = next;
      log('info', 'outbox.item', {
        lane: next.lane,
        state: next.state,
        status: next.responseStatus,
      });
      for (const effect of effects) {
        if (effect === 'pause') this.pause();
        if (effect === 'block') this.block();
        if (effect === 'saved_on_server') await this.deps.onSaved?.(next);
        this.deps.onEffect?.(effect, next);
      }
    } catch (error) {
      log('warn', 'outbox.process_failed', errorFields(error));
    } finally {
      this.busyLanes.delete(item.lane);
      this.notify();
    }
    // The lane is free again: a finished item (done or failed) lets the next one go.
    if (finished !== null && !this.paused && !this.blocked) void this.trigger('finished');
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async schedule(): Promise<void> {
    this.clearTimer();
    if (!this.foreground || this.paused || this.blocked) return;
    const earliest = await this.deps.store.earliestAttempt();
    if (earliest === null) return;
    const wait = Date.parse(earliest) - this.now().getTime();
    if (wait <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.trigger('timer');
    }, wait);
  }
}
