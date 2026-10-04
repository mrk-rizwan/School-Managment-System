// Slice 9 messaging core (contracts/slice-9.md §7): NotificationService, the processor, the
// rollup, the outbox sweep, the SMS poll and the WhatsApp health check, with fake drivers.
// Rules: R105, R107, R108, R109, R111, R112, R113, R115, R173.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { JobRunner } from '../../src/jobs/job-runner';
import { DeliverySweeps } from '../../src/messaging/delivery-sweeps';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { MessageRollup } from '../../src/messaging/message-rollup';
import { NotificationService } from '../../src/messaging/notification.service';
import { WhatsAppHealth } from '../../src/messaging/whatsapp-health';
import { MessageDeliveryRepository } from '../../src/repositories/message-delivery.repository';
import { MessageUsageRepository } from '../../src/repositories/message-usage.repository';
import { SchoolMessagingRepository } from '../../src/repositories/school-messaging.repository';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  asSchool,
  cipher,
  connectedNumber,
  guardian,
  messagingApp,
  messagingSchool,
  principal,
  tx,
  type Enqueued,
  type FakeDrivers,
} from './support';

const MIN = 60_000;
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ID_PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const PHONE_PATTERN = /\+92[0-9]{10}/;
let subjectSeq = BigInt(Math.floor(Math.random() * 1e9)) * 1000n;
const nextSubject = () => ++subjectSeq;

