// Control 4 / R62 for the slice-14 tables (migration 20261004150100_slice14_announcements), through
// their repositories, and the raw SQL each repository runs (eslint RAW_SQL_FILES): the delivery
// counts and the inbox's join. Composite foreign keys refuse
// a cross-school parent at the database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AnnouncementAudienceRepository } from '../../src/repositories/announcement-audience.repository';
import { AnnouncementRecipientRepository } from '../../src/repositories/announcement-recipient.repository';
import { AnnouncementRepository } from '../../src/repositories/announcement.repository';
import { InboxRepository } from '../../src/repositories/inbox.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated, studentsScope } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createGuardian, createStudent, linkGuardian } from '../support/students';

const db = () => testDb();
const noStudents = studentsScope([]);

describe('slice 14 tenant isolation', () => {
  let app: NestExpressApplication;
  let announcements: AnnouncementRepository;
  let audiences: AnnouncementAudienceRepository;
  let recipients: AnnouncementRecipientRepository;
  let inbox: InboxRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    announcements = app.get(AnnouncementRepository, { strict: false });
    audiences = app.get(AnnouncementAudienceRepository, { strict: false });
    recipients = app.get(AnnouncementRecipientRepository, { strict: false });
    inbox = app.get(InboxRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** An announcement owned by `schoolId`, its creator a principal there. */
  async function seed(schoolId: SchoolId) {
    const school = { id: schoolId, shortCode: '' };
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const student = await createStudent(db(), school);
    const guardian = await createGuardian(db(), school);
    await linkGuardian(db(), school, student, guardian);
    const row = await as(schoolId, () =>
      announcements.create(schoolId, {
        title: 'Closed',
        body: 'Rain',
        category: 'general',
        priority: 'normal',
        status: 'draft',
        scheduledAt: null,
        expiresOn: null,
        attachment: null,
        holidayId: null,
        createdBy: principal.userId,
      }),
    );
    return { row, principal, student, guardian };
  }

  it('announcements: read, list, update, delivery counts and the sweep source see only their own school', async () => {
    const two = await createTwoSchools();
    let seeded: Awaited<ReturnType<typeof seed>> | undefined;
    await expectIsolated(two, {
      create: async (schoolId) => {
        seeded = await seed(schoolId);
        return seeded.row.id;
      },
      read: (schoolId, id) => as(schoolId, () => announcements.findById(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => announcements.list(schoolId, { sort: '-createdAt', skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        await as(schoolId, () => announcements.update(schoolId, id, { title: 'Hijacked' }, new Date()));
        return 1;
      },
      snapshot: (row) => (row as { title: string }).title,
    });
    const id = seeded?.row.id ?? 0n;
    expect(await as(two.b.id, () => announcements.lockIfUnchanged(two.b.id, { id, updatedAt: new Date() }))).toBe(false);
    expect(await as(two.b.id, () => announcements.claimForSend(two.b.id, id, new Date(), new Date()))).toBeNull();
    expect(await as(two.b.id, () => announcements.countSendFailure(two.b.id, id, new Date()))).toBeNull();
    expect(await as(two.b.id, () => announcements.isWithdrawnHolidayNotice(two.b.id, { id, holidayId: null }))).toBe(false);
    expect((await as(two.b.id, () => announcements.deliveryCounts(two.b.id, id))).byChannel).toEqual([]);
    await db().announcement.updateMany({ where: { schoolId: two.a.id, id }, data: { status: 'scheduled', scheduledAt: new Date(Date.now() - 120_000) } });
    expect(await as(two.b.id, () => announcements.listOverdueSends(two.b.id, new Date(), 10))).toEqual([]);
    expect((await as(two.a.id, () => announcements.listOverdueSends(two.a.id, new Date(), 10))).map((r) => r.id)).toEqual([id]);
  });

  it('announcement_audiences: rows are read and replaced per school; a cross-school parent is refused', async () => {
    const two = await createTwoSchools();
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { row } = await seed(schoolId);
        await as(schoolId, () => audiences.replace(schoolId, row.id, [{ kind: 'everyone', targetId: null, roles: ['parents', 'students'] }]));
        return row.id;
      },
      read: async (schoolId, id) => {
        const rows = await as(schoolId, () => audiences.forAnnouncements(schoolId, [id]));
        return rows.length === 0 ? null : rows;
      },
      write: async (schoolId, id) => {
        await as(schoolId, () => audiences.replace(schoolId, id, [{ kind: 'parents', targetId: null, roles: ['parents'] }]));
        return 1;
      },
      snapshot: (rows) => (rows as { kind: string }[]).map((r) => r.kind),
    });
    const { a, b } = two;
    const { row } = await seed(a.id);
    await expect(
      db().announcementAudience.create({ data: { schoolId: b.id, announcementId: row.id, kind: 'everyone' } }),
    ).rejects.toThrow();
  });

  it('announcement_recipients: insert, counts and the message_id back-fill are per school', async () => {
    const two = await createTwoSchools();
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { row, guardian, student } = await seed(schoolId);
        await as(schoolId, () => recipients.insert(schoolId, row.id, [{ person: { guardianId: guardian.id }, studentIds: [student.id], messageId: null }]));
        return row.id;
      },
      read: async (schoolId, id) => {
        const counts = await as(schoolId, () => recipients.counts(schoolId, id));
        return counts.total === 0 ? null : counts;
      },
      // Recording a person of another school under this announcement is refused (composite FK).
      write: async (schoolId, id) => {
        const stranger = await createGuardian(db(), { id: schoolId, shortCode: '' });
        return as(schoolId, () => recipients.insert(schoolId, id, [{ person: { guardianId: stranger.id }, studentIds: [], messageId: null }]));
      },
      snapshot: (counts) => counts,
    });
    const { a, b } = two;
    const { row } = await seed(a.id);
    const other = await createGuardian(db(), b);
    await expect(
      db().announcementRecipient.create({ data: { schoolId: b.id, announcementId: row.id, guardianId: other.id } }),
    ).rejects.toThrow();
    await expect(
      db().announcementRecipient.create({ data: { schoolId: a.id, announcementId: row.id, guardianId: other.id } }),
    ).rejects.toThrow();
  });

  it('announcement_recipient_students: viaStudents reads only the own school\'s rows', async () => {
    const two = await createTwoSchools();
    let seeded: Awaited<ReturnType<typeof seed>> | undefined;
    await expectIsolated(two, {
      create: async (schoolId) => {
        seeded = await seed(schoolId);
        const { row, guardian, student } = seeded;
        await as(schoolId, () => recipients.insert(schoolId, row.id, [{ person: { guardianId: guardian.id }, studentIds: [student.id], messageId: null }]));
        return row.id;
      },
      read: async (schoolId, id) => {
        const s = seeded!;
        const found = await as(schoolId, () => recipients.studentsForGuardian(schoolId, s.guardian.id, [id], [s.student.id]));
        return found.size === 0 ? null : found;
      },
    });
    const { a, b } = two;
    const { row, guardian } = await seed(a.id);
    await as(a.id, () => recipients.insert(a.id, row.id, [{ person: { guardianId: guardian.id }, studentIds: [], messageId: null }]));
    const [recipient] = await db().announcementRecipient.findMany({ where: { schoolId: a.id, announcementId: row.id } });
    const otherStudent = await createStudent(db(), b);
    await expect(
      db().announcementRecipientStudent.create({ data: { schoolId: b.id, announcementRecipientId: recipient?.id ?? 0n, studentId: otherStudent.id } }),
    ).rejects.toThrow();
  });

  it('messages: the inbox join answers only the own school\'s messages for its persons', async () => {
    const two = await createTwoSchools();
    let guardianId = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { guardian } = await seed(schoolId);
        guardianId = guardian.id;
        const message = await db().message.create({
          data: { schoolId, type: 'holiday_notice', priority: 'normal', subjectType: 'holiday', subjectId: 1n, guardianId, body: 'Closed', channelPlan: [], status: 'sent', finishedAt: new Date() },
        });
        return message.id;
      },
      read: (schoolId, id) => as(schoolId, () => inbox.find(schoolId, { guardianId, guardianScope: noStudents, staffId: null, studentId: null }, new Date(), id)),
      list: async (schoolId) =>
        (await as(schoolId, () => inbox.list(schoolId, { guardianId, guardianScope: noStudents, staffId: null, studentId: null }, new Date(), {}, { skip: 0, take: 50 }))).rows,
    });
  });
});
