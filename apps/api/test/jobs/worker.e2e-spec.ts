// The worker (contracts/slice-9.md §7.12, R113): the scheduled jobs replace @nestjs/schedule, the
// HTTP process runs no job, interleaved jobs for two schools keep their own contexts, and the
// scheduled fan-out reaches live schools only.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JobRunner } from '../../src/jobs/job-runner';
import { SCHEDULES, WorkerHost } from '../../src/jobs/worker-host';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { WhatsAppHealth } from '../../src/messaging/whatsapp-health';
import { SchoolFanOutRepository } from '../../src/repositories/platform/school-fan-out.repository';
import { SessionPurge } from '../../src/jobs/session-purge';
import { RequestContextService } from '../../src/tenancy/request-context';
import { createSchoolSession } from '../support/school-session';
import { closeTestDb, testDb } from '../support/schools';
import {
  asSchool,
  connectedNumber,
  guardian,
  messagingApp,
  messagingSchool,
  type FakeDrivers,
} from '../messaging/support';

const DAY = 24 * 60 * 60_000;

describe('the worker (e2e)', () => {
  let app: NestExpressApplication;
  let drivers: FakeDrivers;
  const db = testDb();

  beforeAll(async () => {
    ({ app, drivers } = await messagingApp());
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('§7.12: the repeatable jobs are exactly the reviewed list (a new scheduled job is a reviewed change)', () => {
    expect(SCHEDULES).toEqual([
      { job: 'outbox-sweep', every: 120_000 },
      { job: 'whatsapp-health-sweep', every: 300_000 },
      { job: 'sms-delivery-poll', every: 120_000 },
      { job: 'delivery-health-rollup', every: 900_000 },
      { job: 'staged-upload-sweep', pattern: '0 30 2 * * *' },
      { job: 'session-purge', pattern: '0 0 3 * * *' },
      // contracts/slice-11.md §8.3, §8.4.
      { job: 'register-deadline-sweep', every: 300_000 },
      { job: 'attendance-nightly-recompute', pattern: '0 30 0 * * *' },
    ]);
  });

  it('A2: session-purge deletes sessions ended over 90 days ago with their devices, and nothing else', async () => {
    const a = await messagingSchool();
    const b = await messagingSchool();
    const now = new Date();
    const user = async (school: typeof a) => (await guardian(db, school, { login: true })).userId ?? 0n;
    const session = async (school: typeof a, userId: bigint, opts: { expiresAt?: Date; revokedAt?: Date }) => {
      const s = await createSchoolSession(db, school, { userId }, { channel: 'bearer', ...opts });
      await db.device.create({
        data: {
          schoolId: school.id,
          userId,
          sessionId: s.sessionId,
          platform: 'android',
          pushToken: `fcm-purge-${s.sessionId}`,
          appVersion: '1.0.0',
        },
      });
      return s.sessionId;
    };
    const userA = await user(a);
    const revokedLongAgo = await session(a, userA, { revokedAt: new Date(now.getTime() - 91 * DAY) });
    const expiredLongAgo = await session(a, userA, { expiresAt: new Date(now.getTime() - 100 * DAY) });
    const revokedRecently = await session(a, userA, { revokedAt: new Date(now.getTime() - 10 * DAY) });
    const live = await session(a, userA, {});
    const userB = await user(b);
    const otherSchool = await session(b, userB, { revokedAt: new Date(now.getTime() - 91 * DAY) });

    const result = await asSchool(app, a.id, () => app.get(SessionPurge, { strict: false }).run(a.id, now));
    expect(result).toEqual({ sessions: 2, devices: 2 });
    const remaining = await db.session.findMany({ where: { schoolId: a.id, userId: userA }, select: { id: true } });
    expect(remaining.map((r) => r.id).sort()).toEqual([revokedRecently, live].sort());
    const devices = await db.device.findMany({ where: { schoolId: a.id, userId: userA }, select: { sessionId: true } });
    expect(devices.map((d) => d.sessionId).sort()).toEqual([revokedRecently, live].sort());
    expect(remaining.some((r) => r.id === revokedLongAgo || r.id === expiredLongAgo)).toBe(false);
    // School B's ended session is untouched by A's run; the scheduled job reaches every school.
    expect(await db.session.count({ where: { schoolId: b.id, id: otherSchool } })).toBe(1);
    // The test database holds every suite's schools; the fan-out is narrowed to these two.
    const fanOut = jest
      .spyOn(app.get(SchoolFanOutRepository, { strict: false }), 'listAllForFanOut')
      .mockResolvedValue([a.id, b.id]);
    try {
      expect(await app.get(JobRunner, { strict: false }).scheduled('session-purge', now)).toBe('done');
    } finally {
      fanOut.mockRestore();
    }
    expect(await db.session.count({ where: { schoolId: b.id, id: otherSchool } })).toBe(0);
    expect(await db.device.count({ where: { schoolId: b.id, sessionId: otherSchool } })).toBe(0);
  });

  it('the HTTP process starts no queue consumer and no scheduler (WORKER unset)', () => {
    const host = app.get(WorkerHost, { strict: false });
    expect(Reflect.get(host, 'workers')).toEqual([]);
    expect(Reflect.get(host, 'scheduler')).toBeUndefined();
  });

  it('the worker health probe answers when Postgres and Redis do', async () => {
    expect(await app.get(WorkerHost, { strict: false }).healthy()).toBe(true);
  });

  it('R113: interleaved jobs for two schools each see only their own tenant', async () => {
    const a = await messagingSchool();
    const b = await messagingSchool();
    const runner = app.get(JobRunner, { strict: false });
    const context = app.get(RequestContextService);
    const processor = app.get(MessageProcessor, { strict: false });
    const seen: string[] = [];
    const spy = jest.spyOn(processor, 'run').mockImplementation(async (schoolId) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(`${schoolId}:${context.schoolId}`);
      return 'skipped';
    });
    try {
      await Promise.all([
        runner.messaging('message', { schoolId: a.id.toString(), messageId: '1' }),
        runner.messaging('message', { schoolId: b.id.toString(), messageId: '2' }),
        runner.messaging('message', { schoolId: a.id.toString(), messageId: '3' }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(seen.sort()).toEqual([`${a.id}:${a.id}`, `${a.id}:${a.id}`, `${b.id}:${b.id}`].sort());
  });

  it('R113: a scheduled sweep runs per live school; a failing school does not stop the others', async () => {
    const a = await messagingSchool();
    const b = await messagingSchool();
    await connectedNumber(db, a);
    await connectedNumber(db, b);
    await guardian(db, b);
    drivers.healthOutcome = { ok: true };
    const runner = app.get(JobRunner, { strict: false });
    const context = app.get(RequestContextService);
    const fanOut = jest
      .spyOn(app.get(SchoolFanOutRepository, { strict: false }), 'listLiveForFanOut')
      .mockResolvedValue([a.id, b.id]);
    const health = app.get(WhatsAppHealth, { strict: false });
    const original = health.check.bind(health);
    const checked: string[] = [];
    const check = jest.spyOn(health, 'check').mockImplementation(async (schoolId, id, now) => {
      checked.push(`${schoolId}:${context.schoolId}`);
      if (schoolId === a.id) throw new Error('school A health check failed');
      return original(schoolId, id, now);
    });
    try {
      expect(await runner.scheduled('whatsapp-health-sweep', new Date())).toBe('done');
    } finally {
      check.mockRestore();
      fanOut.mockRestore();
    }
    expect(checked).toEqual([`${a.id}:${a.id}`, `${b.id}:${b.id}`]);
    const bNumber = await db.whatsAppNumber.findFirst({ where: { schoolId: b.id } });
    expect(bNumber?.lastHealthyAt).not.toBeNull();
    expect(await runner.scheduled('no-such-job', new Date())).toBe('dropped');
  });
});
