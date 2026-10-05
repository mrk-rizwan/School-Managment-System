// Diary entries end to end (contracts/slice-13.md §1, §3, §4, §6; R137-R139, R142, R143, R164,
// R165, R171): dated, role-aware writes, the edit window and its history, diary_posted and its
// routing, the guardian and student reads by the enrolment in force on the entry's date,
// attachments and on-demand thumbnails, and the Idempotency-Key mechanism.
import { buffer } from 'node:stream/consumers';
import sharp from 'sharp';
import request from 'supertest';
import { ErrorCode } from '@asms/shared';
import { SchoolClock } from '../../src/common/school-clock';
import { ObjectNotFoundError, ObjectStorage } from '../../src/common/storage/object-storage';
import { thumbnailKey } from '../../src/modules/documents/attachment-files.service';
import { addDays } from '../../src/common/school-clock';
import type { DiaryEntryDto, MyDiaryEntryDto } from '../../src/modules/diary/diary.dto';
import { EXIF_MARKER, jpegWithExif, pdf } from '../documents/fixtures';
import { createTestApp } from '../core/app';
import { errorOf, ORIGIN, StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';
import {
  createGuardian,
  createStudent,
  createTeacherAssignment,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import {
  captureOutbox,
  classroom,
  guardianLogin,
  idemKey,
  postIdem,
  studentLogin,
  type Classroom,
} from './support';

interface Page<T> {
  data: T[];
  total: number;
}
interface Staged {
  id: string;
}

describe('diary entries (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    h.app = await createTestApp();
    captureOutbox(h);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    captureOutbox(h);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const entryBody = (r: Classroom, extra: object = {}) => ({
    date: isoDay(),
    subjectId: String(r.maths.id),
    topic: 'Fractions: halves and quarters',
    assignment: 'Exercise 4.1\nQuestions 1-5',
    ...extra,
  });
  const write = (r: Classroom, cookie: string, extra: object = {}, key?: string) =>
    postIdem(h, api(`/sections/${r.sectionA.id}/diary-entries`), entryBody(r, extra), cookie, key);
  async function written(r: Classroom, cookie: string, extra: object = {}): Promise<DiaryEntryDto> {
    const res = await write(r, cookie, extra);
    expect(res.status).toBe(201);
    return res.body as DiaryEntryDto;
  }
  const patch = (id: string, body: object, cookie: string) =>
    h.send('patch', api(`/diary-entries/${id}`), body, cookie);
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;
  const changesOf = (r: Classroom, id: string) =>
    db.diaryEntryChange.findMany({ where: { schoolId: r.school.id, diaryEntryId: BigInt(id) } });
  const auditOf = (r: Classroom, id: string) =>
    db.auditLog.findMany({
      where: { schoolId: r.school.id, subjectType: 'diary_entry', subjectId: BigInt(id) },
      orderBy: { id: 'asc' },
    });
  const messagesOf = (r: Classroom, id: string) =>
    db.message.findMany({
      where: { schoolId: r.school.id, subjectType: 'diary_entry', subjectId: BigInt(id) },
    });
  /** Moves the school clock `days` ahead for the rest of the test. */
  const clockAhead = (days: number) => {
    const real = new Date();
    jest.spyOn(SchoolClock.prototype, 'now').mockReturnValue(addDays(real, days));
  };
  const stage = async (body: Buffer, cookie: string): Promise<Staged> => {
    const res = await request(h.app.getHttpServer())
      .post(api('/uploads'))
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .attach('file', body, 'file.bin');
    expect(res.status).toBe(201);
    return res.body as Staged;
  };
  const download = (path: string, cookie: string) =>
    request(h.app.getHttpServer()).get(path).set('Cookie', cookie).responseType('blob');

  // ---------------------------------------------------------------------------- R137 writes

  it('R137: a class teacher writes any subject; one entry per section, date and subject', async () => {
    const r = await classroom(h);
    const english = await written(r, r.classTeacher.cookie, { subjectId: String(r.english.id) });
    expect(english).toMatchObject({
      sectionId: String(r.sectionA.id),
      classId: String(r.klass.id),
      academicYearId: String(r.year.id),
      subjectName: 'English',
      authorStaffId: String(r.classTeacher.staffId),
      authorName: 'Ayesha Class',
      assignment: 'Exercise 4.1\nQuestions 1-5',
      learningOutcome: null,
      dueOn: null,
      hasAttachment: false,
      attachmentMime: null,
    });
    const again = await write(r, r.principal.cookie, { subjectId: String(r.english.id) });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: ErrorCode.DIARY_ENTRY_EXISTS,
      details: { entryId: english.id },
    });
    expect(await auditOf(r, english.id)).toMatchObject([
      { action: 'diary_entry.created', actorUserId: r.classTeacher.userId },
    ]);
  });

  it('R137: a subject teacher writes only a subject taught in the section', async () => {
    const r = await classroom(h);
    await written(r, r.mathsTeacher.cookie);
    const other = await write(r, r.mathsTeacher.cookie, { subjectId: String(r.english.id) });
    expect(other.status).toBe(409);
    expect(errorOf(other).code).toBe(ErrorCode.SUBJECT_NOT_ASSIGNED);
  });

  it('R137, R175: a cover teacher writes any subject inside the cover dates; outside them not_assigned_on_date; a section never assigned is 404', async () => {
    const r = await classroom(h);
    const cover = await h.caller(r.school, 'teacher', 'Cover Teacher');
    await createTeacherAssignment(db, r.school, cover, {
      role: 'cover',
      section: r.sectionA,
      startsOn: isoDay(-5),
      endsOn: isoDay(-2),
    });
    const inside = await write(r, cover.cookie, {
      date: isoDay(-3),
      subjectId: String(r.english.id),
    });
    expect(inside.status).toBe(201);
    const after = await write(r, cover.cookie, { date: isoDay(-1) });
    expect(after.status).toBe(403);
    expect(errorOf(after)).toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      details: { reason: 'not_assigned_on_date' },
    });
    // A teacher never assigned to the section gets 404, the same body as absent, exactly as a
    // register write does (main-thread ruling 2026-10-04).
    const stranger = await write(r, r.otherTeacher.cookie);
    expect(stranger.status).toBe(404);
    expect(errorOf(stranger).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('§4.3: a future date, a date outside the year, a dueOn before the date, an unknown subject are 422', async () => {
    const r = await classroom(h);
    const future = await write(r, r.classTeacher.cookie, { date: isoDay(1) });
    expect(fieldsOf(future)[0]).toMatchObject({ path: 'date', code: ErrorCode.INVALID_VALUE });
    const beforeYear = await write(r, r.principal.cookie, { date: isoDay(-200) });
    expect(fieldsOf(beforeYear)[0]?.path).toBe('date');
    const due = await write(r, r.classTeacher.cookie, { dueOn: isoDay(-1) });
    expect(fieldsOf(due)[0]).toMatchObject({ path: 'dueOn', code: ErrorCode.INVALID_VALUE });
    const subject = await write(r, r.principal.cookie, { subjectId: '999999999' });
    expect(fieldsOf(subject)[0]).toMatchObject({
      path: 'subjectId',
      code: ErrorCode.REFERENCE_NOT_FOUND,
    });
  });

  // ----------------------------------------------------------------------------- R139 text

  it('R139: identity numbers are refused in topic, assignment and learningOutcome; a phone number in topic', async () => {
    const r = await classroom(h);
    for (const [field, value] of [
      ['topic', 'Bring 35202-1234567-1 to school'],
      ['assignment', 'Write 3520212345671 twice'],
      ['learningOutcome', 'Knows 3520212345671'],
      ['topic', 'Call 0300 1234567 for help'],
      ['topic', 'Call 0300-123-4567 for help'],
    ] as const) {
      const res = await write(r, r.classTeacher.cookie, { [field]: value });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)[0]?.path).toBe(field);
    }
    expect(
      await db.diaryEntry.count({ where: { schoolId: r.school.id } }),
    ).toBe(0);
  });

  // ------------------------------------------------------------------------------ R137 edits

  it('R137: the author edits inside the window without a reason; one changes row; a no-op writes nothing', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie);
    const res = await patch(entry.id, { topic: 'Fractions: thirds', assignment: '' }, r.classTeacher.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ topic: 'Fractions: thirds', assignment: null });
    expect(await changesOf(r, entry.id)).toMatchObject([
      {
        oldTopic: 'Fractions: halves and quarters',
        newTopic: 'Fractions: thirds',
        oldAssignment: 'Exercise 4.1\nQuestions 1-5',
        newAssignment: null,
        changedBy: r.classTeacher.userId,
        reason: null,
      },
    ]);
    const noop = await patch(entry.id, { topic: 'Fractions: thirds' }, r.classTeacher.cookie);
    expect(noop.status).toBe(200);
    expect(await changesOf(r, entry.id)).toHaveLength(1);
    expect((await auditOf(r, entry.id)).map((a) => a.action)).toEqual([
      'diary_entry.created',
      'diary_entry.updated',
    ]);
    // The natural key is identity: date and subject cannot be patched.
    const identity = await patch(entry.id, { date: isoDay(-1) }, r.classTeacher.cookie);
    expect(identity.status).toBe(422);
    expect(fieldsOf(identity)[0]?.code).toBe(ErrorCode.UNKNOWN_FIELD);
  });

  it('R137: another section teacher is not_author; after the window the author is locked and the principal needs a reason', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie);
    const sent = (await messagesOf(r, entry.id)).length;
    const notAuthor = await patch(entry.id, { topic: 'Mine now' }, r.mathsTeacher.cookie);
    expect(notAuthor.status).toBe(403);
    expect(errorOf(notAuthor).details).toEqual({ reason: 'not_author' });

    clockAhead(4); // the default window is 3 days from creation
    const locked = await patch(entry.id, { topic: 'Late fix' }, r.classTeacher.cookie);
    expect(locked.status).toBe(409);
    expect(errorOf(locked).code).toBe(ErrorCode.DIARY_ENTRY_LOCKED);
    const noReason = await patch(entry.id, { topic: 'Late fix', dueOn: isoDay(3) }, r.principal.cookie);
    expect(noReason.status).toBe(409);
    expect(errorOf(noReason)).toMatchObject({
      code: ErrorCode.AMENDMENT_REASON_REQUIRED,
      details: { amendments: ['topic', 'dueOn'] },
    });
    const ok = await patch(
      entry.id,
      { topic: 'Late fix', reason: 'Parent asked for clarity' },
      r.principal.cookie,
    );
    expect(ok.status).toBe(200);
    expect(await changesOf(r, entry.id)).toMatchObject([
      { newTopic: 'Late fix', changedBy: r.principal.userId, reason: 'Parent asked for clarity' },
    ]);
    const audit = await auditOf(r, entry.id);
    expect(audit[1]).toMatchObject({
      action: 'diary_entry.updated',
      reason: 'Parent asked for clarity',
      metadata: { changes: 'topic', afterWindow: true, byAuthor: false },
    });
    expect(await messagesOf(r, entry.id)).toHaveLength(sent);
  });

  it('R137: a direct UPDATE of an entry without the transaction-local actor is refused by the database', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie);
    await expect(
      db.diaryEntry.updateMany({
        where: { schoolId: r.school.id, id: BigInt(entry.id) },
        data: { topic: 'Sneaky' },
      }),
    ).rejects.toThrow(/needs the acting user/);
  });

  // ------------------------------------------------------------------------------ R138

  it('R138: an entry dated today writes one diary_posted per guardian and per student with a login, never WhatsApp or SMS', async () => {
    const r = await classroom(h);
    // A third child in the section whose guardian is a staff member's login (one row, guardian
    // plan); a withdrawn child receives nothing (R164); a child who left before today neither.
    const staffParent = await h.caller(r.school, 'teacher', 'Staff Parent');
    const staffGuardian = await createGuardian(db, r.school);
    await db.user.updateMany({
      where: { schoolId: r.school.id, id: staffParent.userId },
      data: { guardianId: staffGuardian.id },
    });
    const child3 = await createStudent(db, r.school);
    await enrol(db, r.school, child3, r.sectionA, { startedOn: isoDay(-30) });
    await linkGuardian(db, r.school, child3, staffGuardian);
    const withdrawn = await createStudent(db, r.school, { status: 'withdrawn' });
    await enrol(db, r.school, withdrawn, r.sectionA, { startedOn: isoDay(-30) });
    const withdrawnParent = await createGuardian(db, r.school);
    await linkGuardian(db, r.school, withdrawn, withdrawnParent);
    const child1Login = await studentLogin(db, r.school, r.child1);

    const entry = await written(r, r.classTeacher.cookie, { dueOn: isoDay(2) });
    const messages = await messagesOf(r, entry.id);
    const byGuardian = messages.filter((m) => m.guardianId !== null);
    expect(byGuardian.map((m) => m.guardianId).sort()).toEqual(
      [r.parent.id, r.keypad.id, staffGuardian.id].sort(),
    );
    expect(messages.filter((m) => m.studentId !== null).map((m) => m.studentId)).toEqual([
      r.child1.id,
    ]);
    expect(messages.filter((m) => m.staffId !== null)).toEqual([]);
    for (const m of messages) {
      expect(m.type).toBe('diary_posted');
      expect(m.channelPlan.every((c) => c === 'push' || c === 'in_app')).toBe(true);
      expect(m.body).toContain('Class Five Blue Mathematics diary for');
      expect(m.body).not.toContain('Ayesha');
    }
    // The keypad guardian: a visible suppression, no_channel (decision 8).
    const keypad = messages.find((m) => m.guardianId === r.keypad.id);
    expect(keypad).toMatchObject({ status: 'suppressed', suppressedReason: 'no_channel', channelPlan: [] });
    const deliveries = await db.messageDelivery.findMany({
      where: { schoolId: r.school.id, messageId: keypad?.id ?? 0n },
    });
    expect(deliveries).toMatchObject([{ status: 'suppressed', suppressedReason: 'no_channel' }]);
    expect(
      await db.messageDelivery.count({
        where: {
          schoolId: r.school.id,
          messageId: { in: messages.map((m) => m.id) },
          channel: { in: ['whatsapp', 'sms', 'email'] },
        },
      }),
    ).toBe(0);
    expect(child1Login.userId).toBeDefined();
    expect((await auditOf(r, entry.id))[0]?.metadata).toMatchObject({
      notified: true,
      recipientGuardians: 3,
      recipientStudents: 1,
    });
  });

  it('R138, decision 7: a backdated entry writes no message', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie, { date: isoDay(-1) });
    expect(await messagesOf(r, entry.id)).toEqual([]);
    expect((await auditOf(r, entry.id))[0]?.metadata).toMatchObject({
      notified: false,
      recipientGuardians: 0,
    });
  });

  // ----------------------------------------------------------------------------- R142 reads

  it('R142: office staff are refused every diary route; a teacher of another section reads 404', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie);
    for (const path of [
      `/sections/${r.sectionA.id}/diary-entries`,
      `/diary-entries/${entry.id}`,
      `/diary-entries/${entry.id}/attachment`,
      `/diary-entries/${entry.id}/thumbnail`,
    ]) {
      expect((await h.get(api(path), r.office.cookie)).status).toBe(403);
      expect((await h.get(api(path), r.otherTeacher.cookie)).status).toBe(404);
    }
    expect((await write(r, r.office.cookie)).status).toBe(403);
    expect((await patch(entry.id, { topic: 'x' }, r.office.cookie)).status).toBe(403);
    expect((await patch(entry.id, { topic: 'x' }, r.otherTeacher.cookie)).status).toBe(404);

    const list = await h.get(api(`/sections/${r.sectionA.id}/diary-entries`), r.mathsTeacher.cookie);
    expect(list.status).toBe(200);
    expect((list.body as Page<DiaryEntryDto>).data.map((e) => e.id)).toEqual([entry.id]);
    const principal = await h.get(api(`/diary-entries/${entry.id}`), r.principal.cookie);
    expect(principal.status).toBe(200);
  });

  it('§4.1: dates filter and sort; a range over 366 days or reversed is 422', async () => {
    const r = await classroom(h);
    const older = await written(r, r.classTeacher.cookie, { date: isoDay(-2) });
    const newer = await written(r, r.classTeacher.cookie, { date: isoDay(-1) });
    const base = api(`/sections/${r.sectionA.id}/diary-entries`);
    const desc = await h.get(base, r.classTeacher.cookie);
    expect((desc.body as Page<DiaryEntryDto>).data.map((e) => e.id)).toEqual([newer.id, older.id]);
    const asc = await h.get(`${base}?sort=date&dateFrom=${isoDay(-2)}`, r.classTeacher.cookie);
    expect((asc.body as Page<DiaryEntryDto>).data.map((e) => e.id)).toEqual([older.id, newer.id]);
    const only = await h.get(`${base}?dateTo=${isoDay(-2)}`, r.classTeacher.cookie);
    expect((only.body as Page<DiaryEntryDto>).total).toBe(1);
    expect((await h.get(`${base}?dateFrom=${isoDay(-1)}&dateTo=${isoDay(-2)}`, r.classTeacher.cookie)).status).toBe(422);
    expect((await h.get(`${base}?dateFrom=${isoDay(-400)}&dateTo=${isoDay(0)}`, r.classTeacher.cookie)).status).toBe(422);
  });

  it('R142, §6.1: a guardian sees a child’s entries by the enrolment in force on each date: moved, joined mid-year, left', async () => {
    const r = await classroom(h);
    // child1 moved from A to B four days ago; child2 joined A two days ago (a re-enrolment
    // replaces the fixture's); a third child left A three days ago.
    await db.enrolment.updateMany({
      where: { schoolId: r.school.id, studentId: r.child1.id },
      data: { status: 'left', endedOn: new Date(`${isoDay(-5)}T00:00:00Z`) },
    });
    await enrol(db, r.school, r.child1, r.sectionB, { startedOn: isoDay(-4) });
    const late = await createStudent(db, r.school);
    await enrol(db, r.school, late, r.sectionA, { startedOn: isoDay(-2) });
    await linkGuardian(db, r.school, late, r.parent, { canLogin: true });
    const left = await createStudent(db, r.school, { status: 'withdrawn' });
    await enrol(db, r.school, left, r.sectionA, {
      startedOn: isoDay(-30),
      status: 'left',
      endedOn: isoDay(-3),
    });
    await linkGuardian(db, r.school, left, r.parent, { canLogin: true });

    const aOld = await written(r, r.principal.cookie, { date: isoDay(-6) });
    const aMid = await written(r, r.principal.cookie, { date: isoDay(-3) });
    const aNew = await written(r, r.principal.cookie, { date: isoDay(-1) });
    const bNew = await postIdem(
      h,
      api(`/sections/${r.sectionB.id}/diary-entries`),
      entryBody(r, { date: isoDay(-1) }),
      r.principal.cookie,
    );
    const bId = (bNew.body as DiaryEntryDto).id;

    const seen = async (studentId: bigint) => {
      const res = await h.get(api(`/me/children/${studentId}/diary-entries`), r.parentLogin.cookie);
      expect(res.status).toBe(200);
      return (res.body as Page<MyDiaryEntryDto>).data.map((e) => e.id).sort();
    };
    expect(await seen(r.child1.id)).toEqual([aOld.id, bId].sort());
    expect(await seen(late.id)).toEqual([aNew.id]);
    expect(await seen(left.id)).toEqual([aOld.id, aMid.id].sort());
    // A child not linked to this guardian: 404, the same as absent.
    const stranger = await createStudent(db, r.school);
    expect((await h.get(api(`/me/children/${stranger.id}/diary-entries`), r.parentLogin.cookie)).status).toBe(404);
  });

  it('R142, R165: a student reads their own entries; /me DTOs carry no author staff id, identity or phone', async () => {
    const r = await classroom(h);
    const entry = await written(r, r.classTeacher.cookie);
    const self = await studentLogin(db, r.school, r.child2);
    const res = await h.get(api('/me/student/diary-entries'), self.cookie);
    expect(res.status).toBe(200);
    const [mine] = (res.body as Page<MyDiaryEntryDto>).data;
    expect(mine).toMatchObject({ id: entry.id, className: 'Class Five', sectionName: 'Blue', authorName: 'Ayesha Class' });
    expect(Object.keys(mine ?? {}).sort()).toEqual(
      [
        'assignment',
        'attachmentMime',
        'attachmentSizeBytes',
        'authorName',
        'className',
        'classId',
        'createdAt',
        'date',
        'dueOn',
        'hasAttachment',
        'id',
        'learningOutcome',
        'sectionId',
        'sectionName',
        'subjectId',
        'subjectName',
        'topic',
        'updatedAt',
      ].sort(),
    );
    // Staff routes are not for a student or a guardian (R78).
    expect((await h.get(api(`/diary-entries/${entry.id}`), self.cookie)).status).toBe(403);
    expect((await h.get(api(`/diary-entries/${entry.id}`), r.parentLogin.cookie)).status).toBe(403);
  });

  it('R163, R164: ending the guardian link removes the child on the next request', async () => {
    const r = await classroom(h);
    await written(r, r.classTeacher.cookie);
    const path = api(`/me/children/${r.child1.id}/diary-entries`);
    expect((await h.get(path, r.parentLogin.cookie)).status).toBe(200);
    await db.studentGuardian.updateMany({
      where: { schoolId: r.school.id, studentId: r.child1.id, guardianId: r.parent.id },
      data: { endedAt: new Date() },
    });
    expect((await h.get(path, r.parentLogin.cookie)).status).toBe(404);
  });

  // -------------------------------------------------------------------- attachments, R171

  it('R171: a teacher stages and attaches an image; the thumbnail is a re-encode without EXIF; a non-recipient gets 404', async () => {
    const r = await classroom(h);
    const original = await jpegWithExif();
    const staged = await stage(original, r.classTeacher.cookie);
    const entry = await written(r, r.classTeacher.cookie, { stagedUploadId: staged.id });
    expect(entry).toMatchObject({ hasAttachment: true, attachmentMime: 'image/jpeg' });

    const file = await download(api(`/diary-entries/${entry.id}/attachment`), r.mathsTeacher.cookie);
    expect(file.status).toBe(200);
    expect(file.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'content-disposition': `attachment; filename="diary-${entry.id}.jpg"`,
    });
    // The thumbnail was made once, when the attachment was consumed, and stored beside it.
    const storage = h.app.get(ObjectStorage, { strict: false });
    const row = await db.diaryEntry.findFirst({ where: { schoolId: r.school.id, id: BigInt(entry.id) } });
    const key = thumbnailKey(row?.attachmentObjectKey ?? '');
    const stored = await buffer((await storage.get(key)).body);
    const thumb = await download(api(`/diary-entries/${entry.id}/thumbnail`), r.classTeacher.cookie);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-disposition']).toBe(`attachment; filename="diary-${entry.id}-thumb.jpg"`);
    const bytes = thumb.body as Buffer;
    expect(bytes.equals(stored)).toBe(true);
    expect(bytes.equals(original)).toBe(false);
    expect(bytes.includes(EXIF_MARKER)).toBe(false);
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    const meta = await sharp(bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(320);

    // An entry attached before thumbnails were stored: the first read makes and stores it.
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    const regenerated = await download(api(`/diary-entries/${entry.id}/thumbnail`), r.classTeacher.cookie);
    expect(regenerated.status).toBe(200);
    expect((await buffer((await storage.get(key)).body)).equals(regenerated.body as Buffer)).toBe(true);

    // The guardian of a child in the section reads it; another guardian, a guardian whose link
    // ended and a student of another section get 404 (§6.3).
    const own = await download(
      api(`/me/children/${r.child1.id}/diary-entries/${entry.id}/thumbnail`),
      r.parentLogin.cookie,
    );
    expect(own.status).toBe(200);
    const otherChild = await createStudent(db, r.school);
    await enrol(db, r.school, otherChild, r.sectionB, { startedOn: isoDay(-30) });
    const otherParent = await createGuardian(db, r.school);
    await linkGuardian(db, r.school, otherChild, otherParent, { canLogin: true });
    const otherLogin = await guardianLogin(db, r.school, otherParent);
    const otherStudent = await studentLogin(db, r.school, otherChild);
    for (const [path, cookie] of [
      [`/me/children/${otherChild.id}/diary-entries/${entry.id}/attachment`, otherLogin.cookie],
      [`/me/children/${r.child1.id}/diary-entries/${entry.id}/attachment`, otherLogin.cookie],
      [`/me/student/diary-entries/${entry.id}/attachment`, otherStudent.cookie],
      [`/me/student/diary-entries/${entry.id}/thumbnail`, otherStudent.cookie],
    ] as const) {
      const res = await download(api(path), cookie);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
    }
    await db.studentGuardian.updateMany({
      where: { schoolId: r.school.id, guardianId: r.parent.id, studentId: r.child1.id },
      data: { endedAt: new Date() },
    });
    expect(
      (await download(api(`/me/children/${r.child1.id}/diary-entries/${entry.id}/attachment`), r.parentLogin.cookie))
        .status,
    ).toBe(404);
  });

  it('R171: a PDF attachment has no thumbnail; another user’s staged id is REFERENCE_NOT_FOUND; a teacher cannot add a student document', async () => {
    const r = await classroom(h);
    const doc = await stage(pdf(), r.classTeacher.cookie);
    const entry = await written(r, r.classTeacher.cookie, { stagedUploadId: doc.id });
    expect(entry.attachmentMime).toBe('application/pdf');
    expect((await download(api(`/diary-entries/${entry.id}/thumbnail`), r.classTeacher.cookie)).status).toBe(404);
    expect((await download(api(`/diary-entries/${entry.id}/attachment`), r.classTeacher.cookie)).status).toBe(200);

    const clerks = await stage(pdf(), r.office.cookie);
    const borrowed = await write(r, r.classTeacher.cookie, {
      subjectId: String(r.english.id),
      stagedUploadId: clerks.id,
    });
    expect(fieldsOf(borrowed)[0]).toMatchObject({
      path: 'stagedUploadId',
      code: ErrorCode.REFERENCE_NOT_FOUND,
    });
    // Consumed once: the same staged id again is refused too.
    const reused = await write(r, r.classTeacher.cookie, {
      subjectId: String(r.english.id),
      stagedUploadId: doc.id,
    });
    expect(fieldsOf(reused)[0]?.code).toBe(ErrorCode.REFERENCE_NOT_FOUND);

    const teachers = await stage(pdf(), r.classTeacher.cookie);
    const asDocument = await h.send(
      'post',
      api(`/students/${r.child1.id}/documents`),
      { stagedUploadId: teachers.id, type: 'other' },
      r.classTeacher.cookie,
    );
    expect(asDocument.status).toBe(403);
  });

  it('§4.4: a patch replaces and removes the attachment; the replaced key stays in the history', async () => {
    const r = await classroom(h);
    const first = await stage(pdf(), r.classTeacher.cookie);
    const entry = await written(r, r.classTeacher.cookie, { stagedUploadId: first.id });
    const second = await stage(await jpegWithExif(), r.classTeacher.cookie);
    const replaced = await patch(entry.id, { stagedUploadId: second.id }, r.classTeacher.cookie);
    expect(replaced.body).toMatchObject({ attachmentMime: 'image/jpeg' });
    const removed = await patch(entry.id, { stagedUploadId: null }, r.classTeacher.cookie);
    expect(removed.body).toMatchObject({ hasAttachment: false, attachmentMime: null });
    const changes = await changesOf(r, entry.id);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.oldAttachmentObjectKey).toMatch(/\.pdf$/);
    expect(changes[1]?.newAttachmentObjectKey).toBeNull();
  });

  // ----------------------------------------------------------------------- R143 idempotency

  it('R143: a replay returns the same entry with 200 and Idempotency-Replayed; a different body or section is IDEMPOTENCY_KEY_REUSED', async () => {
    const r = await classroom(h);
    const key = idemKey();
    const first = await write(r, r.classTeacher.cookie, {}, key);
    expect(first.status).toBe(201);
    const replay = await write(r, r.classTeacher.cookie, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as DiaryEntryDto).id).toBe((first.body as DiaryEntryDto).id);
    const changed = await write(r, r.classTeacher.cookie, { topic: 'Different' }, key);
    expect(errorOf(changed).code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    const otherSection = await postIdem(
      h,
      api(`/sections/${r.sectionB.id}/diary-entries`),
      entryBody(r),
      r.principal.cookie,
      key,
    );
    expect(otherSection.status).toBe(201); // the principal's key is a different row (R84)
    const sameUserOtherSection = await postIdem(
      h,
      api(`/sections/${r.sectionB.id}/diary-entries`),
      entryBody(r),
      r.classTeacher.cookie,
      key,
    );
    expect(errorOf(sameUserOtherSection).code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect((await auditOf(r, (first.body as DiaryEntryDto).id))).toHaveLength(1);
  });

  it('R143: a refused create leaves the key unconsumed; a missing or malformed key is 422 before the body', async () => {
    const r = await classroom(h);
    const key = idemKey();
    const refused = await write(r, r.mathsTeacher.cookie, { subjectId: String(r.english.id) }, key);
    expect(errorOf(refused).code).toBe(ErrorCode.SUBJECT_NOT_ASSIGNED);
    const corrected = await write(r, r.mathsTeacher.cookie, {}, key);
    expect(corrected.status).toBe(201);

    const none = await postIdem(h, api(`/sections/${r.sectionA.id}/diary-entries`), { bogus: 1 }, r.classTeacher.cookie, null);
    expect(none.status).toBe(422);
    expect(fieldsOf(none)).toEqual([expect.objectContaining({ path: 'Idempotency-Key' })]);
    const digits = await write(r, r.classTeacher.cookie, {}, 'abc-3520212345671-xyz');
    expect(fieldsOf(digits)[0]?.path).toBe('Idempotency-Key');
  });

  it('R143: a racing same-key pair yields one entry', async () => {
    const r = await classroom(h);
    const key = idemKey();
    const [a, b] = await Promise.all([
      write(r, r.classTeacher.cookie, {}, key),
      write(r, r.classTeacher.cookie, {}, key),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((a.body as DiaryEntryDto).id).toBe((b.body as DiaryEntryDto).id);
    expect(await db.diaryEntry.count({ where: { schoolId: r.school.id } })).toBe(1);
  });
});
