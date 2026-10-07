// Slice 30 end to end (contracts/slice-30.md; phase-4-academic.md R261-R266): class tests and
// their edits and voids, the marks grid and its per-row submit (idempotent on the entry key,
// changed_elsewhere on a stale base), the subject-aware scope matrix, locked and voided
// assessments, excusals, the term's exam set-up and test_marked.
import request from 'supertest';
import { Capability, ErrorCode } from '@asms/shared';
import type {
  AssessmentDto,
  AssessmentMarkDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksMinimalResultDto,
  AssessmentSubmitMarksResultDto,
  ExamSetUpResultDto,
} from '../../src/modules/assessments/assessments.dto';
import { captureOutbox } from '../diary/support';
import { errorOf, ORIGIN, StaffHarness, type Caller } from '../staff/support';
import { closeTestDb } from '../support/schools';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import {
  createGuardian,
  createStudent,
  createTeacherAssignment,
  day,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import { api, entryKey, grant, markRoom, postKeyed, type MarkRoom } from './support';

interface Page<T> {
  data: T[];
  total: number;
}

describe('assessments and marks (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  beforeAll(async () => {
    await h.start();
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

  const HELD = isoDay(-5);
  const testBody = (r: MarkRoom, extra: object = {}) => ({
    classSubjectId: String(r.maths.classSubjectId),
    sectionId: String(r.sixA.id),
    testType: 'weekly',
    name: 'Fractions weekly test',
    maxMarks: 20,
    heldOn: HELD,
    ...extra,
  });
  async function createTest(r: MarkRoom, who: Caller, extra: object = {}): Promise<AssessmentDto> {
    const res = await postKeyed(h, api('/assessments'), testBody(r, extra), who.cookie);
    expect(res.status).toBe(201);
    return res.body as AssessmentDto;
  }
  const grid = (id: string, who: Caller) => h.get(api(`/assessments/${id}/marks`), who.cookie);
  const submit = (id: string, who: Caller, entries: object[], prefer?: string) => {
    const req = request(h.app.getHttpServer())
      .post(api(`/assessments/${id}/submit-marks`))
      .set('Cookie', who.cookie)
      .set('Origin', ORIGIN);
    return (prefer ? req.set('Prefer', prefer) : req).send({ entries });
  };
  const entry = (
    enrolmentId: bigint,
    value: number | 'absent',
    basedOnMarkId: string | null = null,
    key = entryKey(),
  ) => ({
    enrolmentId: String(enrolmentId),
    ...(value === 'absent' ? { absent: true } : { obtained: value }),
    clientEntryKey: key,
    basedOnMarkId,
  });
  const marksOf = (r: MarkRoom, assessmentId: string) =>
    db.mark.findMany({
      where: { schoolId: r.school.id, assessmentId: BigInt(assessmentId) },
      orderBy: { id: 'asc' },
    });
  const auditOf = (r: MarkRoom, action: string) =>
    db.auditLog.findMany({ where: { schoolId: r.school.id, action }, orderBy: { id: 'asc' } });

  // ------------------------------------------------------------------------- create (R264)

  it('a subject teacher creates a test in their section and subject; the key replays it', async () => {
    const r = await markRoom(h);
    const key = entryKey();
    const first = await postKeyed(h, api('/assessments'), testBody(r), r.mathsTeacher.cookie, key);
    expect(first.status).toBe(201);
    const created = first.body as AssessmentDto;
    expect(created).toMatchObject({
      kind: 'test',
      testType: 'weekly',
      name: 'Fractions weekly test',
      maxMarks: 20,
      heldOn: HELD,
      sectionId: String(r.sixA.id),
      subjectId: String(r.maths.id),
      subjectName: 'Mathematics',
      className: 'Six',
      sectionName: 'A',
      createdByMe: true,
      markedCount: 0,
      canEnterMarks: true,
    });
    const term = await db.academicTerm.findFirst({
      where: { schoolId: r.school.id, id: BigInt(created.termId) },
    });
    expect(term!.startsOn <= day(HELD) && day(HELD) <= term!.endsOn).toBe(true);
    const replay = await postKeyed(h, api('/assessments'), testBody(r), r.mathsTeacher.cookie, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as AssessmentDto).id).toBe(created.id);
    expect(await db.assessment.count({ where: { schoolId: r.school.id } })).toBe(1);
  });

  it('R264: a date outside every term, before the assignment, another subject or a class teacher’s other subject is refused', async () => {
    const r = await markRoom(h);
    // A date past every term (the year's end): refused whoever asks (an open-ended assignment
    // still reaches that date).
    for (const who of [r.mathsTeacher, r.principal]) {
      const outside = await postKeyed(
        h,
        api('/assessments'),
        testBody(r, { heldOn: isoDay(400) }),
        who.cookie,
      );
      expect(outside.status).toBe(409);
      expect(errorOf(outside).code).toBe(ErrorCode.ASSESSMENT_OUTSIDE_TERM);
    }
    // Before the assignment began: the section is theirs on other dates → 403 not_assigned_on_date.
    const early = await postKeyed(
      h,
      api('/assessments'),
      testBody(r, { heldOn: isoDay(-60) }),
      r.mathsTeacher.cookie,
    );
    expect(early.status).toBe(403);
    expect(errorOf(early).details).toMatchObject({ reason: 'not_assigned_on_date' });
    const english = await postKeyed(
      h,
      api('/assessments'),
      testBody(r, { classSubjectId: String(r.english.classSubjectId) }),
      r.mathsTeacher.cookie,
    );
    expect(english.status).toBe(409);
    expect(errorOf(english).code).toBe(ErrorCode.SUBJECT_NOT_ASSIGNED);
    // The class teacher reads every subject of 6-A but writes only one they teach (none).
    const byClassTeacher = await postKeyed(
      h,
      api('/assessments'),
      testBody(r),
      r.classTeacher.cookie,
    );
    expect(byClassTeacher.status).toBe(409);
    expect(errorOf(byClassTeacher).code).toBe(ErrorCode.SUBJECT_NOT_ASSIGNED);
    // 6-B, never theirs: 404.
    const otherSection = await postKeyed(
      h,
      api('/assessments'),
      testBody(r, { sectionId: String(r.sixB.id) }),
      r.mathsTeacher.cookie,
    );
    expect(otherSection.status).toBe(404);
    // Wave N review: the scope is checked before the class subject, so a section outside it is
    // the same 404 whether the class subject is real or not (no 422 tells the two apart).
    const unknownSubject = await postKeyed(
      h,
      api('/assessments'),
      testBody(r, { sectionId: String(r.sixB.id), classSubjectId: '999999999' }),
      r.mathsTeacher.cookie,
    );
    expect([unknownSubject.status, errorOf(unknownSubject).code]).toEqual([404, errorOf(otherSection).code]);
    expect(await db.assessment.count({ where: { schoolId: r.school.id } })).toBe(0);
  });

  // ------------------------------------------------------------------- grid and submit (R262)

  it('the grid lists the section’s enrolments in force on held_on; a joiner after it is not listed', async () => {
    const r = await markRoom(h);
    const late = await createStudent(db, r.school, { fullName: 'Late Joiner' });
    await enrol(db, r.school, late, r.sixA, { startedOn: isoDay(-2), rollNo: 3 });
    const test = await createTest(r, r.mathsTeacher);
    const res = await grid(test.id, r.mathsTeacher);
    expect(res.status).toBe(200);
    const body = res.body as AssessmentMarksDto;
    expect(body.assessment.id).toBe(test.id);
    expect(body.rows.map((row) => row.student.fullName)).toEqual(['Zara Khan', 'Ali Raza']);
    expect(body.rows[0]).toMatchObject({
      markId: null,
      status: null,
      obtained: null,
      absent: false,
      ownChildOf: null,
    });
  });

  it('R262: submit-marks creates, replays by key, supersedes on the seen mark, answers changed_elsewhere on a stale one', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const k1 = entryKey();
    const k2 = entryKey();
    const first = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 15, null, k1),
      entry(r.enrolment2, 'absent', null, k2),
    ]);
    expect(first.status).toBe(200);
    const result = first.body as AssessmentSubmitMarksResultDto;
    expect(result.entries.map((e) => e.outcome)).toEqual(['created', 'created']);
    expect(result.assessment.markedCount).toBe(2);
    const [m1, m2] = result.entries.map((e) => e.markId!);

    // A resend of the same entries (the phone lost the answer): the same answer, nothing written.
    const resend = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 15, null, k1),
      entry(r.enrolment2, 'absent', null, k2),
    ]);
    expect((resend.body as AssessmentSubmitMarksResultDto).entries).toEqual(result.entries);
    expect(await marksOf(r, test.id)).toHaveLength(2);

    // A change based on the live mark supersedes it; the same value is unchanged.
    const change = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 18, m1),
      entry(r.enrolment2, 'absent', m2),
    ]);
    const changed = (change.body as AssessmentSubmitMarksResultDto).entries;
    expect(changed.map((e) => e.outcome)).toEqual(['superseded', 'unchanged']);
    expect(changed[1]!.markId).toBe(m2);
    const rows = await marksOf(r, test.id);
    expect(rows.map((m) => [m.status, m.obtained])).toEqual([
      ['superseded', 15],
      ['live', null],
      ['live', 18],
    ]);
    expect(rows[2]!.supersedesId).toBe(BigInt(m1!));
    expect(rows[2]!.correctionReason).toBeNull();

    // A stale base (the phone saw m1, the live mark is now another): changed_elsewhere, the row
    // is not written; the other row of the batch lands.
    const stale = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 5, m1),
      entry(r.enrolment2, 7, m2),
    ]);
    const staleEntries = (stale.body as AssessmentSubmitMarksResultDto).entries;
    expect(staleEntries.map((e) => e.outcome)).toEqual(['changed_elsewhere', 'superseded']);
    expect(staleEntries[0]!.markId).toBe(changed[0]!.markId);
    const live = (await marksOf(r, test.id)).filter((m) => m.status === 'live');
    expect(live.map((m) => [m.enrolmentId, m.obtained]).sort()).toEqual(
      [
        [r.enrolment1, 18],
        [r.enrolment2, 7],
      ].sort(),
    );
    // A first entry made blind (basedOnMarkId null) while a mark exists is changed_elsewhere too.
    const blind = await submit(test.id, r.mathsTeacher, [entry(r.enrolment1, 1, null)]);
    expect((blind.body as AssessmentSubmitMarksResultDto).entries[0]!.outcome).toBe(
      'changed_elsewhere',
    );
    // No audit row for marks entry (plan §7.1).
    expect(
      await db.auditLog.count({ where: { schoolId: r.school.id, subjectType: 'assessment' } }),
    ).toBe(0);
  });

  it('Prefer: return=minimal answers the entries only', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const res = await submit(test.id, r.mathsTeacher, [entry(r.enrolment1, 12)], 'return=minimal');
    expect(res.status).toBe(200);
    expect(res.headers['preference-applied']).toBe('return=minimal');
    const body = res.body as AssessmentSubmitMarksMinimalResultDto;
    expect(Object.keys(body).sort()).toEqual(['assessmentId', 'entries']);
    expect(body.entries[0]).toMatchObject({
      outcome: 'created',
      enrolmentId: String(r.enrolment1),
    });
  });

  it('R261: a mark above the maximum refuses the whole request; a malformed entry is 422; a student off the grid is omitted', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const over = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 10),
      entry(r.enrolment2, 21),
    ]);
    expect(over.status).toBe(409);
    expect(errorOf(over).code).toBe(ErrorCode.MARK_EXCEEDS_MAX);
    expect(errorOf(over).details).toEqual({ enrolmentId: String(r.enrolment2), max: 20 });
    expect(await marksOf(r, test.id)).toHaveLength(0);
    const both = await submit(test.id, r.mathsTeacher, [
      { ...entry(r.enrolment1, 10), absent: true },
    ]);
    expect(both.status).toBe(422);
    const neither = await submit(test.id, r.mathsTeacher, [
      { enrolmentId: String(r.enrolment1), clientEntryKey: entryKey(), basedOnMarkId: null },
    ]);
    expect(neither.status).toBe(422);
    const twice = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolment1, 1),
      entry(r.enrolment1, 2),
    ]);
    expect(twice.status).toBe(422);
    const badKey = await submit(test.id, r.mathsTeacher, [
      { ...entry(r.enrolment1, 1), clientEntryKey: '1234567890123456789' },
    ]);
    expect(badKey.status).toBe(422);
    const offGrid = await submit(test.id, r.mathsTeacher, [
      entry(r.enrolmentB, 5),
      entry(r.enrolment1, 5),
    ]);
    expect(offGrid.status).toBe(200);
    expect(
      (offGrid.body as AssessmentSubmitMarksResultDto).entries.map((e) => e.enrolmentId),
    ).toEqual([String(r.enrolment1)]);
    // The database line holds the rule even for a direct write (R261).
    const [mark] = await marksOf(r, test.id);
    await expect(
      db.mark.updateMany({ where: { schoolId: r.school.id, id: mark!.id }, data: { obtained: 3 } }),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------- scope matrix (R263)

  it('R263: subject teachers, the class teacher, another section and grants each see exactly their scope', async () => {
    const r = await markRoom(h);
    const mathsA = await createTest(r, r.mathsTeacher);
    const englishA = await createTest(r, r.englishTeacher, {
      classSubjectId: String(r.english.classSubjectId),
      name: 'Spelling test',
    });
    const mathsB = await createTest(r, r.bTeacher, {
      sectionId: String(r.sixB.id),
      name: 'B maths',
    });

    // The Maths teacher of 6-A: neither 6-B nor 6-A English.
    expect((await grid(mathsA.id, r.mathsTeacher)).status).toBe(200);
    expect((await grid(mathsB.id, r.mathsTeacher)).status).toBe(404);
    expect((await grid(englishA.id, r.mathsTeacher)).status).toBe(404);
    expect((await h.get(api(`/assessments/${englishA.id}`), r.mathsTeacher.cookie)).status).toBe(
      404,
    );
    expect((await submit(englishA.id, r.mathsTeacher, [entry(r.enrolment1, 5)])).status).toBe(404);
    const listed = (await h.get(api('/assessments'), r.mathsTeacher.cookie))
      .body as Page<AssessmentDto>;
    expect(listed.data.map((a) => a.id)).toEqual([mathsA.id]);

    // The class teacher of 6-A reads every subject of 6-A and writes none (no subject of their own).
    const ctList = (await h.get(api('/assessments?sort=heldOn'), r.classTeacher.cookie))
      .body as Page<AssessmentDto>;
    expect(ctList.data.map((a) => a.id).sort()).toEqual([mathsA.id, englishA.id].sort());
    expect(ctList.data.every((a) => !a.canEnterMarks)).toBe(true);
    expect((await grid(englishA.id, r.classTeacher)).status).toBe(200);
    expect((await grid(mathsB.id, r.classTeacher)).status).toBe(404);
    expect((await submit(englishA.id, r.classTeacher, [entry(r.enrolment1, 5)])).status).toBe(404);

    // The principal reads and writes everything.
    const principalList = (await h.get(api('/assessments'), r.principal.cookie))
      .body as Page<AssessmentDto>;
    expect(principalList.total).toBe(3);
    expect((await submit(mathsB.id, r.principal, [entry(r.enrolmentB, 5)])).status).toBe(200);

    // Office: no marks key by default; a grant of marks.enter is school-wide (`all`).
    expect((await grid(mathsA.id, r.office)).status).toBe(403);
    await grant(h, r, r.office, Capability.MARKS_ENTER);
    const officeSession = await createSchoolSession(db, r.school, r.office);
    const office = { ...r.office, cookie: officeSession.cookie };
    expect((await submit(englishA.id, office, [entry(r.enrolment2, 9)])).status).toBe(200);

    // A teacher granted marks.view_all reads every section but still writes only their assignments.
    await grant(h, r, r.mathsTeacher, Capability.MARKS_VIEW_ALL);
    expect((await grid(mathsB.id, r.mathsTeacher)).status).toBe(200);
    expect((await grid(englishA.id, r.mathsTeacher)).status).toBe(200);
    expect((await submit(mathsB.id, r.mathsTeacher, [entry(r.enrolmentB, 6, null)])).status).toBe(
      404,
    );
    expect((await submit(englishA.id, r.mathsTeacher, [entry(r.enrolment1, 6)])).status).toBe(404);
    const gridB = (await grid(mathsB.id, r.mathsTeacher)).body as AssessmentMarksDto;
    expect(gridB.assessment.canEnterMarks).toBe(false);
  });

  it('R263: a cover reads the covered section only on its dates', async () => {
    const r = await markRoom(h);
    const cover = await h.caller(r.school, 'teacher', 'Kamran Cover');
    await createTeacherAssignment(db, r.school, cover, {
      role: 'cover',
      section: r.sixA,
      startsOn: isoDay(-6),
      endsOn: isoDay(-4),
    });
    const inside = await createTest(r, r.mathsTeacher, { heldOn: isoDay(-5) });
    const outside = await createTest(r, r.mathsTeacher, {
      heldOn: isoDay(-10),
      name: 'Earlier test',
    });
    expect((await grid(inside.id, cover)).status).toBe(200);
    expect((await grid(outside.id, cover)).status).toBe(404);
    // The cover holds the class-teacher scope: it reads, and writes no subject it does not teach.
    expect((await submit(inside.id, cover, [entry(r.enrolment1, 4)])).status).toBe(404);
  });

  // --------------------------------------------------------------------- edit and void (§2)

  it('PATCH: the creator edits until a mark exists; the date stays in the term; others are refused', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const patch = (who: Caller, body: object) =>
      h.send('patch', api(`/assessments/${test.id}`), body, who.cookie);
    const renamed = await patch(r.mathsTeacher, { name: 'Fractions quiz', maxMarks: 25 });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Fractions quiz', maxMarks: 25 });
    const [audit] = await auditOf(r, 'assessment.updated');
    expect(audit!.metadata).toMatchObject({
      changes: {
        name: { from: 'Fractions weekly test', to: 'Fractions quiz' },
        maxMarks: { from: 20, to: 25 },
      },
    });
    // Another teacher of the same section and subject? None; the class teacher cannot write it: 404.
    expect((await patch(r.classTeacher, { name: 'Taken' })).status).toBe(404);
    const term = await db.academicTerm.findFirst({
      where: { schoolId: r.school.id, id: BigInt(test.termId) },
    });
    const beyond = new Date(term!.endsOn.getTime() + 86_400_000).toISOString().slice(0, 10);
    const moved = await patch(r.principal, { heldOn: beyond });
    expect(moved.status).toBe(409);
    expect(errorOf(moved).code).toBe(ErrorCode.ASSESSMENT_OUTSIDE_TERM);
    await submit(test.id, r.mathsTeacher, [entry(r.enrolment1, 10)]);
    const late = await patch(r.mathsTeacher, { maxMarks: 30 });
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe(ErrorCode.ASSESSMENT_HAS_MARKS);
    // A no-op PATCH is free once marks exist.
    expect((await patch(r.mathsTeacher, { maxMarks: 25 })).status).toBe(200);
  });

  it('void: audited, then no marks and no edits; TERM_IN_USE once a live assessment names the term', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const termPatch = await h.send(
      'patch',
      api(`/terms/${test.termId}`),
      { weight: 60 },
      r.principal.cookie,
    );
    expect(termPatch.status).toBe(409);
    expect(errorOf(termPatch).code).toBe(ErrorCode.TERM_IN_USE);
    const voided = await h.send(
      'post',
      api(`/assessments/${test.id}/void`),
      { reason: 'Wrong section' },
      r.mathsTeacher.cookie,
    );
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ voidReason: 'Wrong section', canEnterMarks: false });
    expect((await auditOf(r, 'assessment.voided'))[0]).toMatchObject({ reason: 'Wrong section' });
    const after = await submit(test.id, r.mathsTeacher, [entry(r.enrolment1, 5)]);
    expect(after.status).toBe(409);
    expect(errorOf(after).code).toBe(ErrorCode.ASSESSMENT_VOIDED);
    const again = await h.send(
      'post',
      api(`/assessments/${test.id}/void`),
      { reason: 'Again' },
      r.mathsTeacher.cookie,
    );
    expect(errorOf(again).code).toBe(ErrorCode.ASSESSMENT_VOIDED);
    // Voided: hidden from the list unless asked for.
    const list = (await h.get(api('/assessments'), r.mathsTeacher.cookie))
      .body as Page<AssessmentDto>;
    expect(list.total).toBe(0);
    const withVoided = (await h.get(api('/assessments?includeVoided=true'), r.mathsTeacher.cookie))
      .body as Page<AssessmentDto>;
    expect(withVoided.total).toBe(1);
    // The term is free again: no live assessment names it.
    expect(
      (await h.send('patch', api(`/terms/${test.termId}`), { weight: 60 }, r.principal.cookie))
        .status,
    ).toBe(200);
  });

  // ------------------------------------------------------------------ locked, excused (R265)

  it('R265: a locked test takes no live mark; the approver may still excuse an absence on it', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const first = (await submit(test.id, r.mathsTeacher, [entry(r.enrolment2, 'absent')]))
      .body as AssessmentSubmitMarksResultDto;
    const absentId = first.entries[0]!.markId!;
    await db.assessment.updateMany({
      where: { schoolId: r.school.id, id: BigInt(test.id) },
      data: { lockedAt: new Date() },
    });
    const locked = await submit(test.id, r.mathsTeacher, [entry(r.enrolment1, 5)]);
    expect(locked.status).toBe(409);
    expect(errorOf(locked).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    expect(
      (await h.send('patch', api(`/assessments/${test.id}`), { name: 'X' }, r.mathsTeacher.cookie))
        .status,
    ).toBe(409);

    const teacherTry = await h.send(
      'post',
      api(`/marks/${absentId}/excuse`),
      { reason: 'Was ill' },
      r.mathsTeacher.cookie,
    );
    expect(teacherTry.status).toBe(403);
    const excused = await h.send(
      'post',
      api(`/marks/${absentId}/excuse`),
      { reason: 'Medical certificate' },
      r.principal.cookie,
    );
    expect(excused.status).toBe(200);
    const mark = excused.body as AssessmentMarkDto;
    expect(mark).toMatchObject({
      absent: true,
      excused: true,
      status: 'live',
      supersedesId: absentId,
      correctionReason: 'Medical certificate',
    });
    const old = await db.mark.findFirst({ where: { schoolId: r.school.id, id: BigInt(absentId) } });
    expect(old!.status).toBe('superseded');
    expect((await auditOf(r, 'mark.excused'))[0]!.metadata).toMatchObject({
      supersedesId: absentId,
      selfApproved: false,
    });
    const twice = await h.send(
      'post',
      api(`/marks/${mark.id}/excuse`),
      { reason: 'Again please' },
      r.principal.cookie,
    );
    expect(twice.status).toBe(409);
    expect(errorOf(twice).code).toBe(ErrorCode.ILLEGAL_STATUS_TRANSITION);
  });

  it('excuse: only an absence; refused on the approver’s own child unless they are the sole principal', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const res = (
      await submit(test.id, r.mathsTeacher, [
        entry(r.enrolment1, 'absent'),
        entry(r.enrolment2, 12),
      ])
    ).body as AssessmentSubmitMarksResultDto;
    const [ownChildAbsence, scored] = res.entries.map((e) => e.markId!);
    const notAbsent = await h.send(
      'post',
      api(`/marks/${scored}/excuse`),
      { reason: 'Not an absence' },
      r.principal.cookie,
    );
    expect(errorOf(notAbsent).code).toBe(ErrorCode.ILLEGAL_STATUS_TRANSITION);

    // The principal is also child1's guardian; with a second principal they may not decide it.
    const father = await createGuardian(db, r.school, { fullName: 'Principal Father' });
    await linkGuardian(db, r.school, r.child1, father, {
      isPrimaryContact: false,
      isFeePayer: false,
      relationship: 'father',
    });
    await db.user.updateMany({
      where: { schoolId: r.school.id, id: r.principal.userId },
      data: { guardianId: father.id },
    });
    const second = await createSchoolUser(db, r.school, { systemRole: 'principal' });
    const refused = await h.send(
      'post',
      api(`/marks/${ownChildAbsence}/excuse`),
      { reason: 'My own child' },
      r.principal.cookie,
    );
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.SELF_ACTION_FORBIDDEN,
      details: { reason: 'own_child' },
    });
    // The second principal ends; the first is now the sole principal: allowed, recorded.
    await db.userRole.updateMany({
      where: { schoolId: r.school.id, id: second.userRoleId },
      data: { endedAt: new Date(), endedBy: r.principal.userId },
    });
    const sole = await h.send(
      'post',
      api(`/marks/${ownChildAbsence}/excuse`),
      { reason: 'Sole principal decides' },
      r.principal.cookie,
    );
    expect(sole.status).toBe(200);
    expect((await auditOf(r, 'mark.excused'))[0]!.metadata).toMatchObject({ selfApproved: true });
    // The grid flags the caller's own child.
    const flagged = (await grid(test.id, r.principal)).body as AssessmentMarksDto;
    expect(flagged.rows.find((row) => row.enrolmentId === String(r.enrolment1))!.ownChildOf).toBe(
      String(r.principal.userId),
    );
  });

  // ------------------------------------------------------------------------- set-up (R257)

  it('R257: set-up creates one exam per class-subject per live section, idempotently, skipping a not-held class', async () => {
    const r = await markRoom(h);
    const terms = await db.academicTerm.findMany({
      where: { schoolId: r.school.id, academicYearId: r.year.id },
      orderBy: { sortOrder: 'asc' },
    });
    const [midTerm, annual] = terms;
    const setUp = (termId: bigint, who: Caller, body: object = {}) =>
      h.send('post', api(`/terms/${termId}/set-up-exams`), body, who.cookie);
    expect((await setUp(midTerm!.id, r.mathsTeacher)).status).toBe(403);
    const first = await setUp(midTerm!.id, r.principal);
    expect(first.status).toBe(200);
    expect(first.body as ExamSetUpResultDto).toEqual({ created: 4, existing: 0, skipped: 0 });
    const exams = await db.assessment.findMany({
      where: { schoolId: r.school.id, kind: 'exam', termId: midTerm!.id },
    });
    expect(exams).toHaveLength(4);
    expect(
      exams.every(
        (e) =>
          e.maxMarks === 100 &&
          e.heldOn.getTime() === midTerm!.endsOn.getTime() &&
          e.testType === null,
      ),
    ).toBe(true);
    expect(
      await setUp(midTerm!.id, r.principal).then((res) => res.body as ExamSetUpResultDto),
    ).toEqual({ created: 0, existing: 4, skipped: 0 });
    expect(await auditOf(r, 'exams.set_up')).toHaveLength(1);

    await h.send(
      'post',
      api(`/terms/${annual!.id}/skip-class`),
      { classId: String(r.klass.id), reason: 'No annual exam' },
      r.principal.cookie,
    );
    expect(
      await setUp(annual!.id, r.principal, { classIds: [String(r.klass.id)] }).then(
        (res) => res.body as ExamSetUpResultDto,
      ),
    ).toEqual({
      created: 0,
      existing: 0,
      skipped: 4,
    });
    const unknown = await setUp(midTerm!.id, r.principal, { classIds: ['999999999'] });
    expect(unknown.status).toBe(422);

    // The subject teacher enters exam marks like test marks; a void frees the slot for set-up.
    const mathsExamA = exams.find(
      (e) => e.sectionId === r.sixA.id && e.classSubjectId === r.maths.classSubjectId,
    )!;
    const examGrid = (await grid(String(mathsExamA.id), r.mathsTeacher)).body as AssessmentMarksDto;
    expect(examGrid.assessment).toMatchObject({
      kind: 'exam',
      canEnterMarks: true,
      createdByMe: false,
    });
    expect(
      (await submit(String(mathsExamA.id), r.mathsTeacher, [entry(r.enrolment1, 77)])).status,
    ).toBe(200);
    // Not the creator, no assessment.define: the teacher cannot void the exam.
    expect(
      (
        await h.send(
          'post',
          api(`/assessments/${mathsExamA.id}/void`),
          { reason: 'Mine now' },
          r.mathsTeacher.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.send(
          'post',
          api(`/assessments/${mathsExamA.id}/void`),
          { reason: 'Set up again' },
          r.principal.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      await setUp(midTerm!.id, r.principal).then((res) => res.body as ExamSetUpResultDto),
    ).toEqual({ created: 1, existing: 3, skipped: 0 });
  });

  // ---------------------------------------------------------------------- test_marked (R266)

  it('R266: test_marked only with notify_class_tests on, only for a first mark on a test', async () => {
    const r = await markRoom(h);
    const messages = () =>
      db.message.findMany({ where: { schoolId: r.school.id, type: 'test_marked' } });
    const off = await createTest(r, r.mathsTeacher);
    await submit(off.id, r.mathsTeacher, [entry(r.enrolment1, 10)]);
    expect(await messages()).toHaveLength(0);

    await db.resultSettings.updateMany({
      where: { schoolId: r.school.id, academicYearId: r.year.id },
      data: { notifyClassTests: true },
    });
    const on = await createTest(r, r.mathsTeacher, { name: 'Decimals test' });
    const first = (await submit(on.id, r.mathsTeacher, [entry(r.enrolment1, 10)]))
      .body as AssessmentSubmitMarksResultDto;
    const sent = await messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      subjectType: 'assessment',
      subjectId: BigInt(on.id),
      priority: 'low',
    });
    expect(sent[0]!.body).toContain('Decimals test marked');
    expect(sent[0]!.body).not.toContain('10');
    // A re-entry does not notify again.
    await submit(on.id, r.mathsTeacher, [entry(r.enrolment1, 11, first.entries[0]!.markId)]);
    expect(await messages()).toHaveLength(1);
  });

  it('a guardian or student session cannot reach the staff routes', async () => {
    const r = await markRoom(h);
    const test = await createTest(r, r.mathsTeacher);
    const res = await request(h.app.getHttpServer())
      .get(api(`/assessments/${test.id}/marks`))
      .set('Cookie', r.parentLogin.cookie);
    expect(res.status).toBe(403);
  });
});
