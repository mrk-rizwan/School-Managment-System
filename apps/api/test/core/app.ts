import { randomBytes } from 'node:crypto';
import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { DestinationStream } from 'pino';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { LOG_DESTINATION } from '../../src/common/logging';
import { loadEnv } from '../../src/config/env';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { QUEUE } from '../../src/messaging/queues';

export interface TestAppOptions {
  /** Extra modules, e.g. a test-only controller module. */
  imports?: Type[];
  /** Receives every log line (already scrubbed). Default: discarded. */
  logStream?: DestinationStream;
  /** Providers to replace, e.g. a failing throttler storage. */
  overrides?: { provide: unknown; useValue: unknown }[];
}

// ------------------------------------------------------------------------------ queues
//
// A test never enqueues where a worker listens. Every test app's OutboxDispatcher writes under a
// key prefix of its own (`asms-test-...`), whether or not a suite mocks its methods, so a running
// dev worker (which reads BullMQ's default prefix) can never pick up a test's job, and a suite's
// jest.restoreAllMocks() cannot undo it. Behind that, a guard on BullMQ itself: an add to a
// production-named queue (the default prefix and a name in QUEUE) is refused and recorded, and the
// app's close() fails the suite.

/** The production queues as BullMQ keys them: its default prefix and our names. */
const PRODUCTION_QUEUES = new Set(Object.values(QUEUE).map((name) => `bull:${name}`));
/** Every refused add, as `prefix:name`, since this test file loaded. */
const productionEnqueues: string[] = [];
/** Test-prefixed queues an add reached, to obliterate on close. */
const touchedTestQueues = new Set<string>();
const GUARDED = Symbol.for('asms.test.queue-guard');

function keyOf(queue: Queue): string {
  return `${queue.opts.prefix ?? 'bull'}:${queue.name}`;
}

/** Wraps Queue.prototype.add and addBulk once per module registry (each test file has its own). */
export function guardQueues(): void {
  if (Reflect.get(Queue.prototype, GUARDED) === true) return;
  Reflect.defineProperty(Queue.prototype, GUARDED, { value: true });
  for (const method of ['add', 'addBulk'] as const) {
    const original = Reflect.get(Queue.prototype, method) as (this: Queue, ...args: unknown[]) => Promise<unknown>;
    Reflect.defineProperty(Queue.prototype, method, {
      configurable: true,
      writable: true,
      value: function guarded(this: Queue, ...args: unknown[]): Promise<unknown> {
        const key = keyOf(this);
        if (PRODUCTION_QUEUES.has(key)) {
          productionEnqueues.push(key);
          return Promise.reject(new Error(`a test enqueued to the production queue ${key}`));
        }
        if (key.startsWith('asms-test-')) touchedTestQueues.add(key);
        return original.apply(this, args);
      },
    });
  }
}

/** The production dispatcher under a key prefix no worker reads. */
function testDispatcher(prefix: string): Type<OutboxDispatcher> {
  class TestOutboxDispatcher extends OutboxDispatcher {
    protected override readonly prefix = prefix;
  }
  return TestOutboxDispatcher;
}

/** Removes this app's test queues from Redis, so a run leaves no delayed jobs behind. */
async function obliterate(prefix: string): Promise<void> {
  const mine = [...touchedTestQueues].filter((key) => key.startsWith(`${prefix}:`));
  if (mine.length === 0) return;
  const connection = { url: loadEnv().REDIS_URL, maxRetriesPerRequest: 1 };
  for (const key of mine) {
    const queue = new Queue(key.slice(prefix.length + 1), { connection, prefix });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      touchedTestQueues.delete(key);
    }
  }
}

/**
 * The real AppModule with the same Express configuration as main (configureApp), so e2e
 * tests exercise the production stack. Call `app.close()` in afterAll: it fails if any job of
 * this file reached a production-named queue.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  guardQueues();
  const prefix = `asms-test-${randomBytes(6).toString('hex')}`;
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logStream ?? { write: () => undefined })
    .overrideProvider(OutboxDispatcher)
    .useClass(testDispatcher(prefix));
  for (const { provide, useValue } of options.overrides ?? []) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  await app.init();
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await obliterate(prefix);
    if (productionEnqueues.length > 0) {
      throw new Error(`jobs reached production-named queues: ${productionEnqueues.join(', ')}`);
    }
  };
  return app;
}

/** The key prefix the app's dispatcher writes under (for the guard's own test). */
export function queuePrefixOf(app: NestExpressApplication): string | undefined {
  return Reflect.get(app.get(OutboxDispatcher, { strict: false }), 'prefix') as string | undefined;
}

/** The refused adds so far in this test file, cleared (for the guard's own test). */
export const takeRefusedProductionEnqueues = (): string[] => productionEnqueues.splice(0);

/**
 * A job this app enqueued, read back from its test-prefixed queue (a suite proving an enqueue
 * path end to end, then running the job body with what was queued): its name and payload, or null.
 */
export async function queuedJob(
  app: NestExpressApplication,
  queueName: string,
  jobId: string,
): Promise<{ name: string; data: unknown } | null> {
  const prefix = queuePrefixOf(app);
  if (!prefix?.startsWith('asms-test-')) throw new Error('queuedJob reads only a test-prefixed queue');
  const queue = new Queue(queueName, { connection: { url: loadEnv().REDIS_URL, maxRetriesPerRequest: 1 }, prefix });
  try {
    const job = await queue.getJob(jobId);
    return job ? { name: job.name, data: job.data as unknown } : null;
  } finally {
    await queue.close();
  }
}
