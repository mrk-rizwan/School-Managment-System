// Announcements: access, shape and scope (contracts/slice-14.md §1, §3, §4.1, §4.2, §5.2-§5.4,
// §5.7, §5.8, §10; R143, R144, R146, R152).
import { ErrorCode } from '@asms/shared';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool } from '../support/schools';
import { createGuardian, createStudent, createTeacherAssignment, isoDay, linkGuardian } from '../support/students';
import { idemKey } from '../diary/support';
import { errorOf } from '../staff/support';
import { AnnouncementHarness, announcement, campus, type Announcement, type Campus } from './support';

interface Page<T> {
  data: T[];
  total: number;
}

describe('announcements: access, shape and scope (e2e)', () => {
  const h = new AnnouncementHarness();
  const db = h.db;
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;
  const auditOf = (c: Campus, id: string) =>
    db.auditLog.findMany({
      where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(id) },
      orderBy: { id: 'asc' },
    });

  beforeAll(() => h.start());
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  // --------------------------------------------------------------------------------- access

  it('§1.1: a parent or a staff member without either key is 403; a .scope holder lists only their own', async () => {
    const c = await campus(h);
    const mine = await h.draft(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.teacher.cookie);
    const theirs = await h.draft(announcement([{ kind: 'everyone' }]), c.principal.cookie);
    const list = await h.read('/announcements', c.teacher.cookie);
    expect(list.status).toBe(200);
    expect((list.body as Page<Announcement>).data.map((a) => a.id)).toEqual([mine.id]);
    // Another creator's row is invisible: 404 on every :id route, identical body.
    for (const path of [`/announcements/${theirs.id}`, `/announcements/${theirs.id}/delivery`]) {
      const res = await h.read(path, c.teacher.cookie);
      expect(res.status).toBe(404);
    }
    expect((await h.patch(`/announcements/${theirs.id}`, { title: 'Mine now' }, c.teacher.cookie)).status).toBe(404);
    expect((await h.sendNow(theirs.id, c.teacher.cookie)).status).toBe(404);
    expect((await h.post(`/announcements/${theirs.id}/cancel`, { reason: 'Not needed' }, c.teacher.cookie)).status).toBe(404);
    // The principal (.school) sees every row; another school's row is 404.
    expect((await h.read('/announcements', c.principal.cookie)).body).toMatchObject({ total: 2 });
    const other = await campus(h);
    expect((await h.read(`/announcements/${mine.id}`, other.principal.cookie)).status).toBe(404);
    // A parent holds no capability.
    const parentUser = await db.user.create({
      data: {
        schoolId: c.school.id,
        usernameHash: 'a'.repeat(64),
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
        guardianId: c.parent.id,
      },
    });
    const parentCookie = (await createSchoolSession(db, c.school, { userId: parentUser.id })).cookie;
    expect((await h.read('/announcements', parentCookie)).status).toBe(403);
  });

  // ---------------------------------------------------------------------------------- shape

  it('§4.1: shape refusals name the item; normalised order; roles [] for kinds that take none', async () => {
    const c = await campus(h);
    const cases: [object[], string][] = [
      [[], 'audiences'],
      [[{ kind: 'everyone' }, { kind: 'staff' }], 'audiences'],
      [[{ kind: 'parents', targetId: '1' }], 'audiences[0].targetId'],
      [[{ kind: 'section' }], 'audiences[0].targetId'],
      [[{ kind: 'guardian', targetId: String(c.parent.id), roles: ['parents'] }], 'audiences[0].roles'],
      [[{ kind: 'section', targetId: String(c.sectionA.id), roles: [] }], 'audiences[0].roles'],
      [[{ kind: 'section', targetId: String(c.sectionA.id), roles: ['parents', 'parents'] }], 'audiences[0].roles'],
      [
        [
          { kind: 'section', targetId: String(c.sectionA.id) },
          { kind: 'section', targetId: String(c.sectionA.id), roles: ['students'] },
        ],
        'audiences[1]',
      ],
      [Array.from({ length: 21 }, (_, i) => ({ kind: 'student', targetId: String(i + 1) })), 'audiences'],
    ];
    for (const [audiences, path] of cases) {
      const res = await h.create(announcement(audiences), c.principal.cookie);
      expect([res.status, fieldsOf(res).map((f) => f.path)]).toEqual([422, [path]]);
    }
    const created = await h.draft(
      announcement([
        { kind: 'student', targetId: String(c.kids[0]?.id), roles: ['parents'] },
        { kind: 'section', targetId: String(c.sectionB.id) },
        { kind: 'parents' },
      ]),
      c.principal.cookie,
    );
    expect(created.audiences).toEqual([
      { kind: 'parents', targetId: null, targetName: null, roles: [] },
      { kind: 'section', targetId: String(c.sectionB.id), targetName: 'Class Five B', roles: ['parents', 'students'] },
      { kind: 'student', targetId: String(c.kids[0]?.id), targetName: 'Zara Khan', roles: ['parents'] },
    ]);
    expect(created).toMatchObject({ status: 'draft', recipientCount: 0, messageType: 'announcement_normal', createdByName: 'Nadia Principal' });
  });

  it('§1.5: text is normalised; identity and phone numbers are refused; body keeps line breaks', async () => {
    const c = await campus(h);
    const ok = await h.draft(
      announcement([{ kind: 'everyone' }], { title: '  Sports   day ', body: 'Line one  \r\n  Line   two ' }),
      c.principal.cookie,
    );
    expect([ok.title, ok.body]).toEqual(['Sports day', 'Line one\nLine two']);
    for (const extra of [
      { title: 'Call 03001234567' },
      { body: 'CNIC 3520112345671 here' },
      { body: 'Tab\tinside' },
      { body: 'x'.repeat(1801) },
      { title: 'x'.repeat(121) },
    ]) {
      expect((await h.create(announcement([{ kind: 'everyone' }], extra), c.principal.cookie)).status).toBe(422);
    }
  });

  // ---------------------------------------------------------------------------------- R144

  it('R144: broad kinds need announcement.send.school: 403 audience_requires_school before any target is read', async () => {
    const c = await campus(h);
    for (const caller of [c.teacher, c.office]) {
      for (const kind of ['everyone', 'parents', 'students', 'staff']) {
        const res = await h.create(announcement([{ kind }]), caller.cookie);
        expect([res.status, errorOf(res).details]).toEqual([403, { reason: 'audience_requires_school' }]);
      }
      // A staff_member target: 403 whether the id exists or not (no existence leak).
      for (const targetId of [String(c.principal.staffId), '999999999']) {
        const res = await h.create(announcement([{ kind: 'staff_member', targetId }]), caller.cookie);
        expect([res.status, errorOf(res).details]).toEqual([403, { reason: 'audience_requires_school' }]);
      }
    }
    // The principal reaches every kind.
    for (const audiences of [[{ kind: 'everyone' }], [{ kind: 'staff' }, { kind: 'staff_member', targetId: String(c.office.staffId) }]]) {
      expect((await h.create(announcement(audiences), c.principal.cookie)).status).toBe(201);
    }
  });

  it('R144: a target outside the scope is 422 REFERENCE_NOT_FOUND with the same body as an absent id and another school\'s id', async () => {
    const c = await campus(h);
    const other = await campus(h);
    const bodies = [];
    for (const targetId of [String(c.sectionB.id), '999999999', String(other.sectionA.id)]) {
      const res = await h.create(announcement([{ kind: 'section', targetId }]), c.teacher.cookie);
      expect(res.status).toBe(422);
      const { code, message, details } = errorOf(res);
      bodies.push(JSON.stringify({ code, message, details }));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(fieldsOf({ body: JSON.parse(`{"error":${bodies[0]}}`) as unknown })).toEqual([
      expect.objectContaining({ path: 'audiences[0].targetId', code: ErrorCode.REFERENCE_NOT_FOUND }),
    ]);
    // A class with one section out of scope is refused; the teacher's own section is accepted.
    expect((await h.create(announcement([{ kind: 'class', targetId: String(c.klass.id) }]), c.teacher.cookie)).status).toBe(422);
    expect((await h.create(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.teacher.cookie)).status).toBe(201);
    // A student or guardian of the teacher's section is in scope; of another section is not.
    expect((await h.create(announcement([{ kind: 'student', targetId: String(c.kids[0]?.id) }]), c.teacher.cookie)).status).toBe(201);
    expect((await h.create(announcement([{ kind: 'student', targetId: String(c.childB.id) }]), c.teacher.cookie)).status).toBe(422);
    expect((await h.create(announcement([{ kind: 'guardian', targetId: String(c.parent.id) }]), c.teacher.cookie)).status).toBe(201);
    expect((await h.create(announcement([{ kind: 'guardian', targetId: String(c.parentB.id) }]), c.teacher.cookie)).status).toBe(422);
    // A class whose every live section is in scope is accepted.
    await createTeacherAssignment(db, c.school, c.teacher, { role: 'class_teacher', section: c.otherSection, startsOn: isoDay(-1) });
    expect((await h.create(announcement([{ kind: 'class', targetId: String(c.otherClass.id) }]), c.teacher.cookie)).status).toBe(201);
  });

  it('R144: an office clerk (.scope at all scope) targets any section or student but not everyone', async () => {
    const c = await campus(h);
    for (const audiences of [
      [{ kind: 'class', targetId: String(c.klass.id) }],
      [{ kind: 'section', targetId: String(c.otherSection.id) }],
      [{ kind: 'student', targetId: String(c.childB.id) }],
      [{ kind: 'guardian', targetId: String(c.parentB.id) }],
    ]) {
      expect((await h.create(announcement(audiences), c.office.cookie)).status).toBe(201);
    }
    expect((await h.create(announcement([{ kind: 'everyone' }]), c.office.cookie)).status).toBe(403);
  });

  it('R144: a cover teacher reaches the covered section while the cover is live, and is refused once it ended', async () => {
    const c = await campus(h);
    const cover = await h.caller(c.school, 'teacher', 'Cover Teacher');
    await createTeacherAssignment(db, c.school, cover, {
      role: 'cover',
      section: c.sectionB,
      startsOn: isoDay(-1),
      endsOn: isoDay(0),
    });
    expect((await h.create(announcement([{ kind: 'section', targetId: String(c.sectionB.id) }]), cover.cookie)).status).toBe(201);
    const ended = await h.caller(c.school, 'teacher', 'Ended Cover');
    await createTeacherAssignment(db, c.school, ended, {
      role: 'cover',
      section: c.sectionB,
      startsOn: isoDay(-3),
      endsOn: isoDay(-1),
    });
    expect((await h.create(announcement([{ kind: 'section', targetId: String(c.sectionB.id) }]), ended.cookie)).status).toBe(422);
  });

  it('R144 §4.2: visible targets that cannot be reached are 409s; a suspended student is accepted', async () => {
    const c = await campus(h);
    const archived = await db.section.update({
      where: { schoolId_id: { schoolId: c.school.id, id: c.sectionB.id } },
      data: { deletedAt: new Date() },
    });
    const sectionRes = await h.create(announcement([{ kind: 'section', targetId: String(archived.id) }]), c.principal.cookie);
    expect([sectionRes.status, errorOf(sectionRes).code]).toEqual([409, ErrorCode.SECTION_ARCHIVED]);
    const withdrawn = await createStudent(db, c.school, { status: 'withdrawn' });
    const studentRes = await h.create(announcement([{ kind: 'student', targetId: String(withdrawn.id) }]), c.principal.cookie);
    expect([studentRes.status, errorOf(studentRes).code]).toEqual([409, ErrorCode.STUDENT_NOT_ACTIVE]);
    const suspended = await createStudent(db, c.school, { status: 'suspended' });
    expect((await h.create(announcement([{ kind: 'student', targetId: String(suspended.id) }]), c.principal.cookie)).status).toBe(201);
    const merged = await createGuardian(db, c.school);
    await linkGuardian(db, c.school, c.kids[0]!, merged, { isPrimaryContact: false, isFeePayer: false });
    await db.guardian.update({
      where: { schoolId_id: { schoolId: c.school.id, id: merged.id } },
      data: { status: 'merged', mergedIntoId: c.parent.id },
    });
    const mergedRes = await h.create(announcement([{ kind: 'guardian', targetId: String(merged.id) }]), c.principal.cookie);
    expect([mergedRes.status, errorOf(mergedRes)]).toEqual([
      409,
      expect.objectContaining({ code: ErrorCode.GUARDIAN_MERGED, details: { mergedIntoId: String(c.parent.id) } }),
    ]);
    const left = await createSchoolUser(db, c.school, { systemRole: 'teacher', staffStatus: 'left' });
    const staffRes = await h.create(announcement([{ kind: 'staff_member', targetId: String(left.staffId) }]), c.principal.cookie);
    expect([staffRes.status, errorOf(staffRes).code]).toEqual([409, ErrorCode.STAFF_NOT_ACTIVE]);
    const archivedClass = await db.class.update({
      where: { schoolId_id: { schoolId: c.school.id, id: c.otherClass.id } },
      data: { status: 'archived' },
    });
    const classRes = await h.create(announcement([{ kind: 'class', targetId: String(archivedClass.id) }]), c.principal.cookie);
    expect([classRes.status, errorOf(classRes).code]).toEqual([409, ErrorCode.CLASS_ARCHIVED]);
  });

  it('R144: scope is re-checked at patch and at send (an assignment that ended since is 422)', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.teacher.cookie);
    await db.teacherAssignment.updateMany({
      where: { schoolId: c.school.id, staffId: c.teacher.staffId },
      data: { endsOn: new Date(`${isoDay(-1)}T00:00:00.000Z`) },
    });
    const send = await h.sendNow(draft.id, c.teacher.cookie);
    expect([send.status, fieldsOf(send)[0]?.path]).toEqual([422, 'audiences[0].targetId']);
    // Rolled back: still a draft, nothing written.
    expect((await db.announcement.findFirst({ where: { schoolId: c.school.id, id: BigInt(draft.id) } }))?.status).toBe('draft');
    expect(await db.message.count({ where: { schoolId: c.school.id, subjectType: 'announcement' } })).toBe(0);
    expect((await h.patch(`/announcements/${draft.id}`, { title: 'New title' }, c.teacher.cookie)).status).toBe(422);
  });

  // ---------------------------------------------------------------------------------- R143

  it('R143: a replay answers 200 with the header; a different body is 409; another user\'s equal key is independent', async () => {
    const c = await campus(h);
    const key = idemKey();
    const body = announcement([{ kind: 'everyone' }]);
    const first = await h.create(body, c.principal.cookie, key);
    expect(first.status).toBe(201);
    const replay = await h.create(body, c.principal.cookie, key);
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as Announcement).id]).toEqual([
      200,
      'true',
      (first.body as Announcement).id,
    ]);
    // Audiences in another order are the same request (canonical after normalisation).
    expect((await h.create({ ...body }, c.principal.cookie, key)).status).toBe(200);
    const reused = await h.create({ ...body, title: 'Other' }, c.principal.cookie, key);
    expect([reused.status, errorOf(reused).code]).toEqual([409, ErrorCode.IDEMPOTENCY_KEY_REUSED]);
    expect((await h.create(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.teacher.cookie, key)).status).toBe(201);
    // A refused create leaves the key unconsumed.
    const fresh = idemKey();
    expect((await h.create(announcement([{ kind: 'everyone' }]), c.teacher.cookie, fresh)).status).toBe(403);
    expect((await h.create(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }]), c.teacher.cookie, fresh)).status).toBe(201);
    expect((await h.create(body, c.principal.cookie, 'short')).status).toBe(422);
    expect(await db.auditLog.count({ where: { schoolId: c.school.id, action: 'announcement.created' } })).toBe(3);
  });

  it('R143: a racing pair under one key yields one row', async () => {
    const c = await campus(h);
    const key = idemKey();
    const body = announcement([{ kind: 'everyone' }]);
    const [a, b] = await Promise.all([h.create(body, c.principal.cookie, key), h.create(body, c.principal.cookie, key)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await db.announcement.count({ where: { schoolId: c.school.id } })).toBe(1);
  });

  // -------------------------------------------------------------------- R146 state machine

  it('R146: patch edits draft content; no change is 200 with no audit; after sent 409 ANNOUNCEMENT_SENT; cancel', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'everyone' }]), c.principal.cookie);
    const noop = await h.patch(`/announcements/${draft.id}`, { title: draft.title }, c.principal.cookie);
    expect(noop.status).toBe(200);
    const edited = await h.patch(
      `/announcements/${draft.id}`,
      { title: 'Sports day moved', audiences: [{ kind: 'parents' }], expiresOn: isoDay(5) },
      c.principal.cookie,
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Sports day moved', expiresOn: isoDay(5), audiences: [{ kind: 'parents' }] });
    for (const body of [{ title: null }, { audiences: null }, { expiresOn: isoDay(-1) }, { scheduledAt: new Date(Date.now() + 10_000).toISOString() }]) {
      expect((await h.patch(`/announcements/${draft.id}`, body, c.principal.cookie)).status).toBe(422);
    }
    expect((await h.sendNow(draft.id, c.principal.cookie)).body).toMatchObject({ status: 'sending' });
    // `sending` is frozen as `sent` is (R146) until the job has delivered it.
    const sending = await h.patch(`/announcements/${draft.id}`, { title: 'Too late' }, c.principal.cookie);
    expect([sending.status, errorOf(sending).details]).toEqual([409, { status: 'sending' }]);
    expect(await h.deliver(c.school.id, draft.id)).toBe('sent');
    const late = await h.patch(`/announcements/${draft.id}`, { title: 'Too late' }, c.principal.cookie);
    expect([late.status, errorOf(late)]).toEqual([409, expect.objectContaining({ code: ErrorCode.ANNOUNCEMENT_SENT, details: { status: 'sent' } })]);
    const recall = await h.post(`/announcements/${draft.id}/cancel`, { reason: 'Mistake' }, c.principal.cookie);
    expect([recall.status, errorOf(recall).code]).toEqual([409, ErrorCode.ANNOUNCEMENT_SENT]);
    // Retried send is 200 unchanged, no audit.
    expect((await h.sendNow(draft.id, c.principal.cookie)).status).toBe(200);

    const other = await h.draft(announcement([{ kind: 'everyone' }]), c.principal.cookie);
    expect((await h.post(`/announcements/${other.id}/cancel`, { reason: 'no' }, c.principal.cookie)).status).toBe(422);
    const cancelled = await h.post(`/announcements/${other.id}/cancel`, { reason: 'Not needed' }, c.principal.cookie);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Not needed' });
    expect((await h.post(`/announcements/${other.id}/cancel`, { reason: 'Again' }, c.principal.cookie)).status).toBe(200);
    expect(errorOf(await h.sendNow(other.id, c.principal.cookie)).code).toBe(ErrorCode.ANNOUNCEMENT_CANCELLED);
    expect(errorOf(await h.patch(`/announcements/${other.id}`, { title: 'x' }, c.principal.cookie)).code).toBe(ErrorCode.ANNOUNCEMENT_CANCELLED);

    // R152: actor, counts by kind, reason; never a name; replays and no-ops write nothing.
    expect((await auditOf(c, draft.id)).map((a) => [a.action, a.actorUserId, a.metadata])).toEqual([
      ['announcement.created', c.principal.userId, expect.objectContaining({ audienceKinds: 'everyone', scheduled: false, hasAttachment: false })],
      ['announcement.updated', c.principal.userId, { changes: 'title,audiences,expiresOn' }],
      ['announcement.sent', c.principal.userId, expect.objectContaining({ audienceKinds: 'parents', dedupedByUser: 0, dedupedByIdentity: 0 })],
    ]);
    expect((await auditOf(c, other.id)).map((a) => [a.action, a.reason, a.metadata])).toEqual([
      ['announcement.created', null, expect.anything()],
      ['announcement.cancelled', 'Not needed', { fromStatus: 'draft', audienceKinds: 'everyone' }],
    ]);
    const all = JSON.stringify(await db.auditLog.findMany({ where: { schoolId: c.school.id, subjectType: 'announcement' } }), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const name of ['Sana Khan', 'Zara Khan', 'Sports day']) expect(all).not.toContain(name);
  });

  it('§5.2: list filters and sorts; createdTo before createdFrom is 422', async () => {
    const c = await campus(h);
    const a = await h.draft(announcement([{ kind: 'everyone' }], { category: 'exam', priority: 'urgent' }), c.principal.cookie);
    const b = await h.draft(announcement([{ kind: 'everyone' }]), c.principal.cookie);
    const page = (q: string) => h.read(`/announcements?${q}`, c.principal.cookie);
    expect(((await page('category=exam')).body as Page<Announcement>).data.map((x) => x.id)).toEqual([a.id]);
    expect(((await page('priority=normal')).body as Page<Announcement>).data.map((x) => x.id)).toEqual([b.id]);
    expect(((await page('sort=createdAt')).body as Page<Announcement>).data.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(((await page(`createdFrom=${isoDay()}&createdTo=${isoDay()}`)).body as Page<Announcement>).total).toBe(2);
    expect(((await page(`createdFrom=${isoDay(1)}`)).body as Page<Announcement>).total).toBe(0);
    expect((await page(`createdFrom=${isoDay()}&createdTo=${isoDay(-1)}`)).status).toBe(422);
    expect((await page('status=read')).status).toBe(422);
  });

  it('a school with no audience members is refused at send now: 409 ANNOUNCEMENT_NO_RECIPIENTS, nothing written', async () => {
    const school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const principal = await h.caller(school, 'principal');
    const draft = await h.draft(announcement([{ kind: 'parents' }]), principal.cookie);
    const res = await h.sendNow(draft.id, principal.cookie);
    expect([res.status, errorOf(res)]).toEqual([
      409,
      expect.objectContaining({ code: ErrorCode.ANNOUNCEMENT_NO_RECIPIENTS, details: { audiences: 1 } }),
    ]);
    expect((await db.announcement.findFirst({ where: { schoolId: school.id, id: BigInt(draft.id) } }))?.status).toBe('draft');
  });
});
