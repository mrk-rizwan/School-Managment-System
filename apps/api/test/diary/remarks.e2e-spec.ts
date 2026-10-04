// Remarks end to end (contracts/slice-13.md §3, §5, §6.4; R139-R141, R143, R165): the enrolment
// in force on the date and the author's dated scope, visibility as a level filtered in the query,
// the supersede chain, remark_posted and its gate, and the Idempotency-Key mechanism.
import { ErrorCode } from '@asms/shared';
import type { MyRemarkDto, RemarkDto } from '../../src/modules/diary/diary.dto';
import { createTestApp } from '../core/app';
import { errorOf, StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';
import { createStudent, createTeacherAssignment, isoDay } from '../support/students';
import { captureOutbox, classroom, idemKey, postIdem, studentLogin, type Classroom } from './support';

interface Page<T> {
  data: T[];
  total: number;
}

describe('remarks (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    h.app = await createTestApp();
    captureOutbox(h);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const remarkBody = (extra: object = {}) => ({
    date: isoDay(),
    category: 'behaviour',
    text: 'Helped a classmate\nwith reading.',
    ...extra,
  });
  const post = (r: Classroom, cookie: string, extra: object = {}, key?: string, studentId = r.child1.id) =>
    postIdem(h, api(`/students/${studentId}/remarks`), remarkBody(extra), cookie, key);
  async function posted(r: Classroom, cookie: string, extra: object = {}): Promise<RemarkDto> {
    const res = await post(r, cookie, extra);
    expect(res.status).toBe(201);
    return res.body as RemarkDto;
  }
  const correct = (id: string, body: object, cookie: string) =>
    h.send('post', api(`/remarks/${id}/correct`), body, cookie);
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;
  const messagesOf = (r: Classroom, id: string) =>
    db.message.findMany({
      where: { schoolId: r.school.id, subjectType: 'remark', subjectId: BigInt(id) },
    });
  const setSettings = (r: Classroom, data: { remarkDefaultVisibility?: 'internal' | 'guardian' | 'student'; remarkNotifyGuardians?: boolean }) =>
    db.schoolSettings.updateMany({ where: { schoolId: r.school.id }, data });
  const ids = (res: { body: unknown }) => (res.body as Page<{ id: string }>).data.map((x) => x.id).sort();

  it('R140: visibility defaults from settings; any teacher of the section writes; staff read every visibility', async () => {
    const r = await classroom(h);
    const byDefault = await posted(r, r.mathsTeacher.cookie);
    expect(byDefault).toMatchObject({
      visibility: 'guardian',
      enrolmentId: expect.any(String),
      authorStaffId: String(r.mathsTeacher.staffId),
      authorName: 'Bilal Maths',
      supersedesId: null,
      correctionReason: null,
      text: 'Helped a classmate\nwith reading.',
    });
    await setSettings(r, { remarkDefaultVisibility: 'internal' });
    const internal = await posted(r, r.classTeacher.cookie, { subjectId: String(r.english.id) });
    expect(internal).toMatchObject({ visibility: 'internal', subjectName: 'English' });
    const student = await posted(r, r.classTeacher.cookie, { visibility: 'student' });

    // Office staff hold student.view: every visibility (R140), `internal` included.
    const staff = await h.get(api(`/students/${r.child1.id}/remarks`), r.office.cookie);
    expect(staff.status).toBe(200);
    expect(ids(staff)).toEqual([byDefault.id, internal.id, student.id].sort());
    const filtered = await h.get(api(`/students/${r.child1.id}/remarks?visibility=internal`), r.office.cookie);
    expect(ids(filtered)).toEqual([internal.id]);
    // A teacher of another section: 404 on the student.
    expect((await h.get(api(`/students/${r.child1.id}/remarks`), r.otherTeacher.cookie)).status).toBe(404);
    expect((await post(r, r.otherTeacher.cookie)).status).toBe(404);
    // Office staff do not hold remark.write.
    expect((await post(r, r.office.cookie)).status).toBe(403);
  });

  it('R140: a guardian reads guardian-or-above, a student reads student; internal is not in the total', async () => {
    const r = await classroom(h);
    const internal = await posted(r, r.classTeacher.cookie, { visibility: 'internal' });
    const guardian = await posted(r, r.classTeacher.cookie, { visibility: 'guardian' });
    const student = await posted(r, r.classTeacher.cookie, { visibility: 'student' });

    const parent = await h.get(api(`/me/children/${r.child1.id}/remarks`), r.parentLogin.cookie);
    expect(parent.status).toBe(200);
    expect(ids(parent)).toEqual([guardian.id, student.id].sort());
    expect((parent.body as Page<MyRemarkDto>).total).toBe(2);
    expect(ids(parent)).not.toContain(internal.id);

    const self = await studentLogin(db, r.school, r.child1);
    const own = await h.get(api('/me/student/remarks'), self.cookie);
    expect(ids(own)).toEqual([student.id]);
    expect((own.body as Page<MyRemarkDto>).total).toBe(1);

    // R165: no author staff id, enrolment, visibility or correction reason on /me.
    const [row] = (parent.body as Page<MyRemarkDto>).data;
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'authorName',
        'category',
        'createdAt',
        'date',
        'id',
        'studentId',
        'subjectId',
        'subjectName',
        'supersededAt',
        'supersededById',
        'supersedesId',
        'text',
      ].sort(),
    );
    // Another child's remarks are 404 to this guardian (not linked).
    const stranger = await createStudent(db, r.school);
    expect((await h.get(api(`/me/children/${stranger.id}/remarks`), r.parentLogin.cookie)).status).toBe(404);
  });

  it('R140: remark_posted goes to the guardians only when the school notifies and the remark is not internal; never the text, never to students', async () => {
    const r = await classroom(h);
    await studentLogin(db, r.school, r.child2);
    const off = await posted(r, r.classTeacher.cookie, {}, );
    expect(await messagesOf(r, off.id)).toEqual([]);
    await setSettings(r, { remarkNotifyGuardians: true });
    const internal = await posted(r, r.classTeacher.cookie, { visibility: 'internal' });
    expect(await messagesOf(r, internal.id)).toEqual([]);
    const res = await post(r, r.classTeacher.cookie, { visibility: 'student' }, undefined, r.child2.id);
    const visible = res.body as RemarkDto;
    const messages = await messagesOf(r, visible.id);
    expect(messages.map((m) => m.guardianId).sort()).toEqual([r.parent.id, r.keypad.id].sort());
    expect(messages.filter((m) => m.studentId !== null)).toEqual([]);
    for (const m of messages) {
      expect(m.type).toBe('remark_posted');
      expect(m.body).toContain('A new behaviour remark for Ali Khan dated');
      expect(m.body).not.toContain('Helped a classmate');
    }
    expect(messages.find((m) => m.guardianId === r.keypad.id)).toMatchObject({
      status: 'suppressed',
      suppressedReason: 'no_channel',
    });
  });

  it('R141: a correction is a new row superseding the original, copying its identity; a second correction is REMARK_SUPERSEDED', async () => {
    const r = await classroom(h);
    const original = await posted(r, r.mathsTeacher.cookie, { subjectId: String(r.maths.id), date: isoDay(-1) });
    const res = await correct(original.id, { text: 'Helped two classmates.', reason: 'Wrong count' }, r.mathsTeacher.cookie);
    expect(res.status).toBe(201);
    const fixed = res.body as RemarkDto;
    expect(fixed).toMatchObject({
      supersedesId: original.id,
      correctionReason: 'Wrong count',
      text: 'Helped two classmates.',
      date: original.date,
      category: original.category,
      subjectId: original.subjectId,
      enrolmentId: original.enrolmentId,
      studentId: original.studentId,
      visibility: original.visibility,
    });
    const again = await correct(original.id, { text: 'Third try.', reason: 'Again' }, r.mathsTeacher.cookie);
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: ErrorCode.REMARK_SUPERSEDED,
      details: { supersededById: fixed.id },
    });
    // Hidden by default on the staff list; shown with includeSuperseded, marked superseded.
    const current = await h.get(api(`/students/${r.child1.id}/remarks`), r.classTeacher.cookie);
    expect(ids(current)).toEqual([fixed.id]);
    const all = await h.get(api(`/students/${r.child1.id}/remarks?includeSuperseded=true`), r.classTeacher.cookie);
    const old = (all.body as Page<RemarkDto>).data.find((x) => x.id === original.id);
    expect(old).toMatchObject({ supersededById: fixed.id, supersededAt: expect.any(String) });
    // The guardian who could see the original sees it marked superseded (R141).
    const parent = await h.get(api(`/me/children/${r.child1.id}/remarks`), r.parentLogin.cookie);
    expect((parent.body as Page<MyRemarkDto>).data.find((x) => x.id === original.id)).toMatchObject({
      supersededById: fixed.id,
    });
    const audit = await db.auditLog.findMany({
      where: { schoolId: r.school.id, subjectType: 'remark', subjectId: BigInt(fixed.id) },
    });
    expect(audit).toMatchObject([
      {
        action: 'remark.corrected',
        reason: 'Wrong count',
        metadata: { originalId: original.id, visibilityFrom: 'guardian', visibilityTo: 'guardian', notified: false },
      },
    ]);
  });

  it('R141: a non-author section teacher is not_author; the principal may correct; an internal → guardian correction notifies, a text-only one does not', async () => {
    const r = await classroom(h);
    await setSettings(r, { remarkNotifyGuardians: true });
    const original = await posted(r, r.classTeacher.cookie, { visibility: 'internal' });
    const denied = await correct(original.id, { text: 'Mine', reason: 'Because' }, r.mathsTeacher.cookie);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details).toEqual({ reason: 'not_author' });
    const textOnly = await correct(original.id, { text: 'Clearer wording.', reason: 'Typo' }, r.principal.cookie);
    expect(textOnly.status).toBe(201);
    const first = textOnly.body as RemarkDto;
    expect(first.authorStaffId).toBe(String(r.principal.staffId));
    expect(await messagesOf(r, first.id)).toEqual([]);
    const shown = await correct(first.id, { text: 'Clearer wording.', reason: 'Parents should know', visibility: 'guardian' }, r.principal.cookie);
    expect(shown.status).toBe(201);
    expect((await messagesOf(r, (shown.body as RemarkDto).id)).length).toBeGreaterThan(0);
    // Identity is copied, never changed: date or category in a correction is UNKNOWN_FIELD.
    const identity = await correct((shown.body as RemarkDto).id, { text: 'x', reason: 'yyy', date: isoDay() }, r.principal.cookie);
    expect(fieldsOf(identity)[0]?.code).toBe(ErrorCode.UNKNOWN_FIELD);
  });

  it('R141: a direct UPDATE of a remark is refused by the database', async () => {
    const r = await classroom(h);
    const remark = await posted(r, r.classTeacher.cookie);
    await expect(
      db.remark.updateMany({
        where: { schoolId: r.school.id, id: BigInt(remark.id) },
        data: { text: 'Rewritten' },
      }),
    ).rejects.toThrow();
  });

  it('§5.2: a remark dated before the teacher’s assignment began is not_assigned_on_date; a withdrawn student is STUDENT_NOT_ACTIVE; no enrolment on the date is 422', async () => {
    const r = await classroom(h);
    const newcomer = await h.caller(r.school, 'teacher', 'New Teacher');
    await createTeacherAssignment(db, r.school, newcomer, {
      role: 'subject_teacher',
      subjectId: r.english.id,
      section: r.sectionA,
      startsOn: isoDay(-2),
    });
    const before = await post(r, newcomer.cookie, { date: isoDay(-5) });
    expect(before.status).toBe(403);
    expect(errorOf(before).details).toEqual({ reason: 'not_assigned_on_date' });
    expect((await post(r, newcomer.cookie, { date: isoDay(-1) })).status).toBe(201);

    const noEnrolment = await post(r, r.principal.cookie, { date: isoDay(-60) });
    expect(fieldsOf(noEnrolment)[0]).toMatchObject({ path: 'date', code: ErrorCode.INVALID_VALUE });
    const future = await post(r, r.principal.cookie, { date: isoDay(1) });
    expect(fieldsOf(future)[0]?.path).toBe('date');

    await db.student.updateMany({ where: { schoolId: r.school.id, id: r.child2.id }, data: { status: 'withdrawn' } });
    const left = await post(r, r.principal.cookie, {}, undefined, r.child2.id);
    expect(left.status).toBe(409);
    expect(errorOf(left).code).toBe(ErrorCode.STUDENT_NOT_ACTIVE);
  });

  it('R139: an identity number is refused in remark text and in a correction reason', async () => {
    const r = await classroom(h);
    const res = await post(r, r.classTeacher.cookie, { text: 'Father CNIC 35202-1234567-1' });
    expect(fieldsOf(res)[0]?.path).toBe('text');
    const remark = await posted(r, r.classTeacher.cookie);
    const reason = await correct(remark.id, { text: 'Fine', reason: 'see 3520212345671' }, r.classTeacher.cookie);
    expect(fieldsOf(reason)[0]?.path).toBe('reason');
  });

  it('R143: a replay returns the same remark with 200; another user’s equal key is independent; a different student is IDEMPOTENCY_KEY_REUSED', async () => {
    const r = await classroom(h);
    const key = idemKey();
    const first = await post(r, r.classTeacher.cookie, {}, key);
    expect(first.status).toBe(201);
    const replay = await post(r, r.classTeacher.cookie, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as RemarkDto).id).toBe((first.body as RemarkDto).id);
    const otherUser = await post(r, r.mathsTeacher.cookie, {}, key);
    expect(otherUser.status).toBe(201);
    expect((otherUser.body as RemarkDto).id).not.toBe((first.body as RemarkDto).id);
    const otherStudent = await post(r, r.classTeacher.cookie, {}, key, r.child2.id);
    expect(errorOf(otherStudent).code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect(
      await db.auditLog.count({
        where: { schoolId: r.school.id, action: 'remark.created' },
      }),
    ).toBe(2);
  });
});
