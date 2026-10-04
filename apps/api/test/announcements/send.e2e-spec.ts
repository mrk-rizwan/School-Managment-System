// Announcements: resolution, routing, SMS limits and the delivery summary (contracts/slice-14.md
// §4.3-§4.6, §5.5, §5.9; R109, R110, R145, R149, R150, R152).
import { ErrorCode } from '@asms/shared';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { NotificationService } from '../../src/messaging/notification.service';
import { JOB_TRANSACTION_TIMEOUT_MS } from '../../src/modules/announcements/announcement-send.job';
import { TRANSACTION_TIMEOUT_MS } from '../../src/tenancy/tenancy.module';
import { asSchool, connectedNumber, device } from '../messaging/support';
import { errorOf } from '../staff/support';
import { createSchoolUser, randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createGuardian, createStudent, enrol, isoDay, linkGuardian } from '../support/students';
import { AnnouncementHarness, announcement, campus, type Announcement, type Campus } from './support';

const UNUSABLE = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g';

interface Preview {
  recipients: { total: number; guardians: number; staff: number; students: number };
  byAudience: { kind: string; persons: number }[];
  sms: { allowed: boolean; legs: number; segments: number; units: number; remaining: number; cap: number };
  warnings: string[];
}
interface Summary {
  recipients: { total: number; guardians: number; staff: number; students: number };
  messages: Record<string, number>;
  byChannel: { channel: string; accepted: number; delivered: number; failed: number; suppressed: number }[];
  suppressions: { reason: string; count: number }[];
  smsSegmentsPerMessage: number | null;
  smsUnitsReserved: number;
}

