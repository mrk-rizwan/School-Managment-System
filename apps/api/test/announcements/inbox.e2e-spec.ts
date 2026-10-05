// The inbox and attachments (contracts/slice-14.md §5.10, §7, §8; R147, R148, R163-R166): messages
// addressed to the caller's persons, resolved at read time; expiry; viaStudents; recipient-only
// attachments sent as bytes on WhatsApp and "see the app" on SMS; MeDto.capabilityScopes.
import request from 'supertest';
import { addDays, SchoolClock } from '../../src/common/school-clock';
import { ObjectStorage } from '../../src/common/storage/object-storage';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { png, pdf } from '../documents/fixtures';
import { asSchool, connectedNumber } from '../messaging/support';
import { ORIGIN } from '../staff/support';
import { createSchoolSession, randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createGuardian, createSubject, day, isoDay, linkGuardian } from '../support/students';
import { AnnouncementHarness, announcement, campus, type Announcement, type Campus } from './support';

const UNUSABLE = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g';

interface Item {
  id: string;
  kind: string;
  messageType: string;
  subjectType: string;
  subjectId: string;
  title: string;
  body: string;
  category: string | null;
  priority: string;
  expiresOn: string | null;
  hasAttachment: boolean;
  attachmentMime: string | null;
  announcementId: string | null;
  viaStudents: { studentId: string; fullName: string }[];
}
interface Page<T> {
  data: T[];
  total: number;
}

