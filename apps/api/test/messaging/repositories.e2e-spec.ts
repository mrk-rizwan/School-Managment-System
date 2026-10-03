// Control 4 / R62 for the slice-9 repositories: a row written as school A is invisible to, and
// unwritable by, school B through every repository method that takes a SchoolId.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MessageDeliveryRepository } from '../../src/repositories/message-delivery.repository';
import { MessageRecipientRepository } from '../../src/repositories/message-recipient.repository';
import { MessageUsageRepository } from '../../src/repositories/message-usage.repository';
import { MessageRepository } from '../../src/repositories/message.repository';
import { SchoolMessagingRepository } from '../../src/repositories/school-messaging.repository';
import { SchoolSettingsRepository } from '../../src/repositories/school-settings.repository';
import { WhatsAppNumberRepository } from '../../src/repositories/whatsapp-number.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { closeTestDb, testDb, type TestSchool, type TwoSchools } from '../support/schools';
import { createGuardian } from '../support/students';
import { asSchool, connectedNumber, messagingApp, messagingSchool } from './support';

describe('slice 9 repositories: tenant isolation (R62)', () => {
  let app: NestExpressApplication;
  const db = testDb();

  beforeAll(async () => {
    ({ app } = await messagingApp());
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const two = async (): Promise<TwoSchools> => ({ a: await messagingSchool(), b: await messagingSchool() });
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);
  const school = (id: SchoolId): TestSchool => ({ id, shortCode: '' });

  async function message(schoolId: SchoolId): Promise<bigint> {
    const g = await createGuardian(db, school(schoolId));
    const row = await db.message.create({
      data: {
        schoolId,
        type: 'holiday_notice',
        priority: 'normal',
        subjectType: 'holiday',
        subjectId: 7n,
        guardianId: g.id,
        body: 'Iqra Model School: School closed Mon 9 Nov for Iqbal Day.',
        channelPlan: ['whatsapp'],
      },
    });
    return row.id;
  }

  it('MessageRepository: find, claim and withdraw see only the caller school', async () => {
    const schools = await two();
    const repo = app.get(MessageRepository, { strict: false });
    await expectIsolated(schools, {
      create: message,
      read: (schoolId, id) => as(schoolId, () => repo.find(schoolId, id)),
      write: async (schoolId, id) => ((await as(schoolId, () => repo.claim(schoolId, id, new Date()))) ? 1 : 0),
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    const id = await message(schools.a.id);
    expect(await as(schools.b.id, () => repo.withdrawQueuedForSubject(schools.b.id, 'holiday', 7n))).toBe(0);
    expect((await as(schools.a.id, () => repo.find(schools.a.id, id)))?.status).toBe('queued');
    expect(await as(schools.b.id, () => repo.recipientsNotWithdrawn(schools.b.id, 'holiday', 7n))).toEqual([]);
  });

  it('MessageDeliveryRepository: listForMessage and settle see only the caller school', async () => {
    const schools = await two();
    const repo = app.get(MessageDeliveryRepository, { strict: false });
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const messageId = await message(schoolId);
        return as(schoolId, () =>
          repo.insert(schoolId, {
            messageId,
            channel: 'sms',
            attempt: 1,
            status: 'accepted',
            providerRefHash: null,
            pollRef: null,
            toMasked: null,
            errorCode: null,
            suppressedReason: null,
            segments: 1,
            attemptedAt: new Date(),
          }),
        );
      },
      read: (schoolId, id) => db.messageDelivery.findFirst({ where: { schoolId, id } }),
      write: (schoolId, id) => as(schoolId, () => repo.settle(schoolId, id, 'delivered', null, new Date())),
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
  });

  it('MessageUsageRepository: a school counts and reads only its own usage', async () => {
    const { a, b } = await two();
    const repo = app.get(MessageUsageRepository, { strict: false });
    await as(a.id, () => repo.increment(a.id, '2026-10', 'push'));
    expect(await as(a.id, () => repo.reserveSms(a.id, '2026-10', 1, 1))).toBe(true);
    expect(await as(a.id, () => repo.reserveSms(a.id, '2026-10', 1, 1))).toBe(false);
    expect(await as(b.id, () => repo.forMonths(b.id, ['2026-10']))).toEqual([]);
    expect(await as(b.id, () => repo.smsUsed(b.id, '2026-10'))).toBe(0);
    expect(await as(a.id, () => repo.smsUsed(a.id, '2026-10'))).toBe(1);
  });

  it('WhatsAppNumberRepository: findById, findLive and recordHealth see only the caller school', async () => {
    const schools = await two();
    const repo = app.get(WhatsAppNumberRepository, { strict: false });
    await expectIsolated(schools, {
      create: (schoolId) => connectedNumber(db, school(schoolId)),
      read: (schoolId, id) => as(schoolId, () => repo.findById(schoolId, id)),
      write: (schoolId, id) => as(schoolId, () => repo.recordHealth(schoolId, id, 'connected', { status: 'down', lastErrorCode: 'unknown' })),
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    expect(await as(schools.b.id, () => repo.findLive(schools.b.id))).toBeNull();
  });

  it('MessageRecipientRepository and SchoolMessagingRepository: another school people and settings are invisible', async () => {
    const { a, b } = await two();
    const people = app.get(MessageRecipientRepository, { strict: false });
    const g = await createGuardian(db, a);
    expect(await as(b.id, () => people.guardians(b.id, [g.id]))).toEqual([]);
    expect(await as(a.id, () => people.guardians(a.id, [g.id]))).toHaveLength(1);
    const settings = app.get(SchoolMessagingRepository, { strict: false });
    await db.school.update({ where: { id: b.id }, data: { smsMonthlyCap: 3 } });
    expect((await as(a.id, () => settings.find(a.id)))?.smsMonthlyCap).toBe(500);
    expect((await as(b.id, () => settings.find(b.id)))?.smsMonthlyCap).toBe(3);

    // L2: the school_settings reads messaging and the calendar compose are the settings
    // repository's own, each scoped to the caller school.
    const schoolSettings = app.get(SchoolSettingsRepository, { strict: false });
    await db.schoolSettings.updateMany({
      where: { schoolId: b.id },
      data: { weeklyOffDays: [5, 0], studentLoginEnabled: true },
    });
    expect(await as(a.id, () => schoolSettings.weeklyOffDays(a.id))).toEqual([0]);
    expect(await as(b.id, () => schoolSettings.weeklyOffDays(b.id))).toEqual([0, 5]);
    expect(await as(a.id, () => schoolSettings.studentLoginEnabled(a.id))).toBe(false);
    expect(await as(b.id, () => schoolSettings.studentLoginEnabled(b.id))).toBe(true);
    expect((await as(a.id, () => settings.find(a.id)))?.studentLoginEnabled).toBe(false);
    expect((await as(b.id, () => settings.find(b.id)))?.studentLoginEnabled).toBe(true);
  });
});