describe('announcements: resolution, routing and delivery (e2e)', () => {
  const h = new AnnouncementHarness();
  const db = h.db;

  beforeAll(() => h.start());
  afterEach(() => {
    h.drivers.calls.length = 0;
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const messagesOf = (c: Campus, id: string) =>
    db.message.findMany({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(id) }, orderBy: { id: 'asc' } });
  /** A draft sent now: the request answers `sending`, the job it enqueued writes the messages. */
  async function sent(c: Campus, body: object, cookie = c.principal.cookie): Promise<Announcement> {
    const draft = await h.draft(body, cookie);
    return h.sendAndDeliver(c.school.id, draft.id, cookie);
  }
  const preview = async (c: Campus, body: object, cookie = c.principal.cookie): Promise<Preview> => {
    const res = await h.post('/announcements/preview-audience', body, cookie);
    if (res.status !== 200) throw new Error(`preview answered ${res.status}: ${res.text}`);
    return res.body as Preview;
  };
  /** A login for a guardian or student, written straight to the database. */
  const loginFor = (c: Campus, link: { guardianId: bigint } | { studentId: bigint } | { staffId: bigint }) =>
    db.user.create({
      data: { schoolId: c.school.id, usernameHash: testIdentityHash(randomIdentityDigits()), passwordHash: UNUSABLE, ...link },
    });
  /** The job's `announcement sent` log line for one announcement. */
  const sentLog = (id: string): Record<string, unknown> | undefined =>
    h.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'announcement sent' && entry.announcementId === id);
  /** Runs every queued message of the announcement through the processor once. */
  async function process(c: Campus, id: string): Promise<void> {
    const processor = h.app.get(MessageProcessor, { strict: false });
    for (const m of await messagesOf(c, id)) {
      if (m.status === 'queued') await asSchool(h.app, c.school.id, () => processor.run(c.school.id, m.id));
    }
  }

  // ---------------------------------------------------------------------------------- R145

  it('R145: a parent with three children is one recipient with three recipient_students rows; the job sends', async () => {
    const c = await campus(h);
    const a = await sent(c, announcement([{ kind: 'class', targetId: String(c.klass.id) }]));
    expect(a).toMatchObject({ status: 'sent', recipientCount: 2 });
    expect(a.sentAt).not.toBeNull();
    const recipients = await db.announcementRecipient.findMany({
      where: { schoolId: c.school.id, announcementId: BigInt(a.id) },
      include: { students: true },
      orderBy: { id: 'asc' },
    });
    expect(recipients.map((r) => [r.guardianId, r.students.map((s) => s.studentId).sort()])).toEqual([
      [c.parent.id, c.kids.map((k) => k.id).sort()],
      [c.parentB.id, [c.childB.id]],
    ]);
    // message_id back-filled from the messages written.
    const messages = await messagesOf(c, a.id);
    expect(recipients.map((r) => r.messageId).sort()).toEqual(messages.map((m) => m.id).sort());
    expect(messages.every((m) => m.type === 'announcement_normal' && m.title === 'Sports day on Friday')).toBe(true);
    expect(messages[0]?.body).toBe('Iqra Model School: Sports day on Friday\nChildren come in sports kit.\nPick-up is at 1 pm.');
  });

  it('R145: a staff member who is also a parent is one recipient on the guardian plan, by login and by identity hash', async () => {
    const c = await campus(h);
    const byLogin = await createSchoolUser(db, c.school, { systemRole: 'teacher' });
    await db.user.update({ where: { schoolId_id: { schoolId: c.school.id, id: byLogin.userId } }, data: { guardianId: c.parentB.id } });
    const byIdentity = await createSchoolUser(db, c.school, { systemRole: 'office_staff' });
    const twin = await createGuardian(db, c.school, { cnic: byIdentity.cnic });
    await linkGuardian(db, c.school, c.childB, twin, { isPrimaryContact: false, isFeePayer: false });
    const a = await sent(c, announcement([{ kind: 'everyone' }]));
    const messages = await messagesOf(c, a.id);
    const staff = messages.flatMap((m) => (m.staffId === null ? [] : [m.staffId]));
    expect(staff).not.toContain(byLogin.staffId);
    expect(staff).not.toContain(byIdentity.staffId);
    expect(messages.filter((m) => m.guardianId === c.parentB.id || m.guardianId === twin.id)).toHaveLength(2);
    const [audit] = await db.auditLog.findMany({ where: { schoolId: c.school.id, action: 'announcement.sent', subjectId: BigInt(a.id) } });
    expect(audit?.metadata).toMatchObject({ dedupedByUser: 1, dedupedByIdentity: 1, audienceKinds: 'everyone', recipients: a.recipientCount });
  });

  it('R145: two guardians on one phone get one WhatsApp leg and two inbox rows; the second is suppressed duplicate_phone', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    const shared = '+923001112233';
    const kid = await createStudent(db, c.school);
    await enrol(db, c.school, kid, c.sectionB, { startedOn: isoDay(-5) });
    const mother = await createGuardian(db, c.school, { phone: shared });
    const father = await createGuardian(db, c.school, { phone: shared });
    await linkGuardian(db, c.school, kid, mother);
    await linkGuardian(db, c.school, kid, father, { isPrimaryContact: false, isFeePayer: false });
    const a = await sent(c, announcement([{ kind: 'student', targetId: String(kid.id) }]));
    const messages = await messagesOf(c, a.id);
    expect(messages.map((m) => [m.guardianId, m.status, m.suppressedReason, m.channelPlan])).toEqual([
      [mother.id, 'queued', null, ['whatsapp']],
      [father.id, 'suppressed', 'duplicate_phone', []],
    ]);
    expect(
      await db.messageDelivery.findMany({ where: { schoolId: c.school.id, messageId: messages[1]?.id ?? 0n }, select: { channel: true, status: true, suppressedReason: true } }),
    ).toEqual([{ channel: 'whatsapp', status: 'suppressed', suppressedReason: 'duplicate_phone' }]);
    // A delivery fact, logged by the job that wrote the messages (the request's audit has none).
    expect(sentLog(a.id)).toMatchObject({ dedupedByPhone: 1 });
  });

  it('R145: a shared phone is kept by the sharer whose plan carries a phone leg; a keypad parent first on a type SMS may not carry does not starve a WhatsApp parent', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    const shared = '+923001112244';
    const kid = await createStudent(db, c.school);
    await enrol(db, c.school, kid, c.sectionB, { startedOn: isoDay(-5) });
    // Created first, so first in the send order; normal announcements may not travel by SMS.
    const keypad = await createGuardian(db, c.school, { phone: shared, contactCapability: 'keypad' });
    const whatsapp = await createGuardian(db, c.school, { phone: shared, contactCapability: 'whatsapp' });
    await linkGuardian(db, c.school, kid, keypad);
    await linkGuardian(db, c.school, kid, whatsapp, { isPrimaryContact: false, isFeePayer: false });
    const a = await sent(c, announcement([{ kind: 'student', targetId: String(kid.id), roles: ['parents'] }]));
    const messages = await messagesOf(c, a.id);
    expect(messages.map((m) => [m.guardianId, m.status, m.suppressedReason, m.channelPlan])).toEqual([
      [keypad.id, 'suppressed', 'not_allowed', []],
      [whatsapp.id, 'queued', null, ['whatsapp']],
    ]);
    // Nothing was stripped, so no duplicate_phone row names the phone.
    expect(await db.messageDelivery.count({ where: { schoolId: c.school.id, suppressedReason: 'duplicate_phone', messageId: { in: messages.map((m) => m.id) } } })).toBe(0);
    expect(sentLog(a.id)).toMatchObject({ dedupedByPhone: 0 });
  });

  it('R145: a push-only first sharer does not take the phone either: the WhatsApp sharer keeps it', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    const shared = '+923001112255';
    const kid = await createStudent(db, c.school);
    await enrol(db, c.school, kid, c.sectionB, { startedOn: isoDay(-5) });
    const app = await createGuardian(db, c.school, { phone: shared, contactCapability: 'smartphone_data' });
    const whatsapp = await createGuardian(db, c.school, { phone: shared, contactCapability: 'whatsapp' });
    await linkGuardian(db, c.school, kid, app);
    await linkGuardian(db, c.school, kid, whatsapp, { isPrimaryContact: false, isFeePayer: false });
    const user = await loginFor(c, { guardianId: app.id });
    await device(db, c.school, user.id);
    const a = await sent(c, announcement([{ kind: 'student', targetId: String(kid.id), roles: ['parents'] }]));
    expect((await messagesOf(c, a.id)).map((m) => [m.guardianId, m.status, m.channelPlan])).toEqual([
      [app.id, 'queued', ['push', 'in_app']],
      [whatsapp.id, 'queued', ['whatsapp']],
    ]);
    expect(sentLog(a.id)).toMatchObject({ dedupedByPhone: 0 });
  });

  it('§5.5: send now answers sending and enqueues the job; the request audits; the job writes; a repeated job and send change nothing', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'parents' }]), c.principal.cookie);
    const res = await h.sendNow(draft.id, c.principal.cookie);
    expect([res.status, res.body]).toEqual([200, expect.objectContaining({ status: 'sending', sentAt: null, recipientCount: 0 })]);
    expect(h.sends.filter((s) => s.job.id === BigInt(draft.id))).toHaveLength(1);
    expect(await messagesOf(c, draft.id)).toHaveLength(0);
    const audits = await db.auditLog.findMany({ where: { schoolId: c.school.id, action: 'announcement.sent', subjectId: BigInt(draft.id) } });
    expect(audits.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ recipients: 2, guardians: 2, staff: 0, students: 0, audienceKinds: 'parents', smsSegments: null }),
    ]);
    // A retried send while the job has not run is 200 unchanged, no second job or audit.
    expect((await h.sendNow(draft.id, c.principal.cookie)).body).toMatchObject({ status: 'sending' });
    expect(h.sends.filter((s) => s.job.id === BigInt(draft.id))).toHaveLength(1);
    expect(await h.deliver(c.school.id, draft.id)).toBe('sent');
    expect(await h.deliver(c.school.id, draft.id)).toBe('skipped');
    expect(await messagesOf(c, draft.id)).toHaveLength(2);
    expect(((await h.read(`/announcements/${draft.id}`, c.principal.cookie)).body as Announcement)).toMatchObject({ status: 'sent', recipientCount: 2 });
    expect(await db.auditLog.count({ where: { schoolId: c.school.id, subjectId: BigInt(draft.id), action: { startsWith: 'announcement.s' } } })).toBe(1);
  });

  it('R109: when every guardian and staff member on SMS would fit, the send does not plan per person; when not, the count is exact', async () => {
    const c = await campus(h);
    const notifications = h.app.get(NotificationService, { strict: false });
    const plan = jest.spyOn(notifications, 'plan');
    const urgent = await h.draft(announcement([{ kind: 'parents' }], { priority: 'urgent' }), c.principal.cookie);
    expect((await h.sendNow(urgent.id, c.principal.cookie)).status).toBe(200);
    expect(plan).not.toHaveBeenCalled(); // 2 parents x 1 segment fits the 500 left
    await db.school.update({ where: { id: c.school.id }, data: { smsMonthlyCap: 1 } });
    const second = await h.draft(announcement([{ kind: 'parents' }], { priority: 'urgent' }), c.principal.cookie);
    const res = await h.sendNow(second.id, c.principal.cookie);
    expect([res.status, errorOf(res).code]).toEqual([409, ErrorCode.SMS_CAP_EXCEEDED]);
    expect(plan).toHaveBeenCalledTimes(1);
    plan.mockRestore();
  });

  it('R145: roles decide parents or students; a student without a login and a can_login=false link; no channel is still a recipient', async () => {
    const c = await campus(h);
    await loginFor(c, { studentId: c.kids[0]!.id });
    const parentsOnly = await sent(c, announcement([{ kind: 'section', targetId: String(c.sectionA.id), roles: ['parents'] }]));
    expect((await messagesOf(c, parentsOnly.id)).map((m) => [m.guardianId, m.studentId])).toEqual([[c.parent.id, null]]);
    const studentsOnly = await sent(c, announcement([{ kind: 'section', targetId: String(c.sectionA.id), roles: ['students'] }]));
    // Only the child with a login; the guardian is not reached.
    expect((await messagesOf(c, studentsOnly.id)).map((m) => [m.guardianId, m.studentId])).toEqual([[null, c.kids[0]!.id]]);
    // parentB's only link has can_login = false: a recipient (decision 3). A guardian with no
    // phone and no login is a recipient whose message is suppressed no_channel.
    const lonely = await createGuardian(db, c.school, { phone: null, contactCapability: 'smartphone_data' });
    await linkGuardian(db, c.school, c.childB, lonely, { isPrimaryContact: false, isFeePayer: false });
    const b = await sent(c, announcement([{ kind: 'section', targetId: String(c.sectionB.id) }]));
    expect((await messagesOf(c, b.id)).map((m) => [m.guardianId, m.status, m.suppressedReason])).toEqual([
      // No WhatsApp number connected and normal SMS off: suppressed, but a recipient all the same.
      [c.parentB.id, 'suppressed', 'not_allowed'],
      [lonely.id, 'suppressed', 'no_channel'],
    ]);
  });

  it('R145: resolution is on the send date (a child admitted after the draft is reached); preview total equals recipientCount', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.principal.cookie);
    const late = await createStudent(db, c.school);
    await enrol(db, c.school, late, c.sectionA, { startedOn: isoDay() });
    const lateParent = await createGuardian(db, c.school);
    await linkGuardian(db, c.school, late, lateParent);
    const p = await preview(c, { audiences: [{ kind: 'section', targetId: String(c.sectionA.id) }], priority: 'normal' });
    expect(p.recipients).toEqual({ total: 2, guardians: 2, staff: 0, students: 0 });
    expect(p.byAudience).toEqual([{ kind: 'section', targetId: String(c.sectionA.id), targetName: 'Class Five A', persons: 2 }]);
    expect((await h.sendAndDeliver(c.school.id, draft.id, c.principal.cookie)).recipientCount).toBe(p.recipients.total);
    expect((await messagesOf(c, draft.id)).map((m) => m.guardianId)).toContain(lateParent.id);
  });

  it('§4.6: preview of everyone counts every person before and after dedupe, warns when nobody or no WhatsApp', async () => {
    const c = await campus(h);
    const p = await preview(c, { audiences: [{ kind: 'everyone' }], priority: 'urgent', title: 'Closed', body: 'Rain' });
    // Two guardians and three staff; no student logins.
    expect(p.recipients).toEqual({ total: 5, guardians: 2, staff: 3, students: 0 });
    expect(p.warnings).toEqual(['whatsapp_not_connected']);
    expect(p.sms).toMatchObject({ allowed: true, segments: 1, cap: 500, remaining: 500 });
    // Writes nothing.
    expect(await db.announcement.count({ where: { schoolId: c.school.id } })).toBe(0);
    const teacherPreview = await h.post('/announcements/preview-audience', { audiences: [{ kind: 'everyone' }], priority: 'normal' }, c.teacher.cookie);
    expect(teacherPreview.status).toBe(403);
    const holiday = await preview(c, { audiences: [{ kind: 'everyone' }], priority: 'normal', holiday: true });
    expect(holiday.sms.allowed).toBe(true); // holiday_notice is on the default allow list
    const empty = await campus(h);
    const nobody = await preview(empty, { audiences: [{ kind: 'student', targetId: String(empty.kids[0]?.id), roles: ['students'] }], priority: 'normal' });
    expect(nobody.warnings).toContain('no_recipients');
  });

  // ---------------------------------------------------------------------------------- R149

  it('R149: urgent goes WhatsApp and SMS together plus push; normal WhatsApp and push, SMS only after failure and only if allowed', async () => {
    const c = await campus(h, { allowed: ['announcement_urgent', 'holiday_notice'] });
    await connectedNumber(db, c.school);
    const user = await loginFor(c, { guardianId: c.parent.id });
    await device(db, c.school, user.id);
    const keypad = await createGuardian(db, c.school, { contactCapability: 'keypad' });
    await linkGuardian(db, c.school, c.childB, keypad, { isPrimaryContact: false, isFeePayer: false });
    const urgent = await sent(c, announcement([{ kind: 'parents' }], { priority: 'urgent' }));
    expect(urgent).toMatchObject({ messageType: 'announcement_urgent', smsSegments: 1 });
    const byGuardian = async (id: string) =>
      new Map((await messagesOf(c, id)).map((m) => [m.guardianId, [m.channelPlan, m.status, m.suppressedReason]]));
    expect((await byGuardian(urgent.id)).get(c.parent.id)).toEqual([['whatsapp', 'sms', 'push', 'in_app'], 'queued', null]);
    expect((await byGuardian(urgent.id)).get(keypad.id)).toEqual([['sms'], 'queued', null]);
    const normal = await sent(c, announcement([{ kind: 'parents' }]));
    expect(normal).toMatchObject({ messageType: 'announcement_normal', smsSegments: null });
    expect((await byGuardian(normal.id)).get(c.parent.id)).toEqual([['whatsapp', 'push', 'in_app'], 'queued', null]);
    // A normal announcement to a keypad parent with the type not allowed: suppressed, still in the inbox.
    expect((await byGuardian(normal.id)).get(keypad.id)).toEqual([[], 'suppressed', 'not_allowed']);
    await db.schoolSettings.updateMany({
      where: { schoolId: c.school.id },
      data: { smsAllowedTypes: ['announcement_urgent', 'announcement_normal', 'holiday_notice'] },
    });
    const allowed = await sent(c, announcement([{ kind: 'parents' }]));
    expect((await byGuardian(allowed.id)).get(c.parent.id)).toEqual([['whatsapp', 'push', 'in_app', 'sms'], 'queued', null]);
  });

  // ---------------------------------------------------------------------------------- R150

  it('R150: the delivery summary equals the delivery rows; byChannel counts the latest attempt; no field says "read"', async () => {
    const c = await campus(h);
    await connectedNumber(db, c.school);
    const keypad = await createGuardian(db, c.school, { contactCapability: 'keypad' });
    await linkGuardian(db, c.school, c.childB, keypad, { isPrimaryContact: false, isFeePayer: false });
    const a = await sent(c, announcement([{ kind: 'parents' }], { priority: 'urgent' }));
    h.drivers.failWhatsApp('provider_unavailable');
    await process(c, a.id);
    const res = await h.read(`/announcements/${a.id}/delivery`, c.principal.cookie);
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).not.toContain('read');
    const summary = res.body as Summary;
    const rows = await db.messageDelivery.findMany({
      where: { schoolId: c.school.id, message: { is: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(a.id) } } },
      orderBy: [{ messageId: 'asc' }, { channel: 'asc' }, { attempt: 'desc' }],
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(`${row.messageId}:${row.channel}`)) latest.set(`${row.messageId}:${row.channel}`, row);
    for (const entry of summary.byChannel) {
      for (const status of ['accepted', 'delivered', 'failed', 'suppressed'] as const) {
        expect([entry.channel, status, entry[status]]).toEqual([
          entry.channel,
          status,
          [...latest.values()].filter((r) => r.channel === entry.channel && r.status === status).length,
        ]);
      }
    }
    expect(summary.byChannel.map((e) => e.channel)).toEqual(['push', 'whatsapp', 'sms', 'email']);
    const messages = await messagesOf(c, a.id);
    expect(Object.values(summary.messages).reduce((n, v) => n + v, 0)).toBe(messages.length);
    expect(summary.recipients).toEqual({ total: 3, guardians: 3, staff: 0, students: 0 });
    expect(summary.smsUnitsReserved).toBe(
      rows.filter((r) => r.channel === 'sms' && r.status !== 'suppressed').reduce((n, r) => n + (r.segments ?? 0), 0),
    );
    expect(summary.smsSegmentsPerMessage).toBe(1);
  });

  // --------------------------------------------------------------------------- R110, R109

  it('R110: an SMS-allowed type over three segments is 409 SMS_TOO_LONG at create, patch and send; SMS off accepts 1,800', async () => {
    const c = await campus(h);
    const long = 'Word '.repeat(110).trim(); // 549 characters: four segments with the prefix
    const create = await h.create(announcement([{ kind: 'parents' }], { priority: 'urgent', body: long }), c.principal.cookie);
    expect([create.status, errorOf(create)]).toEqual([
      409,
      expect.objectContaining({ code: ErrorCode.SMS_TOO_LONG, details: { segments: 4, maxSegments: 3 } }),
    ]);
    const normal = await h.draft(announcement([{ kind: 'parents' }], { body: 'x'.repeat(1800) }), c.principal.cookie);
    expect(normal.smsSegments).toBeNull();
    expect(errorOf(await h.patch(`/announcements/${normal.id}`, { priority: 'urgent' }, c.principal.cookie)).code).toBe(ErrorCode.SMS_TOO_LONG);
    await db.schoolSettings.updateMany({
      where: { schoolId: c.school.id },
      data: { smsAllowedTypes: ['announcement_urgent', 'announcement_normal', 'holiday_notice'] },
    });
    expect(errorOf(await h.sendNow(normal.id, c.principal.cookie)).code).toBe(ErrorCode.SMS_TOO_LONG);
    // An attachment's SMS line counts towards the segments.
    const three = 'y'.repeat(459 - 'Iqra Model School: Sports day on Friday\n'.length);
    const fits = await h.draft(announcement([{ kind: 'parents' }], { priority: 'urgent', body: three }), c.principal.cookie);
    expect(fits.smsSegments).toBe(3);
  });

  it('R109: send now refuses SMS units beyond what the month has left (409 SMS_CAP_EXCEEDED); units count always-legs only', async () => {
    const c = await campus(h);
    await db.school.update({ where: { id: c.school.id }, data: { smsMonthlyCap: 1 } });
    for (const capability of ['keypad', 'keypad'] as const) {
      const g = await createGuardian(db, c.school, { contactCapability: capability });
      await linkGuardian(db, c.school, c.childB, g, { isPrimaryContact: false, isFeePayer: false });
    }
    const draft = await h.draft(announcement([{ kind: 'parents' }], { priority: 'urgent' }), c.principal.cookie);
    const p = await preview(c, { audiences: [{ kind: 'parents' }], priority: 'urgent', title: 'Sports day on Friday', body: 'x' });
    // Two keypad parents and two WhatsApp parents (no WhatsApp connected: SMS always): four legs.
    expect(p.sms).toMatchObject({ allowed: true, legs: 4, units: 4, remaining: 1, cap: 1 });
    expect(p.warnings).toContain('sms_cap_short');
    const res = await h.sendNow(draft.id, c.principal.cookie);
    expect([res.status, errorOf(res)]).toEqual([
      409,
      expect.objectContaining({ code: ErrorCode.SMS_CAP_EXCEEDED, details: { smsUnits: 4, remaining: 1, cap: 1 } }),
    ]);
    // A normal announcement's after-failure SMS legs are not units.
    await connectedNumber(db, c.school);
    await db.schoolSettings.updateMany({
      where: { schoolId: c.school.id },
      data: { smsAllowedTypes: ['announcement_urgent', 'announcement_normal', 'holiday_notice'] },
    });
    const normal = await preview(c, { audiences: [{ kind: 'parents' }], priority: 'normal' });
    expect(normal.sms.legs).toBe(2); // the keypad parents only
  });

  // ------------------------------------------------------------------------------- size

  it('§5.5: a send now to 3,000 recipients answers fast; the job writes them inside its own limit', async () => {
    const c = await campus(h);
    await db.staff.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        schoolId: c.school.id,
        fullName: `Bulk Staff ${i}`,
        phone: `+92301${String(1_000_000 + i).padStart(7, '0')}`,
      })),
    });
    const draft = await h.draft(announcement([{ kind: 'staff' }]), c.principal.cookie);
    let started = Date.now();
    const res = await h.sendNow(draft.id, c.principal.cookie);
    const requestMs = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'sending', recipientCount: 0 });
    // The request resolves and checks; it writes no message. A third of the request transaction
    // limit is the margin, so a slower machine still has two thirds in hand.
    expect(requestMs).toBeLessThan(TRANSACTION_TIMEOUT_MS / 3);
    expect(await messagesOf(c, draft.id)).toHaveLength(0);

    started = Date.now();
    expect(await h.deliver(c.school.id, draft.id)).toBe('sent');
    const jobMs = Date.now() - started;
    globalThis.process.stdout.write(`announcement send, 3,003 recipients: request ${requestMs} ms, job ${jobMs} ms
`);
    expect(jobMs).toBeLessThan(JOB_TRANSACTION_TIMEOUT_MS / 2);
    const row = await db.announcement.findFirst({ where: { schoolId: c.school.id, id: BigInt(draft.id) } });
    expect(row).toMatchObject({ status: 'sent', recipientCount: 3003 });
    expect(await db.announcementRecipient.count({ where: { schoolId: c.school.id, announcementId: BigInt(draft.id), messageId: null } })).toBe(0);
  }, 180_000);
});
