// Every job id shape must be accepted by a real BullMQ queue. BullMQ refuses a custom id that
// contains ':' unless it splits into exactly three parts ("Custom Id cannot contain :"); the
// first Phase 2 ids broke that rule and absence alerts and attendance rollups were never queued,
// while every unit test passed because none of them went through a real queue (found 2026-10-04).
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../src/config/env';
import {
  alertJobId,
  announcementSendJobId,
  chargeRunJobId,
  healthJobId,
  messageJobId,
  rollupJobId,
  rollupSectionDayJobId,
} from '../../src/messaging/queues';

const shapes: [string, string][] = [
  ['message', messageJobId(123n, 0)],
  ['message, paced follow-up', messageJobId(123n, 2, 29_000_000)],
  ['delivery rollup', rollupJobId(456n, 'delivered')],
  ['delivery rollup, sweep recovery', rollupJobId(456n, 'failed', 29_000_001)],
  ['whatsapp health', healthJobId(7n, new Date('2026-10-04T09:30:00Z'))],
  ['absence alert', alertJobId(789n)],
  ['absence alert, sweep recovery', alertJobId(789n, 29_000_002)],
  ['attendance rollup', rollupSectionDayJobId(11n, '2026-10-04', 3n)],
  ['announcement send', announcementSendJobId(12n, new Date('2026-10-05T03:00:00Z'))],
  ['announcement send, sweep recovery', announcementSendJobId(12n, new Date('2026-10-05T03:00:00Z'), 29_000_003)],
  // contracts/slice-19.md §5.
  ['charge run', chargeRunJobId(77n)],
];

describe('job ids are accepted by a real queue', () => {
  const queue = new Queue(`asms-test-job-ids-${randomBytes(4).toString('hex')}`, {
    connection: { url: loadEnv().REDIS_URL, maxRetriesPerRequest: 1 },
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it.each(shapes)('%s: %s is queued under exactly that id', async (_label, jobId) => {
    expect(jobId).not.toContain(':');
    const job = await queue.add('probe', { schoolId: '1' }, { jobId, delay: 60_000 });
    expect(job.id).toBe(jobId);
    expect((await queue.getJob(jobId))?.id).toBe(jobId);
  });

  it('a second add under the same id is the same job (the dedupe the ids exist for)', async () => {
    const id = alertJobId(999n);
    const first = await queue.add('probe', { schoolId: '1' }, { jobId: id, delay: 60_000 });
    const second = await queue.add('probe', { schoolId: '1' }, { jobId: id, delay: 60_000 });
    expect(second.id).toBe(first.id);
    expect(await queue.getDelayedCount()).toBeGreaterThanOrEqual(1);
  });
});
