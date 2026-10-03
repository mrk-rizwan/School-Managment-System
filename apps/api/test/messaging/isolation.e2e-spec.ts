// Control 4 / R62 for the Phase 2 messaging tables (groundwork migration
// 20261003183118_phase2_messaging). No repository exists yet, so each probe drives the guarded
// client exactly as a tenant repository will: every read and write filters on school_id. Slice 9
// replaces the probes with its repositories' methods and keeps the titles. Each table also proves
// its composite foreign keys: a row in school B cannot name school A's parent row.
import { createHash } from 'node:crypto';
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, testDb, type TestSchool } from '../support/schools';
import { createGuardian } from '../support/students';

const db = () => testDb();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const school = (id: SchoolId): TestSchool => ({ id, shortCode: '' });

async function newMessage(schoolId: SchoolId): Promise<bigint> {
  const guardian = await createGuardian(db(), school(schoolId));
  const row = await db().message.create({
    data: {
      schoolId,
      type: 'absence_alert',
      priority: 'urgent',
      subjectType: 'attendance_alert',
      subjectId: 1n,
      guardianId: guardian.id,
      body: 'Test School: your child is absent today.',
      channelPlan: ['whatsapp', 'sms'],
    },
    select: { id: true },
  });
  return row.id;
}

describe('Phase 2 messaging tenant isolation', () => {
  afterAll(() => closeTestDb());

  it('whatsapp_numbers: a number written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await db().whatsAppNumber.create({
            data: { schoolId, phone: '+923001234567', provider: 'waha' },
            select: { id: true },
          })
        ).id,
      read: (schoolId, id) => db().whatsAppNumber.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().whatsAppNumber.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().whatsAppNumber.updateMany({
            where: { schoolId, id },
            data: { inboundIgnoredCount: 9 },
          })
        ).count,
      snapshot: (row) => (row as { inboundIgnoredCount: number } | null)?.inboundIgnoredCount,
    });
    // School B cannot record school A's user as the one who paired its number.
    const principalA = await createSchoolUser(db(), schools.a, { systemRole: 'principal' });
    await expect(
      db().whatsAppNumber.create({
        data: { schoolId: schools.b.id, phone: '+923001234568', provider: 'waha', pairedBy: principalA.userId },
      }),
    ).rejects.toThrow(/whatsapp_numbers_paired_by_fkey/);
  });

  it('devices: a device written for school A is invisible to school B and cannot name A’s session', async () => {
    const schools = await createTwoSchools();
    const device = async (schoolId: SchoolId) => {
      const user = await createSchoolUser(db(), school(schoolId), { systemRole: 'teacher' });
      const session = await createSchoolSession(db(), school(schoolId), user, { channel: 'bearer' });
      return { user, session };
    };
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const { user, session } = await device(schoolId);
        const row = await db().device.create({
          data: {
            schoolId,
            userId: user.userId,
            sessionId: session.sessionId,
            platform: 'android',
            pushToken: 'fcm-token-for-isolation',
            appVersion: '1.0.0',
          },
          select: { id: true },
        });
        return row.id;
      },
      read: (schoolId, id) => db().device.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().device.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().device.updateMany({ where: { schoolId, id }, data: { appVersion: '9.9.9' } }))
          .count,
      snapshot: (row) => (row as { appVersion: string } | null)?.appVersion,
    });
    const a = await device(schools.a.id);
    const b = await device(schools.b.id);
    await expect(
      db().device.create({
        data: {
          schoolId: schools.b.id,
          userId: b.user.userId,
          sessionId: a.session.sessionId,
          platform: 'android',
          pushToken: 'cross-tenant',
          appVersion: '1.0.0',
        },
      }),
    ).rejects.toThrow(/devices_session_id_fkey/);
  });

  it('messages: a message written for school A is invisible to school B and cannot name A’s guardian', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: newMessage,
      read: (schoolId, id) => db().message.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().message.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().message.updateMany({
            where: { schoolId, id },
            data: { status: 'suppressed', suppressedReason: 'not_allowed', finishedAt: new Date() },
          })
        ).count,
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    const guardianA = await createGuardian(db(), schools.a);
    await expect(
      db().message.create({
        data: {
          schoolId: schools.b.id,
          type: 'absence_alert',
          priority: 'urgent',
          subjectType: 'attendance_alert',
          subjectId: 1n,
          guardianId: guardianA.id,
          body: 'Cross-tenant',
          channelPlan: ['sms'],
        },
      }),
    ).rejects.toThrow(/messages_guardian_id_fkey/);
  });

  it('message_deliveries: a delivery written for school A is invisible to school B and cannot name A’s message', async () => {
    const schools = await createTwoSchools();
    let attempt = 0;
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await db().messageDelivery.create({
            data: {
              schoolId,
              messageId: await newMessage(schoolId),
              channel: 'whatsapp',
              attempt: ++attempt,
              status: 'accepted',
              providerRefHash: hash(`whatsapp|isolation-${attempt}-${Date.now()}`),
            },
            select: { id: true },
          })
        ).id,
      read: (schoolId, id) => db().messageDelivery.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().messageDelivery.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().messageDelivery.updateMany({
            where: { schoolId, id },
            data: { status: 'delivered', deliveredAt: new Date() },
          })
        ).count,
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    const messageA = await newMessage(schools.a.id);
    await expect(
      db().messageDelivery.create({
        data: { schoolId: schools.b.id, messageId: messageA, channel: 'sms', attempt: 1, status: 'accepted' },
      }),
    ).rejects.toThrow(/message_deliveries_message_id_fkey/);
  });

  it('message_usage: a usage row written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await db().messageUsage.create({
            data: { schoolId, yearMonth: '2026-10', channel: 'sms', sentCount: 3 },
            select: { id: true },
          })
        ).id,
      read: (schoolId, id) => db().messageUsage.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().messageUsage.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().messageUsage.updateMany({
            where: { schoolId, id },
            data: { sentCount: { increment: 100 } },
          })
        ).count,
      snapshot: (row) => (row as { sentCount: number } | null)?.sentCount,
    });
  });

  it('platform_delivery_health: a non-tenant rollup, one row per school, day and channel (named exception 6)', async () => {
    // The platform reads it without a SchoolId: the query guard treats it as non-tenant, so a read
    // with no school_id runs (on a tenant model the guard would throw).
    await expect(
      db().platformDeliveryHealth.findMany({ where: { day: new Date('2000-01-01T00:00:00Z') } }),
    ).resolves.toEqual([]);
    const a = await createSchool();
    const b = await createSchool();
    const row = (schoolId: bigint, failed: number) => ({
      schoolId,
      day: new Date('2026-10-03T00:00:00Z'),
      channel: 'sms' as const,
      failed,
      smsCap: 500,
      computedAt: new Date(),
    });
    await db().platformDeliveryHealth.create({ data: row(a.id, 1) });
    await db().platformDeliveryHealth.create({ data: row(b.id, 2) });
    // The same day and channel for another school is its own row, never the first school's.
    const rows = await db().platformDeliveryHealth.findMany({
      where: { schoolId: { in: [a.id, b.id] } },
      select: { schoolId: true, failed: true },
      orderBy: { schoolId: 'asc' },
    });
    expect(rows).toEqual([
      { schoolId: a.id, failed: 1 },
      { schoolId: b.id, failed: 2 },
    ]);
    await expect(db().platformDeliveryHealth.create({ data: row(a.id, 3) })).rejects.toThrow(
      /platform_delivery_health_school_id_day_channel_key|Unique constraint/,
    );
  });
});
