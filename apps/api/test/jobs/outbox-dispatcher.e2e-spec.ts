// OutboxDispatcher against a real Redis: every method puts its job under the id and delay its
// contract names. The dispatcher swallows a failed enqueue (the sweep recovers the row), and every
// harness mocks it, which is how ids BullMQ refused (':' in a custom id) went unnoticed; here each
// method's job is read back from the queue. A unique key prefix keeps these queues apart from a
// running worker's, and they are obliterated afterwards.
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../src/config/env';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import {
  alertJobId,
  announcementSendJobId,
  healthJobId,
  JOB,
  messageJobId,
  QUEUE,
  rollupJobId,
  rollupSectionDayJobId,
} from '../../src/messaging/queues';
import type { AfterCommit } from '../../src/tenancy/after-commit';
import { guardQueues, takeRefusedProductionEnqueues } from '../core/app';
import type { SchoolId } from '../../src/tenancy/school-id';
import { closeTestDb, createSchool } from '../support/schools';

const PREFIX = `asms-test-outbox-${randomBytes(4).toString('hex')}`;

/** The production class with its own BullMQ prefix (the seam OutboxDispatcher keeps for this). */
class PrefixedDispatcher extends OutboxDispatcher {
  protected override readonly prefix = PREFIX;
}

describe('OutboxDispatcher enqueues what its contract names (real Redis)', () => {
  const env = loadEnv();
  // Only the *AfterCommit methods use AfterCommit; the direct methods tested here never do.
  const dispatcher = new PrefixedDispatcher(env, {} as AfterCommit);
  const queues = Object.values(QUEUE).map(
    (name) => new Queue(name, { connection: { url: env.REDIS_URL, maxRetriesPerRequest: 1 }, prefix: PREFIX }),
  );
  const queue = (name: string) => {
    const found = queues.find((q) => q.name === name);
    if (!found) throw new Error(`no queue ${name}`);
    return found;
  };
  let schoolId: SchoolId;
  let sid: string;

  beforeAll(async () => {
    schoolId = (await createSchool()).id;
    sid = schoolId.toString();
  });
  const now = new Date('2026-10-04T09:30:00Z');

  afterAll(async () => {
    await closeTestDb();
    await dispatcher.onModuleDestroy();
    for (const q of queues) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  afterEach(() => {
    expect(dispatcher.enqueueFailures).toBe(0);
  });

  async function readBack(queueName: string, id: string) {
    const job = await queue(queueName).getJob(id);
    if (!job) throw new Error(`job ${id} not on ${queueName}`);
    return { id: job.id, name: job.name, delay: job.opts.delay ?? 0, data: job.data as Record<string, string> };
  }

  it('messages: message-<id>-<round>[w<minute>], delayed as asked', async () => {
    await dispatcher.messages(schoolId, [
      { id: 101n, round: 0 },
      { id: 102n, round: 2, delayMs: 45_000, waitMinute: 29_000_000 },
    ]);
    expect(await readBack(QUEUE.messaging, messageJobId(101n, 0))).toEqual({
      id: 'message-101-0',
      name: JOB.message,
      delay: 0,
      data: { schoolId: sid, messageId: '101' },
    });
    expect(await readBack(QUEUE.messaging, messageJobId(102n, 2, 29_000_000))).toMatchObject({
      id: 'message-102-2w29000000',
      delay: 45_000,
    });
  });

  it('rollup: rollup-<deliveryId>-<status>[-s<minute>]', async () => {
    await dispatcher.rollup(schoolId, [{ deliveryId: 7n, messageId: 101n, status: 'delivered' }]);
    await dispatcher.rollup(schoolId, [{ deliveryId: 8n, messageId: 101n, status: 'failed' }], 29_000_001);
    expect(await readBack(QUEUE.messaging, rollupJobId(7n, 'delivered'))).toEqual({
      id: 'rollup-7-delivered',
      name: JOB.messageRollup,
      delay: 0,
      data: { schoolId: sid, messageId: '101' },
    });
    expect((await readBack(QUEUE.messaging, rollupJobId(8n, 'failed', 29_000_001))).id).toBe('rollup-8-failed-s29000001');
  });

  it('health: wa-health-<numberId>-<minute>', async () => {
    await dispatcher.health(schoolId, 5n, now);
    expect(await readBack(QUEUE.messaging, healthJobId(5n, now))).toEqual({
      id: `wa-health-5-${Math.floor(now.getTime() / 60_000)}`,
      name: JOB.whatsappHealth,
      delay: 0,
      data: { schoolId: sid, whatsappNumberId: '5' },
    });
  });

  it('alerts: alert-<id>[-s<minute>] on the attendance queue, delayed to the due time', async () => {
    await dispatcher.alerts(
      schoolId,
      [
        { id: 9n, dueAt: new Date(now.getTime() + 90_000) },
        { id: 10n, dueAt: new Date(now.getTime() - 1_000), sweepMinute: 29_000_002 },
      ],
      now,
    );
    expect(await readBack(QUEUE.attendance, alertJobId(9n))).toEqual({
      id: 'alert-9',
      name: JOB.attendanceAlert,
      delay: 90_000,
      data: { schoolId: sid, alertId: '9' },
    });
    expect(await readBack(QUEUE.attendance, alertJobId(10n, 29_000_002))).toMatchObject({ id: 'alert-10-s29000002', delay: 0 });
  });

  it('announcementSends: ann-send-<id>-<epochSeconds>[-s<minute>], delayed to the scheduled time', async () => {
    const at = new Date(now.getTime() + 5 * 60_000);
    await dispatcher.announcementSends(
      schoolId,
      [
        { id: 12n, scheduledAt: at },
        { id: 13n, scheduledAt: new Date(now.getTime() - 120_000), sweepMinute: 29_000_003 },
      ],
      now,
    );
    const job = await queue(QUEUE.messaging).getJob(announcementSendJobId(12n, at));
    expect({ id: job?.id, name: job?.name, delay: job?.opts.delay, data: job?.data as unknown }).toEqual({
      id: `ann-send-12-${Math.floor(at.getTime() / 1000)}`,
      name: JOB.announcementSend,
      delay: 5 * 60_000,
      data: { schoolId: sid, announcementId: '12' },
    });
    expect(
      await readBack(QUEUE.messaging, announcementSendJobId(13n, new Date(now.getTime() - 120_000), 29_000_003)),
    ).toMatchObject({ delay: 0 });
  });

  it('rollups: att-rollup-<sectionId>-<YYYYMMDD>-<version> on the attendance queue', async () => {
    await dispatcher.rollups(schoolId, [{ sectionId: 11n, date: '2026-10-04', version: 3n }]);
    expect(await readBack(QUEUE.attendance, rollupSectionDayJobId(11n, '2026-10-04', 3n))).toEqual({
      id: 'att-rollup-11-20261004-3',
      name: JOB.attendanceRollup,
      delay: 0,
      data: { schoolId: sid, sectionId: '11', date: '2026-10-04' },
    });
  });

  it('a refused enqueue is counted, not thrown (the sweep recovers the row)', async () => {
    const other = new PrefixedDispatcher(env, {} as AfterCommit);
    const refused = jest.spyOn(Queue.prototype, 'addBulk').mockRejectedValueOnce(new Error('refused'));
    try {
      await other.messages(schoolId, [{ id: 1n, round: 0 }]);
      expect(other.enqueueFailures).toBe(1);
    } finally {
      refused.mockRestore();
      await other.onModuleDestroy();
    }
  });

  it('slice 17: under the test guard, the production dispatcher (default prefix) cannot put a job on a production queue', async () => {
    guardQueues();
    const production = new OutboxDispatcher(env, {} as AfterCommit);
    try {
      await production.messages(schoolId, [{ id: 1n, round: 0 }]);
      await production.alerts(schoolId, [{ id: 1n, dueAt: now }], now);
      // Refused before it reached Redis; the dispatcher counts it as it counts any failed enqueue.
      expect(production.enqueueFailures).toBe(2);
      expect(takeRefusedProductionEnqueues()).toEqual([`bull:${QUEUE.messaging}`, `bull:${QUEUE.attendance}`]);
      // A test-prefixed queue is untouched by the guard.
      await dispatcher.messages(schoolId, [{ id: 103n, round: 0 }]);
      expect(await readBack(QUEUE.messaging, messageJobId(103n, 0))).toMatchObject({ id: 'message-103-0' });
    } finally {
      await production.onModuleDestroy();
    }
  });
});