describe('announcements: inbox and attachments (e2e)', () => {
  const h = new AnnouncementHarness();
  const db = h.db;

  beforeAll(() => h.start());
  afterEach(() => {
    jest.restoreAllMocks();
    h.drivers.calls.length = 0;
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  /** A draft sent now: the request answers `sending`, the job it enqueued writes the messages. */
  async function sent(c: Campus, body: object, cookie = c.principal.cookie): Promise<Announcement> {
    const draft = await h.draft(body, cookie);
    return h.sendAndDeliver(c.school.id, draft.id, cookie);
  }
  /** A login for a person (written straight to the database) and its cookie session. */
  async function signIn(c: Campus, link: { guardianId?: bigint; studentId?: bigint; staffId?: bigint }) {
    const user = await db.user.create({
      data: { schoolId: c.school.id, usernameHash: testIdentityHash(randomIdentityDigits()), passwordHash: UNUSABLE, ...link },
    });
    return (await createSchoolSession(db, c.school, { userId: user.id })).cookie;
  }
  const inbox = async (cookie: string, query = ''): Promise<Item[]> => {
    const res = await h.read(`/me/inbox${query}`, cookie);
    if (res.status !== 200) throw new Error(`inbox answered ${res.status}: ${res.text}`);
    return (res.body as Page<Item>).data;
  };
  const stage = async (body: Buffer, cookie: string): Promise<string> => {
    const res = await request(h.app.getHttpServer())
      .post('/api/v1/uploads')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .attach('file', body, 'file.bin');
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };
  const download = (path: string, cookie: string) =>
    request(h.app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookie).responseType('blob');

  it('the inbox: a guardian issued a login after the send sees it; viaStudents names only the scope\'s children', async () => {
    const c = await campus(h);
    const a = await sent(c, announcement([{ kind: 'class', targetId: String(c.klass.id) }], { category: 'event' }));
    // The login is created after the message was written: the inbox resolves by person.
    const cookie = await signIn(c, { guardianId: c.parent.id });
    const [item] = await inbox(cookie);
    expect(item).toEqual({
      id: expect.stringMatching(/^[1-9][0-9]*$/),
      kind: 'announcement',
      messageType: 'announcement_normal',
      subjectType: 'announcement',
      subjectId: a.id,
      title: 'Sports day on Friday',
      body: 'Children come in sports kit.\nPick-up is at 1 pm.',
      category: 'event',
      priority: 'normal',
      sentAt: expect.any(String),
      expiresOn: null,
      hasAttachment: false,
      attachmentMime: null,
      announcementId: a.id,
      // Omar's link has can_login = false: outside the guardian scope, never named (R165).
      viaStudents: [
        { studentId: String(c.kids[0]?.id), fullName: 'Zara Khan' },
        { studentId: String(c.kids[1]?.id), fullName: 'Ali Khan' },
      ].sort((x, y) => (BigInt(x.studentId) < BigInt(y.studentId) ? -1 : 1)),
    });
    expect((await h.read(`/me/inbox/${item?.id}`, cookie)).body).toEqual(item);
    // An ended link drops the child's name on the next request (R164).
    await db.studentGuardian.updateMany({
      where: { schoolId: c.school.id, guardianId: c.parent.id, studentId: c.kids[0]!.id },
      data: { endedAt: new Date() },
    });
    expect((await inbox(cookie))[0]?.viaStudents.map((v) => v.fullName)).toEqual(['Ali Khan']);
    // Another guardian sees only their own item; another school's caller sees nothing.
    const other = await campus(h);
    const otherCookie = await signIn(other, { guardianId: other.parent.id });
    expect(await inbox(otherCookie)).toEqual([]);
    expect((await h.read(`/me/inbox/${item?.id}`, otherCookie)).status).toBe(404);
  });

  it('R164 (Phase 2 close): an ended link hides the guardian\'s earlier notices about that child, on the list, the item and both attachment routes; a co-guardian still linked keeps them; announcements stay', async () => {
    const c = await campus(h);
    const [zara, ali] = [c.kids[0]!, c.kids[1]!];
    const coGuardian = await createGuardian(db, c.school, { fullName: 'Kamran Khan' });
    await linkGuardian(db, c.school, zara, coGuardian, { isPrimaryContact: false, isFeePayer: false, canLogin: true });
    const enrolmentOf = async (studentId: bigint) =>
      (await db.enrolment.findFirstOrThrow({ where: { schoolId: c.school.id, studentId } })).id;
    const date = day(isoDay(-1));
    const alert = await db.attendanceAlert.create({
      data: { schoolId: c.school.id, enrolmentId: await enrolmentOf(zara.id), studentId: zara.id, date, kind: 'absence', dueAt: new Date() },
    });
    const remarkOf = async (studentId: bigint) =>
      db.remark.create({
        data: {
          schoolId: c.school.id, enrolmentId: await enrolmentOf(studentId), studentId, authorStaffId: c.teacher.staffId,
          date, category: 'homework', text: 'Homework not done.', visibility: 'guardian',
        },
      });
    const [zaraRemark, aliRemark] = [await remarkOf(zara.id), await remarkOf(ali.id)];
    const entry = await db.diaryEntry.create({
      data: {
        schoolId: c.school.id, sectionId: c.sectionA.id, classId: c.sectionA.classId, academicYearId: c.sectionA.academicYearId,
        date, subjectId: (await createSubject(db, c.school)).id, authorStaffId: c.teacher.staffId, topic: 'Fractions',
      },
    });
    // The announcement carries an attachment, so the attachment routes have a file to refuse.
    const notice = await h.sendAndDeliver(
      c.school.id,
      (await h.draft(announcement([{ kind: 'parents' }], { stagedUploadId: await stage(await png(64, 64), c.principal.cookie) }), c.principal.cookie)).id,
      c.principal.cookie,
    );
    const message = (guardianId: bigint, type: 'absence_alert' | 'remark_posted' | 'diary_posted', subjectType: 'attendance_alert' | 'remark' | 'diary_entry', subjectId: bigint) =>
      ({ schoolId: c.school.id, type, priority: 'normal' as const, subjectType, subjectId, guardianId, body: 'About Zara', channelPlan: [], status: 'sent' as const, finishedAt: new Date() });
    for (const g of [c.parent.id, coGuardian.id]) {
      await db.message.createMany({
        data: [
          message(g, 'absence_alert', 'attendance_alert', alert.id),
          message(g, 'remark_posted', 'remark', zaraRemark.id),
          message(g, 'diary_posted', 'diary_entry', entry.id),
        ],
      });
    }
    await db.message.create({ data: message(c.parent.id, 'remark_posted', 'remark', aliRemark.id) });
    const cookie = await signIn(c, { guardianId: c.parent.id });
    const coCookie = await signIn(c, { guardianId: coGuardian.id });
    const subjects = (items: Item[]) => items.map((i) => `${i.subjectType}:${i.subjectId}`).sort();
    const all = [`attendance_alert:${alert.id}`, `diary_entry:${entry.id}`, `remark:${zaraRemark.id}`];
    expect(subjects(await inbox(cookie))).toEqual([...all, `remark:${aliRemark.id}`, `announcement:${notice.id}`].sort());

    // The office ends the parent's link to Zara.
    await db.studentGuardian.updateMany({
      where: { schoolId: c.school.id, guardianId: c.parent.id, studentId: zara.id },
      data: { endedAt: new Date() },
    });
    const after = await inbox(cookie);
    // The diary entry stays: Ali is in section A on its date too, so it is still about a child in scope.
    expect(subjects(after)).toEqual([`diary_entry:${entry.id}`, `remark:${aliRemark.id}`, `announcement:${notice.id}`].sort());
    expect(after.find((i) => i.subjectType === 'diary_entry')?.viaStudents.map((v) => v.fullName)).toEqual(['Ali Khan']);
    expect((await h.read('/me/inbox', cookie)).body).toMatchObject({ total: 3 });
    const hidden = await db.message.findMany({
      where: { schoolId: c.school.id, guardianId: c.parent.id, subjectId: { in: [alert.id, zaraRemark.id] } },
    });
    expect(hidden).toHaveLength(2);
    for (const m of hidden) {
      expect((await h.read(`/me/inbox/${m.id}`, cookie)).status).toBe(404);
      expect((await download(`/me/inbox/${m.id}/attachment`, cookie)).status).toBe(404);
      expect((await download(`/me/inbox/${m.id}/thumbnail`, cookie)).status).toBe(404);
    }
    // The announcement and its attachment stay visible.
    const kept = after.find((i) => i.subjectType === 'announcement');
    expect((await download(`/me/inbox/${kept?.id}/attachment`, cookie)).status).toBe(200);
    // The co-guardian still linked to Zara keeps every row about her.
    expect(subjects(await inbox(coCookie))).toEqual([...all, `announcement:${notice.id}`].sort());
    const coAlert = await db.message.findFirstOrThrow({ where: { schoolId: c.school.id, guardianId: coGuardian.id, subjectId: alert.id } });
    expect((await h.read(`/me/inbox/${coAlert.id}`, coCookie)).status).toBe(200);

    // Ending the last link to section A's children hides the diary entry as well.
    await db.studentGuardian.updateMany({
      where: { schoolId: c.school.id, guardianId: c.parent.id, studentId: ali.id },
      data: { endedAt: new Date() },
    });
    expect(subjects(await inbox(cookie))).toEqual([`announcement:${notice.id}`]);
  });

  it('the inbox predicate: no messaging test, no withdrawn notice; a suppressed no_channel message is in; a staff-guardian sees one row', async () => {
    const c = await campus(h);
    const staffParent = await h.caller(c.school, 'teacher', 'Teacher Parent');
    await db.user.updateMany({ where: { schoolId: c.school.id, staffId: staffParent.staffId }, data: { guardianId: c.parentB.id } });
    const a = await sent(c, announcement([{ kind: 'everyone' }]));
    const items = await inbox(staffParent.cookie);
    expect(items.map((i) => i.announcementId)).toEqual([a.id]);
    // One row for the person: written to the guardian (dedupe by login), none to the staff record;
    // with no external leg it is finished at once and is in the inbox all the same.
    const message = await db.message.findFirst({ where: { schoolId: c.school.id, guardianId: c.parentB.id, subjectId: BigInt(a.id) } });
    expect([message?.status, message?.channelPlan]).toEqual(['sent', ['in_app']]);
    expect(await db.message.count({ where: { schoolId: c.school.id, staffId: staffParent.staffId, subjectId: BigInt(a.id) } })).toBe(0);
    // A messaging test and a withdrawn notice are not inbox items.
    await db.message.createMany({
      data: [
        { schoolId: c.school.id, type: 'messaging_test', priority: 'normal', subjectType: 'messaging_test', subjectId: 1n, staffId: staffParent.staffId, body: 'Test', channelPlan: [], status: 'sent', finishedAt: new Date() },
        { schoolId: c.school.id, type: 'holiday_notice', priority: 'normal', subjectType: 'holiday', subjectId: 1n, guardianId: c.parentB.id, body: 'Closed', channelPlan: [], status: 'suppressed', suppressedReason: 'subject_cancelled', finishedAt: new Date() },
        { schoolId: c.school.id, type: 'holiday_notice', priority: 'normal', subjectType: 'holiday', subjectId: 2n, guardianId: c.parentB.id, body: 'Iqra: School closed.', channelPlan: [], status: 'sent', finishedAt: new Date() },
      ],
    });
    const after = await inbox(staffParent.cookie);
    expect(after.map((i) => [i.kind, i.subjectType, i.title])).toEqual([
      ['notice', 'holiday', 'School holiday'],
      ['announcement', 'announcement', 'Sports day on Friday'],
    ]);
    expect((await inbox(staffParent.cookie, '?kind=notice')).map((i) => i.subjectType)).toEqual(['holiday']);
    expect((await inbox(staffParent.cookie, '?category=event')).map((i) => i.announcementId)).toEqual([a.id]);
    expect((await h.read('/me/inbox?sort=sentAt', staffParent.cookie)).status).toBe(422);
  });

  it('R147: an expired announcement leaves every inbox the day after expiresOn and stays on the school\'s list', async () => {
    const c = await campus(h);
    const a = await sent(c, announcement([{ kind: 'parents' }], { expiresOn: isoDay() }));
    const cookie = await signIn(c, { guardianId: c.parent.id });
    const [item] = await inbox(cookie);
    expect(item?.expiresOn).toBe(isoDay());
    jest.spyOn(SchoolClock.prototype, 'now').mockReturnValue(addDays(new Date(), 1));
    expect(await inbox(cookie)).toEqual([]);
    expect((await h.read(`/me/inbox/${item?.id}`, cookie)).status).toBe(404);
    expect(((await h.read('/announcements', c.principal.cookie)).body as Page<Announcement>).data.map((x) => x.id)).toEqual([a.id]);
  });

  it('R148: an attachment is read from storage once for a whole fan-out, not once per recipient', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    for (let i = 0; i < 3; i++) {
      const g = await createGuardian(db, c.school, { contactCapability: 'whatsapp' });
      await linkGuardian(db, c.school, c.childB, g, { isPrimaryContact: false, isFeePayer: false });
    }
    const draft = await h.draft(
      announcement([{ kind: 'student', targetId: String(c.childB.id), roles: ['parents'] }], {
        stagedUploadId: await stage(pdf(), c.principal.cookie),
      }),
      c.principal.cookie,
    );
    const a = await h.sendAndDeliver(c.school.id, draft.id, c.principal.cookie);
    const row = await db.announcement.findFirst({ where: { schoolId: c.school.id, id: BigInt(a.id) } });
    const reads = jest.spyOn(h.app.get(ObjectStorage, { strict: false }), 'get');
    const processor = h.app.get(MessageProcessor, { strict: false });
    for (const m of await db.message.findMany({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(a.id) } })) {
      await asSchool(h.app, c.school.id, () => processor.run(c.school.id, m.id));
    }
    expect(h.drivers.of('whatsapp').filter((call) => call.media?.mime === 'application/pdf')).toHaveLength(4);
    expect(reads.mock.calls.filter(([key]) => key === row?.attachmentObjectKey)).toHaveLength(1);
  });

  it('R148: one attachment, sent as bytes on WhatsApp and as "see the app" on SMS; streamed only to recipients and the sender', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    const keypad = await createGuardian(db, c.school, { contactCapability: 'keypad' });
    await linkGuardian(db, c.school, c.kids[0]!, keypad, { isPrimaryContact: false, isFeePayer: false });
    const image = await png(64, 64);
    const draft = await h.draft(
      announcement([{ kind: 'student', targetId: String(c.kids[0]?.id), roles: ['parents'] }], {
        priority: 'urgent',
        stagedUploadId: await stage(image, c.principal.cookie),
      }),
      c.principal.cookie,
    );
    expect(draft).toMatchObject({ hasAttachment: true, attachmentMime: 'image/png' });
    const a = await h.sendAndDeliver(c.school.id, draft.id, c.principal.cookie);
    const processor = h.app.get(MessageProcessor, { strict: false });
    for (const m of await db.message.findMany({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(a.id) } })) {
      expect(m.body).not.toMatch(/https?:/); // never a URL
      await asSchool(h.app, c.school.id, () => processor.run(c.school.id, m.id));
    }
    const whatsapp = h.drivers.of('whatsapp');
    expect(whatsapp).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Sports day on Friday'),
        media: { mime: 'image/png', filename: `announcement-${a.id}.png`, size: expect.any(Number) },
      }),
    ]);
    const sms = h.drivers.of('sms');
    expect(sms.length).toBeGreaterThan(0);
    for (const call of sms) expect(call.text).toMatch(/\nAttachment: open the app to view it\.$/);

    const parentCookie = await signIn(c, { guardianId: c.parent.id });
    const [item] = await inbox(parentCookie);
    expect(item).toMatchObject({ hasAttachment: true, attachmentMime: 'image/png' });
    const file = await download(`/me/inbox/${item?.id}/attachment`, parentCookie);
    expect([file.status, file.headers['content-type'], file.headers['content-disposition']]).toEqual([
      200,
      'image/png',
      `attachment; filename="announcement-${a.id}.png"`,
    ]);
    expect((await download(`/me/inbox/${item?.id}/thumbnail`, parentCookie)).headers['content-type']).toBe('image/jpeg');
    // A non-recipient (another guardian, here of another child) gets 404 on the same message id.
    const outsider = await signIn(c, { guardianId: c.parentB.id });
    expect((await download(`/me/inbox/${item?.id}/attachment`, outsider)).status).toBe(404);
    // The sender's copy.
    expect((await download(`/announcements/${a.id}/attachment`, c.principal.cookie)).status).toBe(200);

    // A PDF has no thumbnail; an announcement without an attachment has no file.
    const doc = await sent(c, announcement([{ kind: 'parents' }], { stagedUploadId: await stage(pdf(), c.principal.cookie) }));
    expect((await download(`/announcements/${doc.id}/thumbnail`, c.principal.cookie)).status).toBe(404);
    expect((await download(`/announcements/${doc.id}/attachment`, c.principal.cookie)).headers['content-type']).toBe('application/pdf');
    const plain = await sent(c, announcement([{ kind: 'parents' }]));
    expect((await download(`/announcements/${plain.id}/attachment`, c.principal.cookie)).status).toBe(404);
    // A staged upload is consumed once.
    const used = await db.announcement.findFirst({ where: { schoolId: c.school.id, id: BigInt(a.id) } });
    const staged = await db.stagedUpload.findFirst({ where: { schoolId: c.school.id, objectKey: used?.attachmentObjectKey ?? '' } });
    expect((await h.create(announcement([{ kind: 'parents' }], { stagedUploadId: String(staged?.id) }), c.principal.cookie)).status).toBe(422);
  });

  it('a student with a login reads their own messages; a staff member their own', async () => {
    const c = await campus(h);
    const studentCookie = await signIn(c, { studentId: c.kids[0]!.id });
    const a = await sent(c, announcement([{ kind: 'students' }]));
    expect((await inbox(studentCookie)).map((i) => [i.announcementId, i.viaStudents])).toEqual([[a.id, []]]);
    const b = await sent(c, announcement([{ kind: 'staff' }]));
    expect((await inbox(c.teacher.cookie)).map((i) => i.announcementId)).toEqual([b.id]);
  });

  it('R165: an inbox item carries no other student, guardian name, phone, staff phone or identity field', async () => {
    const c = await campus(h);
    await sent(c, announcement([{ kind: 'parents' }]));
    const res = await h.read('/me/inbox', await signIn(c, { guardianId: c.parent.id }));
    const item = (res.body as Page<Item>).data[0];
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'announcementId', 'attachmentMime', 'body', 'category', 'expiresOn', 'hasAttachment', 'id', 'kind',
        'messageType', 'priority', 'sentAt', 'subjectId', 'subjectType', 'title', 'viaStudents',
      ].sort(),
    );
    for (const secret of ['Sana Khan', 'Bilal Malik', 'Hira Malik', '+92', 'Omar Khan']) expect(res.text).not.toContain(secret);
  });

  it('§8: MeDto.capabilityScopes is parallel to capabilities; a grant shows all; a guardian-only session has none', async () => {
    const c = await campus(h);
    type Me = { capabilities: string[]; capabilityScopes: { capability: string; scope: string }[] };
    const me = async (cookie: string) => (await h.read('/me', cookie)).body as Me;
    const principal = await me(c.principal.cookie);
    expect(principal.capabilityScopes.map((s) => s.capability)).toEqual(principal.capabilities);
    expect(new Set(principal.capabilityScopes.map((s) => s.scope))).toEqual(new Set(['all']));
    await db.userCapabilityGrant.create({
      data: { schoolId: c.school.id, userId: c.teacher.userId, capabilityKey: 'diary.write', effect: 'grant', grantedBy: c.principal.userId, reason: 'Head of diary' },
    });
    const teacher = await me(c.teacher.cookie);
    expect(teacher.capabilityScopes.map((s) => s.capability)).toEqual(teacher.capabilities);
    expect(teacher.capabilityScopes.find((s) => s.capability === 'diary.write')?.scope).toBe('all');
    expect(teacher.capabilityScopes.find((s) => s.capability === 'announcement.send.scope')?.scope).toBe('assigned_sections');
    expect((await me(await signIn(c, { guardianId: c.parent.id }))).capabilityScopes).toEqual([]);
  });

  it('R166: preview has its own per-user bucket (30 a minute); the inbox reads are not spent by it', async () => {
    const c = await campus(h);
    const cookie = await signIn(c, { guardianId: c.parent.id });
    // The preview bucket refuses the 31st request in a minute.
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await h.post('/announcements/preview-audience', { audiences: [{ kind: 'parents' }], priority: 'normal' }, c.principal.cookie)).status;
    }
    expect(last).toBe(429);
    expect((await h.read('/me/inbox', cookie)).status).toBe(200);
  });
});