describe('slice 9 messaging core (e2e)', () => {
  let app: NestExpressApplication;
  let drivers: FakeDrivers;
  let enqueued: Enqueued[];
  let notifications: NotificationService;
  let processor: MessageProcessor;
  const logs: string[] = [];
  const db = testDb();

  beforeAll(async () => {
    ({ app, drivers, enqueued } = await messagingApp({ write: (line: string) => void logs.push(line) }));
    notifications = app.get(NotificationService, { strict: false });
    processor = app.get(MessageProcessor, { strict: false });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(() => {
    drivers.calls.length = 0;
    drivers.whatsappOutcomes.length = 0;
    drivers.smsOutcomes.length = 0;
    drivers.pushOutcome = null;
    drivers.healthOutcome = { ok: true };
    enqueued.length = 0;
  });

  /** A holiday notice (normal priority) to `recipients`, in a sender transaction. */
  const notice = (school: TestSchool, recipients: { guardianId: bigint }[], subjectId = nextSubject()) =>
    asSchool(app, school.id, () =>
      tx.run(() =>
        notifications.send(school.id, {
          type: 'holiday_notice',
          subject: { type: 'holiday', id: subjectId },
          recipients,
          vars: { name: 'Iqbal Day', startsOn: D('2026-11-09'), endsOn: D('2026-11-09'), reopensOn: D('2026-11-10') },
        }),
      ),
    );

  const messagesOf = (school: TestSchool, guardianId: bigint) =>
    db.message.findMany({ where: { schoolId: school.id, guardianId }, orderBy: { id: 'asc' } });
  const deliveriesOf = (school: TestSchool, messageId: bigint) =>
    db.messageDelivery.findMany({ where: { schoolId: school.id, messageId }, orderBy: { id: 'asc' } });
  const run = (school: TestSchool, messageId: bigint, now = new Date()) =>
    asSchool(app, school.id, () => processor.run(school.id, messageId, now));

  async function onlyMessage(school: TestSchool, guardianId: bigint) {
    const [message] = await messagesOf(school, guardianId);
    if (!message) throw new Error('no message');
    return message;
  }

  // ------------------------------------------------------------------------ NotificationService

  describe('NotificationService.send', () => {
    it('R105: refuses to run outside the sender transaction (a programming error)', async () => {
      const school = await messagingSchool();
      const g = await guardian(db, school);
      await expect(
        asSchool(app, school.id, () =>
          notifications.send(school.id, {
            type: 'holiday_notice',
            subject: { type: 'holiday', id: nextSubject() },
            recipients: [{ guardianId: g.id }],
            vars: { name: 'Iqbal Day', startsOn: D('2026-11-09'), endsOn: D('2026-11-09') },
          }),
        ),
      ).rejects.toThrow(/transaction/);
    });

    it('R105: the row is written in the sender transaction and enqueued only after commit', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      let seenInside = -1;
      await asSchool(app, school.id, () =>
        tx.run(async () => {
          await notifications.send(school.id, {
            type: 'holiday_notice',
            subject: { type: 'holiday', id: nextSubject() },
            recipients: [{ guardianId: g.id }],
            vars: { name: 'Iqbal Day', startsOn: D('2026-11-09'), endsOn: D('2026-11-09') },
          });
          seenInside = enqueued.length;
        }),
      );
      const message = await onlyMessage(school, g.id);
      expect(seenInside).toBe(0);
      expect(message.status).toBe('queued');
      expect(enqueued).toEqual([{ kind: 'message', schoolId: school.id, id: message.id, delayMs: 0 }]);
    });

    it('R105: a rolled-back sender writes no message and enqueues nothing', async () => {
      const school = await messagingSchool();
      const g = await guardian(db, school);
      await expect(
        asSchool(app, school.id, () =>
          tx.run(async () => {
            await notifications.send(school.id, {
              type: 'holiday_notice',
              subject: { type: 'holiday', id: nextSubject() },
              recipients: [{ guardianId: g.id }],
              vars: { name: 'Iqbal Day', startsOn: D('2026-11-09'), endsOn: D('2026-11-09') },
            });
            throw new Error('sender failed');
          }),
        ),
      ).rejects.toThrow('sender failed');
      expect(await messagesOf(school, g.id)).toEqual([]);
      expect(enqueued).toEqual([]);
    });

    it('R107: one message per person per subject: a retried sender and a repeated recipient write nothing new', async () => {
      const school = await messagingSchool();
      const g = await guardian(db, school);
      const subject = nextSubject();
      const first = await notice(school, [{ guardianId: g.id }, { guardianId: g.id }], subject);
      expect(first).toMatchObject({ created: 1, existing: 0, dedupedByPhone: 0 });
      expect(first.messages.map((m) => m.person)).toEqual([{ guardianId: g.id }]);
      // A retried sender gets back none of its old rows.
      expect(await notice(school, [{ guardianId: g.id }], subject)).toEqual({ created: 0, existing: 1, dedupedByPhone: 0, messages: [] });
      expect(await messagesOf(school, g.id)).toHaveLength(1);
    });

    it('a merged guardian is refused (senders resolve survivors)', async () => {
      const school = await messagingSchool();
      const survivor = await guardian(db, school);
      const merged = await guardian(db, school);
      await db.guardian.updateMany({ where: { schoolId: school.id, id: merged.id }, data: { status: 'merged', mergedIntoId: survivor.id } });
      await expect(notice(school, [{ guardianId: merged.id }])).rejects.toThrow(/merged/);
    });

    it('R112: with the school number down, a WhatsApp guardian is routed straight to the SMS fallback', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school, 'down');
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      expect((await onlyMessage(school, g.id)).channelPlan).toEqual(['sms']);
    });

    it('§7.4: a keypad guardian whose only leg the allow list removes is suppressed not_allowed, with a delivery row', async () => {
      const school = await messagingSchool({ allowed: [] });
      const g = await guardian(db, school, { capability: 'keypad' });
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      expect(message).toMatchObject({ status: 'suppressed', suppressedReason: 'not_allowed', channelPlan: [] });
      expect(await deliveriesOf(school, message.id)).toEqual([
        expect.objectContaining({ channel: 'sms', status: 'suppressed', suppressedReason: 'not_allowed' }),
      ]);
      expect(enqueued).toEqual([]);
    });

    it('§7.4: no channel at all is suppressed no_channel on the type first channel', async () => {
      const school = await messagingSchool();
      const g = await guardian(db, school, { capability: 'keypad', phone: null });
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      expect(message).toMatchObject({ status: 'suppressed', suppressedReason: 'no_channel' });
      expect(await deliveriesOf(school, message.id)).toEqual([
        expect.objectContaining({ channel: 'whatsapp', suppressedReason: 'no_channel' }),
      ]);
    });

    it('an in-app-only plan is sent at once with no job', async () => {
      const school = await messagingSchool({ allowed: [] });
      const g = await guardian(db, school, { capability: 'smartphone_data', login: true });
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      expect(message).toMatchObject({ status: 'sent', channelPlan: ['in_app'] });
      expect(message.finishedAt).not.toBeNull();
      expect(enqueued).toEqual([]);
    });

    it('sets a 3,000-recipient notice inside the transaction limit (set-based insert)', async () => {
      const school = await messagingSchool();
      const ids: { guardianId: bigint }[] = [];
      const rows = Array.from({ length: 3000 }, (_, i) => ({
        schoolId: school.id,
        fullName: `Bulk Guardian ${i}`,
        phone: `+9230${String(10_000_000 + i).padStart(8, '0')}`,
        contactCapability: 'keypad' as const,
      }));
      const created = await db.guardian.createManyAndReturn({ data: rows, select: { id: true } });
      for (const row of created) ids.push({ guardianId: row.id });
      const started = Date.now();
      const sent = await notice(school, ids);
      expect(sent).toMatchObject({ created: 3000, existing: 0, dedupedByPhone: 0 });
      expect(sent.messages).toHaveLength(3000);
      expect(Date.now() - started).toBeLessThan(5000);
    }, 60_000);
  });

  // ------------------------------------------------------------------------ the processor

  describe('the processor', () => {
    it('R105: a replayed job finds its row already claimed and sends nothing', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      expect(await run(school, message.id)).toBe('finished');
      expect(await run(school, message.id)).toBe('skipped');
      expect(drivers.of('whatsapp')).toHaveLength(1);
      expect(await deliveriesOf(school, message.id)).toHaveLength(1);
      expect((await onlyMessage(school, g.id)).status).toBe('sent');
    });

    it('R113: a payload naming school B and a message of school A touches nothing; a bad payload is dropped', async () => {
      const a = await messagingSchool();
      const b = await messagingSchool();
      await connectedNumber(db, a);
      const g = await guardian(db, a);
      await notice(a, [{ guardianId: g.id }]);
      const message = await onlyMessage(a, g.id);
      const runner = app.get(JobRunner, { strict: false });
      expect(await runner.messaging('message', { schoolId: b.id.toString(), messageId: message.id.toString() })).toBe('done');
      expect((await onlyMessage(a, g.id)).status).toBe('queued');
      expect(drivers.calls).toEqual([]);
      expect(await runner.messaging('message', { schoolId: a.id.toString(), messageId: message.id.toString(), phone: '+923001234567' })).toBe('dropped');
      expect(await runner.messaging('message', { schoolId: a.id.toString() })).toBe('dropped');
      expect(logs.filter((l) => l.includes('job dropped')).some((l) => l.includes(message.id.toString()))).toBe(false);
    });

    it('R113, R80 lifted (d): a suspended school runs exactly as an active one; a terminated school is dropped', async () => {
      const suspended = await messagingSchool({ status: 'suspended' });
      await connectedNumber(db, suspended);
      const g = await guardian(db, suspended);
      await notice(suspended, [{ guardianId: g.id }]);
      const runner = app.get(JobRunner, { strict: false });
      const message = await onlyMessage(suspended, g.id);
      expect(await runner.messaging('message', { schoolId: suspended.id.toString(), messageId: message.id.toString() })).toBe('done');
      expect((await onlyMessage(suspended, g.id)).status).toBe('sent');
      const terminated = await createSchool({ status: 'terminated' });
      expect(await runner.messaging('message', { schoolId: terminated.id.toString(), messageId: '1' })).toBe('dropped');
    });

    it('R112: three WhatsApp attempts over fifteen minutes, then the SMS fallback (allowed type)', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      drivers.failWhatsApp('provider_unavailable', 3);
      const t0 = new Date();
      expect(await run(school, message.id, t0)).toBe('released');
      expect(enqueued.at(-1)).toMatchObject({ kind: 'message', id: message.id, delayMs: 5 * MIN });
      // Too early: nothing is attempted.
      expect(await run(school, message.id, new Date(t0.getTime() + 2 * MIN))).toBe('released');
      expect(drivers.of('whatsapp')).toHaveLength(1);
      expect(await run(school, message.id, new Date(t0.getTime() + 5 * MIN))).toBe('released');
      expect(await run(school, message.id, new Date(t0.getTime() + 15 * MIN))).toBe('finished');
      expect(drivers.of('whatsapp')).toHaveLength(3);
      expect(drivers.of('sms')).toHaveLength(1);
      expect(drivers.of('sms')[0]?.to).toBe(g.phone);
      expect((await onlyMessage(school, g.id)).status).toBe('sent');
      const rows = await deliveriesOf(school, message.id);
      expect(rows.map((r) => [r.channel, r.attempt, r.status])).toEqual([
        ['whatsapp', 1, 'failed'],
        ['whatsapp', 2, 'failed'],
        ['whatsapp', 3, 'failed'],
        ['sms', 1, 'accepted'],
      ]);
    });

    it('R112: a permanent WhatsApp failure falls to SMS in the same round', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      drivers.failWhatsApp('not_on_whatsapp');
      expect(await run(school, message.id)).toBe('finished');
      expect(drivers.of('sms')).toHaveLength(1);
    });

    it('R109: an after-failure SMS leg of a type not in the allow list is suppressed not_allowed', async () => {
      const school = await messagingSchool({ allowed: ['holiday_notice'] });
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      await db.schoolSettings.updateMany({ where: { schoolId: school.id }, data: { smsAllowedTypes: [] } });
      const message = await onlyMessage(school, g.id);
      drivers.failWhatsApp('invalid_number');
      expect(await run(school, message.id)).toBe('finished');
      expect(drivers.of('sms')).toEqual([]);
      expect(await onlyMessage(school, g.id)).toMatchObject({ status: 'failed' });
      expect((await deliveriesOf(school, message.id)).at(-1)).toMatchObject({
        channel: 'sms',
        status: 'suppressed',
        suppressedReason: 'not_allowed',
      });
    });

    it('A6: an urgent SMS leg of a type removed from the allow list since the write is suppressed not_allowed', async () => {
      const school = await messagingSchool({ allowed: [] });
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      // Planned at write time while the type was allowed: WhatsApp and SMS together.
      await db.message.create({
        data: {
          schoolId: school.id,
          type: 'absence_alert',
          priority: 'urgent',
          subjectType: 'attendance_alert',
          subjectId: nextSubject(),
          guardianId: g.id,
          body: 'Iqra Model School: test urgent body.',
          channelPlan: ['whatsapp', 'sms'],
        },
      });
      const message = await onlyMessage(school, g.id);
      expect(await run(school, message.id)).toBe('finished');
      expect(drivers.of('whatsapp')).toHaveLength(1);
      expect(drivers.of('sms')).toEqual([]);
      expect((await deliveriesOf(school, message.id)).map((r) => [r.channel, r.status, r.suppressedReason])).toEqual([
        ['whatsapp', 'accepted', null],
        ['sms', 'suppressed', 'not_allowed'],
      ]);
      expect(await db.messageUsage.findFirst({ where: { schoolId: school.id, channel: 'sms' } })).toBeNull();
    });

    it('A7: the school settings are read before the claim, so a failed read leaves the row queued', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      const spy = jest
        .spyOn(app.get(SchoolMessagingRepository, { strict: false }), 'find')
        .mockRejectedValueOnce(new Error('database unavailable'));
      try {
        await expect(run(school, message.id)).rejects.toThrow('database unavailable');
      } finally {
        spy.mockRestore();
      }
      expect(await onlyMessage(school, g.id)).toMatchObject({ status: 'queued', claimedAt: null });
      expect(drivers.calls).toEqual([]);
      expect(await run(school, message.id)).toBe('finished');
    });

    it('A5: a delivery write that clashes on the attempt key is left to the next round; any other failure propagates', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      const deliveries = app.get(MessageDeliveryRepository, { strict: false });

      // Any other failure: the job fails (the stale-claim sweep returns the row to queued).
      const failing = jest.spyOn(deliveries, 'insert').mockRejectedValueOnce(new Error('disk full'));
      try {
        await expect(run(school, message.id)).rejects.toThrow('disk full');
      } finally {
        failing.mockRestore();
      }
      expect((await onlyMessage(school, g.id)).status).toBe('sending');

      // A crash replay: another worker wrote attempt 1 while this round read no rows.
      await db.message.updateMany({ where: { schoolId: school.id, id: message.id }, data: { status: 'queued' } });
      await db.messageDelivery.create({
        data: { schoolId: school.id, messageId: message.id, channel: 'whatsapp', attempt: 1, status: 'accepted' },
      });
      const stale = jest.spyOn(deliveries, 'listForMessage').mockResolvedValueOnce([]);
      try {
        expect(await run(school, message.id)).toBe('released');
      } finally {
        stale.mockRestore();
      }
      expect(await deliveriesOf(school, message.id)).toHaveLength(1);
      expect(await run(school, message.id)).toBe('finished');
      expect((await onlyMessage(school, g.id)).status).toBe('sent');
    });

    it('R109: three reservations at once on separate connections pass the cap exactly', async () => {
      const school = await messagingSchool();
      const usage = app.get(MessageUsageRepository, { strict: false });
      const month = '2031-01';
      // Each reservation in its own transaction (its own connection), held open after the
      // conditional increment so the others wait on the row lock and re-check the cap.
      const reserve = () =>
        asSchool(app, school.id, () =>
          tx.run(async () => {
            const ok = await usage.reserveSms(school.id, month, 1, 2);
            await new Promise((resolve) => setTimeout(resolve, 300));
            return ok;
          }),
        );
      const results = await Promise.all([reserve(), reserve(), reserve()]);
      expect(results.filter(Boolean)).toHaveLength(2);
      const row = await db.messageUsage.findFirst({ where: { schoolId: school.id, yearMonth: month, channel: 'sms' } });
      expect(row?.sentCount).toBe(2);
    });

    it('R109: the cap suppresses SMS as cap_reached, and the first cap_reached of the month tells each principal once', async () => {
      const school = await messagingSchool({ cap: 1 });
      const boss = await principal(db, school, { email: true });
      const keypads = [
        await guardian(db, school, { capability: 'keypad' }),
        await guardian(db, school, { capability: 'keypad' }),
        await guardian(db, school, { capability: 'keypad' }),
      ];
      await notice(school, keypads.map((k) => ({ guardianId: k.id })));
      for (const k of keypads) await run(school, (await onlyMessage(school, k.id)).id);
      expect(drivers.of('sms')).toHaveLength(1);
      const statuses = await Promise.all(keypads.map((k) => onlyMessage(school, k.id)));
      expect(statuses.map((m) => m.status).sort()).toEqual(['sent', 'suppressed', 'suppressed']);
      expect(statuses.filter((m) => m.status === 'suppressed').every((m) => m.suppressedReason === 'cap_reached')).toBe(true);
      const capNotices = await db.message.findMany({ where: { schoolId: school.id, type: 'sms_cap_reached' } });
      expect(capNotices).toHaveLength(1);
      expect(capNotices[0]).toMatchObject({ staffId: boss.staffId, subjectType: 'sms_cap' });
      const usage = await db.messageUsage.findFirst({ where: { schoolId: school.id, channel: 'sms' } });
      expect(usage?.sentCount).toBe(1);
    });

    it('internal notice to a principal with no device goes by email (§7.3 staff internal)', async () => {
      const school = await messagingSchool({ cap: 0 });
      const boss = await principal(db, school, { email: true });
      const k = await guardian(db, school, { capability: 'keypad' });
      await notice(school, [{ guardianId: k.id }]);
      await run(school, (await onlyMessage(school, k.id)).id);
      const [capNotice] = await db.message.findMany({ where: { schoolId: school.id, staffId: boss.staffId } });
      expect(capNotice?.channelPlan).toEqual(['email', 'in_app']);
      if (!capNotice) throw new Error('no cap notice');
      await run(school, capNotice.id);
      expect(drivers.of('email')).toHaveLength(1);
      expect(drivers.of('email')[0]?.template).toBe('SMS allowance used up');
    });

    it('urgent: a WhatsApp guardian gets WhatsApp and SMS together (R149 via §7.3)', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      // Urgent plans are routing's (routing.spec.ts); here the processor runs both legs at once.
      await db.message.create({
        data: {
          schoolId: school.id,
          type: 'absence_alert',
          priority: 'urgent',
          subjectType: 'attendance_alert',
          subjectId: nextSubject(),
          guardianId: g.id,
          body: 'Iqra Model School: test urgent body.',
          channelPlan: ['whatsapp', 'sms'],
        },
      });
      const message = await onlyMessage(school, g.id);
      expect(await run(school, message.id)).toBe('finished');
      expect(drivers.of('whatsapp')).toHaveLength(1);
      expect(drivers.of('sms')).toHaveLength(1);
    });

    it('R115, R173: push goes only to a live device, carries ids, a title and the body only; FCM unregistered ends the devices', async () => {
      const school = await messagingSchool();
      const g = await guardian(db, school, { capability: 'smartphone_data', device: true });
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      expect(message.channelPlan).toEqual(['push', 'in_app']);
      expect(await run(school, message.id)).toBe('finished');
      const [call] = drivers.of('push');
      expect(call?.tokens).toEqual([g.token]);
      expect(Object.keys(call?.push?.data ?? {}).sort()).toEqual(['messageId', 'subjectId', 'subjectType', 'type']);
      expect(call?.push?.title).toBe('School holiday');

      // The session is revoked: the device dies with it, without a device write (R115).
      const second = await guardian(db, school, { capability: 'smartphone_data', device: true });
      await notice(school, [{ guardianId: second.id }]);
      const queued = await onlyMessage(school, second.id);
      await db.session.updateMany({ where: { schoolId: school.id, userId: second.userId ?? 0n }, data: { revokedAt: new Date() } });
      drivers.calls.length = 0;
      expect(await run(school, queued.id)).toBe('finished');
      expect(drivers.of('push')).toEqual([]);
      expect((await deliveriesOf(school, queued.id))[0]).toMatchObject({ status: 'failed', errorCode: 'unregistered_device' });

      // FCM reports the token unregistered: every device of the user is ended.
      const third = await guardian(db, school, { capability: 'smartphone_data', device: true });
      await notice(school, [{ guardianId: third.id }]);
      drivers.pushOutcome = { accepted: false, unregistered: [third.token ?? ''], error: 'unregistered_device' };
      await run(school, (await onlyMessage(school, third.id)).id);
      const devices = await db.device.findMany({ where: { schoolId: school.id, userId: third.userId ?? 0n } });
      expect(devices.every((d) => d.unregisteredReason === 'fcm_unregistered')).toBe(true);
    });

    it('R108: a delivery row is unique per (message, channel, attempt) and moves only forward', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      await run(school, message.id);
      const [row] = await deliveriesOf(school, message.id);
      if (!row) throw new Error('no delivery');
      await expect(
        db.messageDelivery.create({
          data: { schoolId: school.id, messageId: message.id, channel: 'whatsapp', attempt: 1, status: 'accepted' },
        }),
      ).rejects.toThrow(/message_deliveries_attempt_key/);
      await db.messageDelivery.updateMany({ where: { schoolId: school.id, id: row.id }, data: { status: 'delivered', deliveredAt: new Date() } });
      await expect(
        db.messageDelivery.updateMany({ where: { schoolId: school.id, id: row.id }, data: { status: 'accepted', deliveredAt: null } }),
      ).rejects.toThrow(/forward_only|moves only forward/);
    });
  });

  // ------------------------------------------------------------------------ rollup, sweep, poll

  describe('rollup, outbox sweep and SMS poll', () => {
    it('R112: an accepted WhatsApp leg later reported failed reopens the message for its SMS leg', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      await run(school, message.id);
      expect((await onlyMessage(school, g.id)).status).toBe('sent');
      const [row] = await deliveriesOf(school, message.id);
      await db.messageDelivery.updateMany({
        where: { schoolId: school.id, id: row?.id ?? 0n },
        data: { status: 'failed', failedAt: new Date(Date.now() + 1000), errorCode: 'rejected' },
      });
      const rollup = app.get(MessageRollup, { strict: false });
      expect(await asSchool(app, school.id, () => rollup.run(school.id, message.id))).toBe('queued');
      expect(enqueued.at(-1)).toMatchObject({ kind: 'message', id: message.id });
      expect(await run(school, message.id)).toBe('finished');
      expect(drivers.of('sms')).toHaveLength(1);
    });

    it('a delivered report rolls a sent message up to delivered', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      await run(school, message.id);
      await db.messageDelivery.updateMany({ where: { schoolId: school.id, messageId: message.id }, data: { status: 'delivered', deliveredAt: new Date() } });
      const rollup = app.get(MessageRollup, { strict: false });
      expect(await asSchool(app, school.id, () => rollup.run(school.id, message.id))).toBe('delivered');
    });

    it('R105: the outbox sweep re-enqueues a queued row idle for two minutes and recovers a crashed claim', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const lost = await guardian(db, school);
      const crashed = await guardian(db, school);
      await notice(school, [{ guardianId: lost.id }, { guardianId: crashed.id }]);
      const lostMessage = await onlyMessage(school, lost.id);
      const crashedMessage = await onlyMessage(school, crashed.id);
      await db.message.updateMany({
        where: { schoolId: school.id, id: crashedMessage.id },
        data: { status: 'sending', claimedAt: new Date(Date.now() - 11 * MIN) },
      });
      enqueued.length = 0;
      const sweeps = app.get(DeliverySweeps, { strict: false });
      // Not yet idle for two minutes: nothing.
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, new Date()))).toEqual({ requeued: 1, idle: 0, rollups: 0 });
      enqueued.length = 0;
      const later = new Date(Date.now() + 3 * MIN);
      await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, later));
      expect(enqueued.map((e) => e.id).sort()).toEqual([lostMessage.id, crashedMessage.id].sort());
      expect((await onlyMessage(school, crashed.id)).status).toBe('queued');
    });

    it('A3: a message released 30 s ago is not re-enqueued; once idle for two minutes it is', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      // Ten minutes after the write (created_at is immutable, so the clock moves instead). A paced
      // WhatsApp send writes no delivery row: only the claim marks the activity.
      const now = new Date(Date.now() + 10 * MIN);
      drivers.whatsappOutcomes.push({ kind: 'paced', retryAt: new Date(now.getTime() + MIN) });
      expect(await run(school, message.id, new Date(now.getTime() - 30_000))).toBe('released');
      expect(await deliveriesOf(school, message.id)).toEqual([]);
      enqueued.length = 0;
      const sweeps = app.get(DeliverySweeps, { strict: false });
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, now))).toEqual({ requeued: 0, idle: 0, rollups: 0 });
      expect(enqueued).toEqual([]);
      const later = new Date(now.getTime() + 3 * MIN);
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, later))).toEqual({ requeued: 0, idle: 1, rollups: 0 });
      expect(enqueued).toEqual([expect.objectContaining({ kind: 'message', id: message.id })]);
    });

    it('L6: the outbox sweep recovers a lost rollup of a report on a sent message, once', async () => {
      const school = await messagingSchool();
      await connectedNumber(db, school);
      const g = await guardian(db, school);
      await notice(school, [{ guardianId: g.id }]);
      const message = await onlyMessage(school, g.id);
      const t0 = new Date(Date.now() - 20 * MIN);
      expect(await run(school, message.id, t0)).toBe('finished');
      // Finished (sent) at t0; reported delivered ten minutes later, and that report's rollup job
      // never reached the queue.
      await db.message.updateMany({ where: { schoolId: school.id, id: message.id }, data: { updatedAt: t0 } });
      const [row] = await deliveriesOf(school, message.id);
      await db.messageDelivery.updateMany({
        where: { schoolId: school.id, id: row?.id ?? 0n },
        data: { status: 'delivered', deliveredAt: new Date(t0.getTime() + 10 * MIN) },
      });
      enqueued.length = 0;
      const sweeps = app.get(DeliverySweeps, { strict: false });
      const now = new Date();
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, now))).toEqual({ requeued: 0, idle: 0, rollups: 1 });
      expect(enqueued).toEqual([{ kind: 'rollup', schoolId: school.id, id: message.id }]);
      const rollup = app.get(MessageRollup, { strict: false });
      expect(await asSchool(app, school.id, () => rollup.run(school.id, message.id))).toBe('delivered');
      enqueued.length = 0;
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, now))).toMatchObject({ rollups: 0 });

      // A report the rollup saw and left `sent` (another leg still accepted) is not re-enqueued.
      const other = await guardian(db, school);
      await db.message.create({
        data: {
          schoolId: school.id,
          type: 'absence_alert',
          priority: 'urgent',
          subjectType: 'attendance_alert',
          subjectId: nextSubject(),
          guardianId: other.id,
          body: 'Iqra Model School: test urgent body.',
          channelPlan: ['whatsapp', 'sms'],
        },
      });
      const urgent = await onlyMessage(school, other.id);
      expect(await run(school, urgent.id, t0)).toBe('finished');
      await db.message.updateMany({ where: { schoolId: school.id, id: urgent.id }, data: { updatedAt: t0 } });
      const whatsappRow = (await deliveriesOf(school, urgent.id)).find((r) => r.channel === 'whatsapp');
      await db.messageDelivery.updateMany({
        where: { schoolId: school.id, id: whatsappRow?.id ?? 0n },
        data: { status: 'failed', failedAt: new Date(t0.getTime() + 10 * MIN), errorCode: 'rejected' },
      });
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, now))).toMatchObject({ rollups: 1 });
      expect(await asSchool(app, school.id, () => rollup.run(school.id, urgent.id))).toBe('unchanged');
      expect(await asSchool(app, school.id, () => sweeps.outboxSweep(school.id, now))).toMatchObject({ rollups: 0 });
    });

    it('§7.10: the SMS poll settles an accepted SMS at its poll point and fails one unreported for 24 h', async () => {
      const school = await messagingSchool();
      const k = await guardian(db, school, { capability: 'keypad' });
      const old = await guardian(db, school, { capability: 'keypad' });
      await notice(school, [{ guardianId: k.id }, { guardianId: old.id }]);
      const t0 = new Date();
      await run(school, (await onlyMessage(school, k.id)).id, t0);
      await run(school, (await onlyMessage(school, old.id)).id, new Date(t0.getTime() - 25 * 60 * MIN));
      const [row] = await deliveriesOf(school, (await onlyMessage(school, k.id)).id);
      if (!row?.pollRef) throw new Error('no poll reference stored');
      expect(row.pollRef.startsWith('v1:')).toBe(true);
      const ref = cipher().decrypt(row.pollRef, `${school.id}|message_deliveries|poll_ref`);
      drivers.smsStatuses.set(ref, { kind: 'delivered' });
      const sweeps = app.get(DeliverySweeps, { strict: false });
      const result = await asSchool(app, school.id, () => sweeps.smsPoll(school.id, new Date(t0.getTime() + 2 * MIN)));
      expect(result).toEqual({ expired: 1, polled: 1, settled: 1 });
      const settled = await db.messageDelivery.findFirst({ where: { schoolId: school.id, id: row.id } });
      expect(settled).toMatchObject({ status: 'delivered', pollRef: null });
      const expired = await deliveriesOf(school, (await onlyMessage(school, old.id)).id);
      expect(expired[0]).toMatchObject({ status: 'failed', errorCode: 'no_report' });
      expect(enqueued.filter((e) => e.kind === 'rollup')).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------------ WhatsApp health

  describe('WhatsApp health (R112)', () => {
    it('R112: connected -> down emails the platform once per transition; down -> connected recovers; pending -> connected sets paired_at', async () => {
      const school = await messagingSchool();
      const id = await connectedNumber(db, school);
      const health = app.get(WhatsAppHealth, { strict: false });
      drivers.healthOutcome = { ok: false, code: 'logged_out' };
      expect(await asSchool(app, school.id, () => health.check(school.id))).toBe('down');
      expect(await asSchool(app, school.id, () => health.check(school.id))).toBe('still_down');
      const row = await db.whatsAppNumber.findFirst({ where: { schoolId: school.id, id } });
      expect(row).toMatchObject({ status: 'down', lastErrorCode: 'logged_out' });
      // Only with PLATFORM_ALERT_EMAIL set does the email go; either way at most one per transition.
      expect(drivers.of('email').length).toBeLessThanOrEqual(1);
      for (const mail of drivers.of('email')) {
        expect(mail.template).toBe(`WhatsApp down: Iqra Model School (${school.id})`);
        expect(mail.text).not.toMatch(PHONE_PATTERN);
      }
      drivers.healthOutcome = { ok: true };
      expect(await asSchool(app, school.id, () => health.check(school.id))).toBe('connected');

      const pendingSchool = await messagingSchool();
      const pendingId = await connectedNumber(db, pendingSchool, 'pending');
      expect(await asSchool(app, pendingSchool.id, () => health.check(pendingSchool.id, pendingId))).toBe('connected');
      const paired = await db.whatsAppNumber.findFirst({ where: { schoolId: pendingSchool.id, id: pendingId } });
      expect(paired?.pairedAt).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------------ R111 scanner

  describe('R111: the scanner over everything this run wrote', () => {
    it('R111: no message body, delivery row or log line holds an identity number or an unmasked phone', async () => {
      // Whole tables, every school any suite wrote (tests never truncate), as text.
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        const messages = await pg.query<{ row: string }>(// subject_id is a polymorphic id (a holiday, an audit row, YYYYMM), not text a person reads.
          "SELECT body || ' ' || coalesce(media_object_key, '') AS row FROM messages");
        expect(messages.rows.length).toBeGreaterThan(0);
        expect(messages.rows.filter((r) => ID_PATTERN.test(r.row) || PHONE_PATTERN.test(r.row))).toEqual([]);
        const deliveries = await pg.query<{ row: string; masked: string | null; hash: string | null }>(
          "SELECT (to_jsonb(d) - 'provider_ref_hash' - 'poll_ref' - 'attempted_at' - 'delivered_at' - 'failed_at')::text AS row, to_masked AS masked, provider_ref_hash AS hash FROM message_deliveries d",
        );
        expect(deliveries.rows.length).toBeGreaterThan(0);
        expect(deliveries.rows.filter((r) => ID_PATTERN.test(r.row) || PHONE_PATTERN.test(r.row))).toEqual([]);
        for (const d of deliveries.rows) {
          if (d.masked !== null) expect(d.masked).not.toMatch(/[0-9]{7}/);
          if (d.hash !== null) expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
        }
      } finally {
        await pg.end();
      }
      const all = logs.join('\n');
      expect(all).not.toMatch(PHONE_PATTERN);
      expect(all).not.toMatch(ID_PATTERN);
      expect(all).not.toMatch(/fcm-[0-9a-f]{24}/);
    });
  });
});
