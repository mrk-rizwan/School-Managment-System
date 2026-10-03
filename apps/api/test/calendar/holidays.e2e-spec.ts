// Holidays and the calendar end to end (contracts/slice-10.md §1-§5; R116, R117, R167): access and
// draft visibility, create / patch / publish / cancel with their refusals and audit, the notice and
// the cancellation (one per person, withdrawn when unsent), the R167 listener seam, and the
// teaching-day reads for staff and for any signed-in person.
import { ErrorCode } from '@asms/shared';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { CalendarListenerRegistry, type HolidayRange } from '../../src/modules/calendar/calendar-listener';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createSchoolSession, createSchoolUser, testIdentityHash, randomIdentityDigits } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  enrol,
  linkGuardian,
} from '../support/students';
import { errorOf, schoolDay, StaffHarness, type Caller } from '../staff/support';

interface Holiday {
  id: string;
  startsOn: string;
  endsOn: string;
  name: string;
  description: string | null;
  kind: string;
  appliesToStaff: boolean;
  status: string;
  publishedAt: string | null;
  publishedBy: string | null;
  publishedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  announcementId: string | null;
}
interface Page<T> {
  data: T[];
  total: number;
}

const UNUSABLE_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g';

describe('holidays and calendar (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  const api = (path: string) => `/api/v1${path}`;
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;

  /** A fresh school with a principal, so counts and dates never collide across tests. */
  async function fresh(): Promise<{ school: TestSchool; principal: Caller }> {
    const school = await createSchool();
    // The settings row createSchool leaves out (weekly off: Sunday; student login on, R117's
    // students-with-a-login rule needs it).
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true } });
    return { school, principal: await h.caller(school, 'principal', 'Nadia Principal') };
  }
  const createHoliday = (cookie: string, body: object) => h.send('post', api('/holidays'), body, cookie);
  const publish = (cookie: string, id: string) => h.send('post', api(`/holidays/${id}/publish`), {}, cookie);
  const cancel = (cookie: string, id: string, reason = 'Plans changed') =>
    h.send('post', api(`/holidays/${id}/cancel`), { reason }, cookie);
  const holiday = (extra: object = {}) => ({
    startsOn: schoolDay(10),
    endsOn: schoolDay(12),
    name: 'Winter break',
    kind: 'school',
    ...extra,
  });
  async function made(cookie: string, extra: object = {}): Promise<Holiday> {
    const res = await createHoliday(cookie, holiday(extra));
    expect(res.status).toBe(201);
    return res.body as Holiday;
  }
  const auditFor = (school: TestSchool, id: string) =>
    db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'holiday', subjectId: BigInt(id) },
      orderBy: { id: 'asc' },
    });
  const messagesFor = (school: TestSchool, subjectType: string, id: string) =>
    db.message.findMany({
      where: { schoolId: school.id, subjectType, subjectId: BigInt(id) },
      orderBy: { id: 'asc' },
    });

  /** A login carrying a guardian or a student (no staff), and its cookie. */
  async function loginFor(school: TestSchool, link: { guardianId: bigint } | { studentId: bigint }) {
    const user = await db.user.create({
      data: {
        schoolId: school.id,
        usernameHash: testIdentityHash(randomIdentityDigits()),
        passwordHash: UNUSABLE_HASH,
        ...link,
      },
    });
    return (await createSchoolSession(db, school, { userId: user.id })).cookie;
  }

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  // ------------------------------------------------------------------------------- access

  it('§1: writes need holiday.manage; any staff reads; a draft is invisible without holiday.manage', async () => {
    const { school, principal } = await fresh();
    const teacher = await h.caller(school, 'teacher');
    const office = await h.caller(school, 'office_staff');
    for (const caller of [teacher, office]) {
      expect((await createHoliday(caller.cookie, holiday())).status).toBe(403);
    }
    const draft = await made(principal.cookie);
    const published = await made(principal.cookie, { startsOn: schoolDay(20), endsOn: schoolDay(20) });
    expect((await publish(principal.cookie, published.id)).status).toBe(200);
    for (const caller of [teacher, office]) {
      expect((await publish(caller.cookie, draft.id)).status).toBe(403);
      expect((await cancel(caller.cookie, draft.id)).status).toBe(403);
      expect((await h.send('patch', api(`/holidays/${draft.id}`), { name: 'x' }, caller.cookie)).status).toBe(403);
      const list = (await h.get(api('/holidays'), caller.cookie)).body as Page<Holiday>;
      expect(list.data.map((x) => x.id)).toEqual([published.id]);
      const drafts = (await h.get(api('/holidays?status=draft'), caller.cookie)).body as Page<Holiday>;
      expect(drafts).toMatchObject({ data: [], total: 0 });
      expect((await h.get(api(`/holidays/${draft.id}`), caller.cookie)).status).toBe(404);
      expect((await h.get(api(`/holidays/${published.id}`), caller.cookie)).status).toBe(200);
    }
    const all = (await h.get(api('/holidays'), principal.cookie)).body as Page<Holiday>;
    expect(all.data.map((x) => x.id)).toEqual([draft.id, published.id]);
    // A guardian (no staff capacity) cannot read the staff calendar.
    const guardian = await createGuardian(db, school);
    const parent = await loginFor(school, { guardianId: guardian.id });
    expect((await h.get(api('/holidays'), parent)).status).toBe(403);
  });

  it('every :id is the session school’s only: another school’s holiday is 404', async () => {
    const a = await fresh();
    const b = await fresh();
    const theirs = await made(a.principal.cookie);
    expect((await h.get(api(`/holidays/${theirs.id}`), b.principal.cookie)).status).toBe(404);
    expect((await publish(b.principal.cookie, theirs.id)).status).toBe(404);
    expect((await cancel(b.principal.cookie, theirs.id)).status).toBe(404);
    expect((await h.send('patch', api(`/holidays/${theirs.id}`), { name: 'Taken' }, b.principal.cookie)).status).toBe(404);
  });

  // -------------------------------------------------------------------------------- create

  it('R117: create makes a draft, defaults endsOn and appliesToStaff, normalises text, audits, and sends nothing', async () => {
    const { school, principal } = await fresh();
    const res = await createHoliday(principal.cookie, {
      startsOn: schoolDay(5),
      name: '  Quaid   Day ',
      description: '',
      kind: 'public',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      startsOn: schoolDay(5),
      endsOn: schoolDay(5),
      name: 'Quaid Day',
      description: null,
      kind: 'public',
      appliesToStaff: true,
      status: 'draft',
      publishedAt: null,
      publishedBy: null,
      announcementId: null,
    });
    const id = (res.body as Holiday).id;
    expect((await auditFor(school, id)).map((a) => [a.action, a.metadata])).toEqual([
      [
        'holiday.created',
        { name: 'Quaid Day', startsOn: schoolDay(5), endsOn: schoolDay(5), kind: 'public', appliesToStaff: true },
      ],
    ]);
    expect(await db.message.count({ where: { schoolId: school.id } })).toBe(0);
  });

  it('create refusals: dates, span, typo window, kind, identity and phone patterns', async () => {
    const { principal } = await fresh();
    const cases: [object, string][] = [
      [holiday({ endsOn: schoolDay(9) }), 'endsOn'],
      [holiday({ endsOn: schoolDay(10 + 366) }), 'endsOn'],
      [holiday({ startsOn: schoolDay(-367), endsOn: schoolDay(-367) }), 'startsOn'],
      [holiday({ startsOn: schoolDay(732), endsOn: schoolDay(732) }), 'startsOn'],
      [holiday({ startsOn: '2026-02-30' }), 'startsOn'],
      [holiday({ kind: undefined }), 'kind'],
      [holiday({ kind: 'national' }), 'kind'],
      [holiday({ name: '' }), 'name'],
      [holiday({ name: 'x'.repeat(101) }), 'name'],
      [holiday({ name: 'Closed for 3520112345671' }), 'name'],
      [holiday({ name: 'Call 0300-1234567' }), 'name'],
      [holiday({ description: 'Ring +923001234567 for details' }), 'description'],
      [holiday({ appliesToStaff: 'yes' }), 'appliesToStaff'],
    ];
    for (const [body, path] of cases) {
      const res = await createHoliday(principal.cookie, body);
      expect(res.status).toBe(422);
      expect(fieldsOf(res).map((f) => f.path)).toContain(path);
    }
    // Past dates are allowed (an emergency closure recorded next morning); a 366-day span is fine.
    expect((await createHoliday(principal.cookie, holiday({ startsOn: schoolDay(-1), endsOn: schoolDay(-1) }))).status).toBe(201);
    expect((await createHoliday(principal.cookie, holiday({ startsOn: schoolDay(30), endsOn: schoolDay(30 + 365) }))).status).toBe(201);
  });

  it('holidays_live_excl: an overlap with a draft or published holiday is 409 HOLIDAY_DATES_TAKEN naming it; a cancelled one frees its dates', async () => {
    const { principal } = await fresh();
    const first = await made(principal.cookie);
    for (const range of [
      { startsOn: schoolDay(12), endsOn: schoolDay(14) },
      { startsOn: schoolDay(8), endsOn: schoolDay(10) },
      { startsOn: schoolDay(11), endsOn: schoolDay(11) },
    ]) {
      const res = await createHoliday(principal.cookie, holiday(range));
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: ErrorCode.HOLIDAY_DATES_TAKEN, details: { holidayId: first.id } });
    }
    // Retry-safety: the same range again names the first row.
    expect(errorOf(await createHoliday(principal.cookie, holiday())).details).toEqual({ holidayId: first.id });
    expect((await cancel(principal.cookie, first.id)).status).toBe(200);
    expect((await createHoliday(principal.cookie, holiday())).status).toBe(201);
  });

  it('holidays_live_excl race: two creates of one range at once — one 201, the other 409 naming the winner', async () => {
    const { principal } = await fresh();
    const results = await Promise.all([1, 2].map(() => createHoliday(principal.cookie, holiday())));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const won = results.find((r) => r.status === 201)!.body as Holiday;
    const lost = results.find((r) => r.status === 409)!;
    expect(errorOf(lost)).toMatchObject({ code: ErrorCode.HOLIDAY_DATES_TAKEN, details: { holidayId: won.id } });
  });

  // --------------------------------------------------------------------------------- patch

  it('R117 patch: a draft changes freely; published freezes dates, name and kind (same value accepted); cancelled changes nothing', async () => {
    const { school, principal } = await fresh();
    const patch = (id: string, body: object) => h.send('patch', api(`/holidays/${id}`), body, principal.cookie);
    const h1 = await made(principal.cookie);
    const edited = await patch(h1.id, { startsOn: schoolDay(11), endsOn: schoolDay(13), name: 'Winter  holidays', kind: 'public', description: 'Snow' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ startsOn: schoolDay(11), endsOn: schoolDay(13), name: 'Winter holidays', kind: 'public', description: 'Snow' });
    // null on a required field is 422; null clears the description; endsOn before startsOn is 422.
    for (const body of [{ name: null }, { startsOn: null }, { kind: null }, { appliesToStaff: null }, { endsOn: null }]) {
      expect((await patch(h1.id, body)).status).toBe(422);
    }
    expect(fieldsOf(await patch(h1.id, { endsOn: schoolDay(10) }))[0]).toMatchObject({ path: 'endsOn' });
    expect((await patch(h1.id, { description: null })).body).toMatchObject({ description: null });
    const before = (await auditFor(school, h1.id)).length;
    expect((await patch(h1.id, { name: 'Winter holidays' })).status).toBe(200); // unchanged: no audit
    expect(await auditFor(school, h1.id)).toHaveLength(before);
    const updates = (await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.updated');
    expect(updates[0]?.metadata).toMatchObject({
      changes: { startsOn: { from: schoolDay(10), to: schoolDay(11) }, name: { from: 'Winter break', to: 'Winter holidays' } },
    });

    expect((await publish(principal.cookie, h1.id)).status).toBe(200);
    for (const body of [{ startsOn: schoolDay(12) }, { endsOn: schoolDay(14) }, { name: 'Other' }, { kind: 'school' }]) {
      const res = await patch(h1.id, body);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe(ErrorCode.HOLIDAY_NOT_DRAFT);
    }
    // A form resending every field with description and appliesToStaff changed works.
    const resent = await patch(h1.id, {
      startsOn: schoolDay(11), endsOn: schoolDay(13), name: 'Winter holidays', kind: 'public',
      description: 'Bring books home', appliesToStaff: false,
    });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ description: 'Bring books home', appliesToStaff: false, status: 'published' });
    // The database freezes them too (R117).
    await expect(
      db.holiday.update({ where: { schoolId_id: { schoolId: school.id, id: BigInt(h1.id) } }, data: { name: 'Sneaky' } }),
    ).rejects.toThrow();

    expect((await cancel(principal.cookie, h1.id)).status).toBe(200);
    expect(errorOf(await patch(h1.id, { description: 'Again' })).code).toBe(ErrorCode.HOLIDAY_NOT_DRAFT);
    expect((await patch(h1.id, { description: 'Bring books home' })).status).toBe(200); // unchanged
  });

  it('patch: new dates overlapping another live holiday are 409 HOLIDAY_DATES_TAKEN; its own range does not count', async () => {
    const { principal } = await fresh();
    const a = await made(principal.cookie);
    const b = await made(principal.cookie, { startsOn: schoolDay(20), endsOn: schoolDay(21) });
    const res = await h.send('patch', api(`/holidays/${b.id}`), { startsOn: schoolDay(12) }, principal.cookie);
    expect(errorOf(res)).toMatchObject({ code: ErrorCode.HOLIDAY_DATES_TAKEN, details: { holidayId: a.id } });
    expect((await h.send('patch', api(`/holidays/${a.id}`), { endsOn: schoolDay(13) }, principal.cookie)).status).toBe(200);
  });

  // ------------------------------------------------------------------------ publish / notice

  it('R117: publish sends exactly one holiday_notice per guardian (three children, one notice), active staff and student with a login; nobody else', async () => {
    const { school, principal } = await fresh();
    const { section } = await createClassWithSection(db, school);
    const parent = await createGuardian(db, school);
    const kids = [];
    for (let i = 0; i < 3; i++) {
      const kid = await createStudent(db, school);
      await enrol(db, school, kid, section);
      await linkGuardian(db, school, kid, parent, { isPrimaryContact: i === 0 });
      kids.push(kid);
    }
    await loginFor(school, { studentId: kids[0]!.id });
    // Not told: a guardian whose only child has left, an ended link, a merged guardian, a former
    // staff member, a student without a login.
    const leftChild = await createStudent(db, school, { status: 'withdrawn' });
    const ofLeftChild = await createGuardian(db, school);
    await linkGuardian(db, school, leftChild, ofLeftChild);
    const endedLink = await createGuardian(db, school);
    await linkGuardian(db, school, kids[1]!, endedLink, { isPrimaryContact: false, isFeePayer: false, endedAt: new Date() });
    const merged = await createGuardian(db, school);
    await db.guardian.update({ where: { schoolId_id: { schoolId: school.id, id: merged.id } }, data: { mergedIntoId: parent.id, status: 'merged' } });
    await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'left' });
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    // A staff member whose login also carries a guardian of a pupil is told once, as the guardian.
    const staffParent = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const ownGuardian = await createGuardian(db, school);
    await linkGuardian(db, school, kids[2]!, ownGuardian, { isPrimaryContact: false, isFeePayer: false });
    await db.user.update({ where: { schoolId_id: { schoolId: school.id, id: staffParent.userId } }, data: { guardianId: ownGuardian.id } });

    const h1 = await made(principal.cookie);
    expect(await messagesFor(school, 'holiday', h1.id)).toEqual([]); // a draft sends nothing
    const res = await publish(principal.cookie, h1.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'published', publishedBy: String(principal.userId), publishedByName: 'Nadia Principal' });

    const notices = await messagesFor(school, 'holiday', h1.id);
    expect(notices.every((m) => m.type === 'holiday_notice')).toBe(true);
    const guardians = notices.flatMap((m) => (m.guardianId === null ? [] : [m.guardianId]));
    const staff = notices.flatMap((m) => (m.staffId === null ? [] : [m.staffId]));
    const students = notices.flatMap((m) => (m.studentId === null ? [] : [m.studentId]));
    expect(guardians.sort()).toEqual([parent.id, ownGuardian.id].sort());
    expect(staff.sort()).toEqual([principal.staffId, teacher.staffId].sort());
    expect(students).toEqual([kids[0]!.id]);
    expect(notices[0]?.body).toMatch(/^.+: School closed .+ for Winter break\. Reopens .+\.$/);

    const [audit] = (await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.published');
    expect(audit?.metadata).toEqual({
      startsOn: schoolDay(10), endsOn: schoolDay(12), noticeGuardians: 2, noticeStaff: 2, noticeStudents: 1,
    });

    // Retry-safe: published again is 200, unchanged, no audit, nothing more sent.
    const again = await publish(principal.cookie, h1.id);
    expect(again.status).toBe(200);
    expect((await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.published')).toHaveLength(1);
    expect(await messagesFor(school, 'holiday', h1.id)).toHaveLength(notices.length);
  });

  it('R117: a ten-week break is one row and one notice per person; a holiday wholly past is published with no notice', async () => {
    const { school, principal } = await fresh();
    const longBreak = await made(principal.cookie, { startsOn: schoolDay(30), endsOn: schoolDay(99), name: 'Summer vacation' });
    expect((await publish(principal.cookie, longBreak.id)).status).toBe(200);
    expect(await messagesFor(school, 'holiday', longBreak.id)).toHaveLength(1); // the principal
    const past = await made(principal.cookie, { startsOn: schoolDay(-3), endsOn: schoolDay(-2), name: 'Rain closure' });
    expect((await publish(principal.cookie, past.id)).status).toBe(200);
    expect(await messagesFor(school, 'holiday', past.id)).toEqual([]);
    const [audit] = (await auditFor(school, past.id)).filter((a) => a.action === 'holiday.published');
    expect(audit?.metadata).toMatchObject({ noticeGuardians: 0, noticeStaff: 0, noticeStudents: 0 });
  });

  it('§4.7 size: a publish to 3,000 recipients completes inside the interactive-transaction limit', async () => {
    const { school, principal } = await fresh();
    await db.staff.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        schoolId: school.id,
        fullName: `Bulk Staff ${i}`,
        phone: `+92300${String(1_000_000 + i).padStart(7, '0')}`,
      })),
    });
    const h1 = await made(principal.cookie);
    const started = Date.now();
    const res = await publish(principal.cookie, h1.id);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await db.message.count({ where: { schoolId: school.id, subjectType: 'holiday', subjectId: BigInt(h1.id) } })).toBe(3001);
  }, 60_000);

  it('publish a cancelled holiday: 409 ILLEGAL_STATUS_TRANSITION', async () => {
    const { principal } = await fresh();
    const h1 = await made(principal.cookie);
    await cancel(principal.cookie, h1.id);
    const res = await publish(principal.cookie, h1.id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: ErrorCode.ILLEGAL_STATUS_TRANSITION,
      details: { from: 'cancelled', to: 'published' },
    });
  });

  // ---------------------------------------------------------------------------------- cancel

  it('R117: cancelling a draft sends nothing and frees the dates; a reason is required; cancelling twice is unchanged with no audit', async () => {
    const { school, principal } = await fresh();
    const h1 = await made(principal.cookie);
    for (const reason of ['', 'no', 'Call 03001234567']) {
      expect((await cancel(principal.cookie, h1.id, reason)).status).toBe(422);
    }
    const res = await cancel(principal.cookie, h1.id, '  Plans   changed ');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Plans changed', cancelledByName: 'Nadia Principal' });
    expect(await db.message.count({ where: { schoolId: school.id } })).toBe(0);
    expect((await cancel(principal.cookie, h1.id)).status).toBe(200);
    const cancels = (await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.cancelled');
    expect(cancels.map((a) => [a.reason, a.metadata])).toEqual([
      ['Plans changed', { from: 'draft', noticesWithdrawn: 0, cancellationRecipients: 0 }],
    ]);
  });

  it('R117: cancelling a published holiday withdraws unsent notices and tells exactly the people who were or may have been told', async () => {
    const { school, principal } = await fresh();
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const h1 = await made(principal.cookie);
    await publish(principal.cookie, h1.id);
    const notices = await messagesFor(school, 'holiday', h1.id);
    expect(notices).toHaveLength(2);
    // The principal's notice was already handed over; the teacher's is still queued.
    const handed = notices.find((m) => m.staffId === principal.staffId)!;
    await db.message.update({
      where: { schoolId_id: { schoolId: school.id, id: handed.id } },
      data: { status: 'sent', finishedAt: new Date(), claimedAt: null },
    });
    const queued = notices.find((m) => m.staffId === teacher.staffId)!;
    await db.message.update({
      where: { schoolId_id: { schoolId: school.id, id: queued.id } },
      data: { status: 'queued', suppressedReason: null, finishedAt: null, claimedAt: null },
    });
    // Someone who joins after the publish is not told of a cancellation of something never sent.
    await createSchoolUser(db, school, { systemRole: 'teacher' });

    const res = await cancel(principal.cookie, h1.id, 'Exams moved');
    expect(res.status).toBe(200);
    const withdrawn = await db.message.findFirst({ where: { schoolId: school.id, id: queued.id } });
    expect(withdrawn).toMatchObject({ status: 'suppressed', suppressedReason: 'subject_cancelled' });
    const cancellations = await messagesFor(school, 'holiday_cancellation', h1.id);
    expect(cancellations.map((m) => [m.type, m.staffId])).toEqual([['holiday_notice', principal.staffId]]);
    expect(cancellations[0]?.body).toMatch(/is cancelled\. School is open as normal\.$/);
    const [audit] = (await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.cancelled');
    expect(audit).toMatchObject({
      reason: 'Exams moved',
      metadata: { from: 'published', noticesWithdrawn: 1, cancellationRecipients: 1 },
    });
    // Dates are free again; R116 counts the days as teaching days again.
    expect((await createHoliday(principal.cookie, holiday())).status).toBe(201);
  });

  it('L5: a cancellation tells a guardian merged since as the survivor, once, and skips staff who have left', async () => {
    const { school, principal } = await fresh();
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const student = await createStudent(db, school);
    const merged = await createGuardian(db, school);
    const survivor = await createGuardian(db, school);
    await linkGuardian(db, school, student, merged);
    await linkGuardian(db, school, student, survivor, {
      relationship: 'mother',
      isPrimaryContact: false,
      isFeePayer: false,
    });
    const h1 = await made(principal.cookie);
    expect((await publish(principal.cookie, h1.id)).status).toBe(200);
    const notices = await messagesFor(school, 'holiday', h1.id);
    expect(notices.map((m) => m.guardianId ?? m.staffId).sort()).toEqual(
      [principal.staffId, teacher.staffId, merged.id, survivor.id].sort(),
    );
    // Every notice has been handed over, so none is withdrawn and everyone was told.
    await db.message.updateMany({
      where: { schoolId: school.id, subjectType: 'holiday', subjectId: BigInt(h1.id), status: 'queued' },
      data: { status: 'sent', finishedAt: new Date() },
    });
    // Since then: one guardian was merged into the other, and the teacher has left.
    await db.guardian.update({
      where: { schoolId_id: { schoolId: school.id, id: merged.id } },
      data: { status: 'merged', mergedIntoId: survivor.id },
    });
    const left = await h.send(
      'post',
      api(`/staff/${teacher.staffId}/change-status`),
      { status: 'left', reason: 'Moved city' },
      principal.cookie,
    );
    expect(left.status).toBe(200);

    const res = await cancel(principal.cookie, h1.id, 'Exams moved');
    expect(res.status).toBe(200);
    const cancellations = await messagesFor(school, 'holiday_cancellation', h1.id);
    expect(cancellations.map((m) => m.guardianId ?? m.staffId).sort()).toEqual(
      [principal.staffId, survivor.id].sort(),
    );
    const [audit] = (await auditFor(school, h1.id)).filter((a) => a.action === 'holiday.cancelled');
    expect(audit).toMatchObject({ metadata: { from: 'published', noticesWithdrawn: 0, cancellationRecipients: 2 } });
  });

  it('R117: cancelling a published holiday wholly in the past sends nothing', async () => {
    const { school, principal } = await fresh();
    const past = await made(principal.cookie, { startsOn: schoolDay(-5), endsOn: schoolDay(-4) });
    await publish(principal.cookie, past.id);
    expect((await cancel(principal.cookie, past.id)).status).toBe(200);
    expect(await messagesFor(school, 'holiday_cancellation', past.id)).toEqual([]);
  });

  // ------------------------------------------------------------------------------ R167 seam

  it('R167: listeners run inside the publish and cancel transactions, roll back with them, and are not called for a draft cancel or a no-op publish', async () => {
    const { school, principal } = await fresh();
    const calls: string[] = [];
    let failOn: string | null = null;
    const audit = h.app.get(AuditLogRepository, { strict: false });
    const listener = {
      record: async (kind: string, schoolId: SchoolId, range: HolidayRange) => {
        calls.push(`${kind}:${range.id}`);
        await audit.record(schoolId, {
          actorUserId: principal.userId,
          action: `test.${kind}`,
          subjectType: 'holiday',
          subjectId: range.id,
        });
        if (failOn === kind) throw new Error('listener failed');
      },
      holidayPublished(schoolId: SchoolId, range: HolidayRange) {
        return this.record('published', schoolId, range);
      },
      holidayCancelled(schoolId: SchoolId, range: HolidayRange) {
        return this.record('cancelled', schoolId, range);
      },
    };
    h.app.get(CalendarListenerRegistry).register(listener);
    try {
      const h1 = await made(principal.cookie);
      failOn = 'published';
      expect((await publish(principal.cookie, h1.id)).status).toBe(500);
      expect(await db.holiday.findFirst({ where: { schoolId: school.id, id: BigInt(h1.id) } })).toMatchObject({ status: 'draft' });
      expect((await auditFor(school, h1.id)).map((a) => a.action)).toEqual(['holiday.created']);
      expect(await messagesFor(school, 'holiday', h1.id)).toEqual([]);

      failOn = null;
      expect((await publish(principal.cookie, h1.id)).status).toBe(200);
      expect((await auditFor(school, h1.id)).map((a) => a.action)).toEqual([
        'holiday.created', 'test.published', 'holiday.published',
      ]);
      calls.length = 0;
      expect((await publish(principal.cookie, h1.id)).status).toBe(200); // no-op
      expect(calls).toEqual([]);

      failOn = 'cancelled';
      expect((await cancel(principal.cookie, h1.id)).status).toBe(500);
      expect(await db.holiday.findFirst({ where: { schoolId: school.id, id: BigInt(h1.id) } })).toMatchObject({ status: 'published' });
      failOn = null;
      expect((await cancel(principal.cookie, h1.id)).status).toBe(200);
      expect(calls).toEqual([`cancelled:${h1.id}`, `cancelled:${h1.id}`]);

      calls.length = 0;
      const draft = await made(principal.cookie);
      expect((await cancel(principal.cookie, draft.id)).status).toBe(200);
      expect(calls).toEqual([]);
    } finally {
      failOn = null;
      listener.holidayPublished = () => Promise.resolve();
      listener.holidayCancelled = () => Promise.resolve();
    }
  });

  // ----------------------------------------------------------------------- teaching days

  it('R116: teaching days = days − weekly-off − published holidays; drafts and cancelled change nothing; a Sunday holiday counts once', async () => {
    const { school, principal } = await fresh();
    // A fixed future fortnight: 2027-03-01 (Mon) .. 2027-03-14 (Sun). Sundays 7 and 14.
    const days = async () => {
      const res = await h.get(api('/calendar/teaching-days?dateFrom=2027-03-01&dateTo=2027-03-14'), principal.cookie);
      expect(res.status).toBe(200);
      return res.body as { teachingDays: number; weeklyOffDays: number[]; holidays: { id: string; name: string; kind: string }[] };
    };
    expect(await days()).toMatchObject({ teachingDays: 12, weeklyOffDays: [0], holidays: [] });
    const mk = (startsOn: string, endsOn: string, name: string) =>
      made(principal.cookie, { startsOn, endsOn, name });
    const pub = await mk('2027-03-02', '2027-03-03', 'Spring break');
    const sunday = await mk('2027-03-07', '2027-03-07', 'Sunday holiday');
    await mk('2027-03-09', '2027-03-09', 'Draft day');
    const gone = await mk('2027-03-10', '2027-03-10', 'Cancelled day');
    await publish(principal.cookie, pub.id);
    await publish(principal.cookie, sunday.id);
    await publish(principal.cookie, gone.id);
    await cancel(principal.cookie, gone.id);
    const result = await days();
    expect(result.teachingDays).toBe(10);
    expect(result.holidays.map((x) => x.name)).toEqual(['Spring break', 'Sunday holiday']);
    // The current weekly-off set applies to every date, past included (informational).
    await db.schoolSettings.updateMany({ where: { schoolId: school.id }, data: { weeklyOffDays: [0, 6] } });
    expect((await days()).teachingDays).toBe(8);
    expect((await days()).weeklyOffDays).toEqual([0, 6]);
    const past = await h.get(api(`/calendar/teaching-days?dateFrom=${schoolDay(-13)}&dateTo=${schoolDay(0)}`), principal.cookie);
    expect(past.status).toBe(200);
  });

  it('§5 range rules: both dates required, dateTo ≥ dateFrom, at most 366 days', async () => {
    const { principal } = await fresh();
    for (const query of ['', '?dateFrom=2027-01-01', '?dateFrom=2027-01-10&dateTo=2027-01-09', '?dateFrom=2027-01-01&dateTo=2028-01-02', '?dateFrom=x&dateTo=2027-01-01']) {
      expect((await h.get(api(`/calendar/teaching-days${query}`), principal.cookie)).status).toBe(422);
    }
    expect((await h.get(api('/calendar/teaching-days?dateFrom=2027-01-01&dateTo=2028-01-01'), principal.cookie)).status).toBe(200);
  });

  it('§5.2: GET /me/calendar shows any signed-in person the published calendar of their own school, without ids, descriptions or actors', async () => {
    const { school, principal } = await fresh();
    const pub = await made(principal.cookie, { startsOn: '2027-04-05', endsOn: '2027-04-06', description: 'Internal note' });
    await publish(principal.cookie, pub.id);
    await made(principal.cookie, { startsOn: '2027-04-08', endsOn: '2027-04-08', name: 'Draft plan' });
    const guardian = await createGuardian(db, school);
    const student = await createStudent(db, school);
    const other = await fresh();
    await publish(other.principal.cookie, (await made(other.principal.cookie, { startsOn: '2027-04-07', endsOn: '2027-04-07', name: 'Elsewhere' })).id);
    const query = '/me/calendar?dateFrom=2027-04-01&dateTo=2027-04-30';
    for (const cookie of [principal.cookie, await loginFor(school, { guardianId: guardian.id }), await loginFor(school, { studentId: student.id })]) {
      const res = await h.get(api(query), cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        dateFrom: '2027-04-01',
        dateTo: '2027-04-30',
        weeklyOffDays: [0],
        holidays: [{ startsOn: '2027-04-05', endsOn: '2027-04-06', name: 'Winter break', kind: 'school' }],
      });
    }
    expect((await h.get(api('/me/calendar?dateFrom=2027-04-01'), principal.cookie)).status).toBe(422);
  });
});
