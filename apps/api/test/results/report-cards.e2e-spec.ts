// Slice 32 end to end (contracts/slice-32.md; phase-4-academic.md R279-R284, R296's correction part,
// and the certificate part of R289-R291): the stored row is the report card; the prints are
// scriptless and audited; a correction after publication is a pending row another person decides,
// and its approval re-composes the term sheet (and the published final) as a new version that
// tells the corrected family alone; an excusal after publication does the same at once;
// withholding reads the dues endpoint at request time; academic and completion certificates print
// the published result's marks table.
import { Client } from 'pg';
import request from 'supertest';
import { Capability, ErrorCode } from '@asms/shared';
import type { CertificateDto } from '../../src/modules/certificates/certificates.dto';
import type {
  MarkCorrectionDecisionDto,
  MarkCorrectionDto,
} from '../../src/modules/assessments/mark-corrections.dto';
import type { MyChildResultsDto } from '../../src/modules/results/my-results.dto';
import type { ResultDto, ResultSheetDetailDto } from '../../src/modules/results/results.dto';
import { NotificationService } from '../../src/messaging/notification.service';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ResultNotifyJob } from '../../src/modules/results/result-notify.job';
import { captureOutbox } from '../diary/support';
import { grant } from '../assessments/support';
import { errorOf, ORIGIN, StaffHarness, type Caller } from '../staff/support';
import { closeTestDb } from '../support/schools';
import { createSchoolUser } from '../support/school-session';
import { createGuardian, createSubject, createTeacherAssignment, isoDay, linkGuardian } from '../support/students';
import {
  api,
  entryKey,
  markMidTerm,
  openSheet,
  postKeyed,
  resultRoom,
  sheetVerb,
  type ResultRoom,
} from './support';

interface Page<T> {
  data: T[];
  total: number;
}

describe('report cards, corrections, certificates marks (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let revisedTold: bigint[] = [];

  beforeAll(async () => {
    await h.start();
  });

  beforeEach(() => {
    captureOutbox(h);
    revisedTold = [];
    const outbox = h.app.get(OutboxDispatcher, { strict: false });
    jest.spyOn(outbox, 'resultNotifyAfterCommit').mockImplementation(() => undefined);
    jest.spyOn(outbox, 'resultRevisedNotifyAfterCommit').mockImplementation((_schoolId, resultId) => {
      revisedTold.push(resultId);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const HELD = isoDay(-5);

  /** 6-A's Mid-term marked, a remark written, submitted by the class teacher and approved (published). */
  async function publishMidTerm(r: ResultRoom, remark = 'A steady, careful worker.'): Promise<ResultSheetDetailDto> {
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    const remarked = await h.send(
      'patch',
      api(`/result-sheets/${sheet.id}`),
      { remarks: [{ enrolmentId: String(r.enrolment1), remark }] },
      r.classTeacher.cookie,
    );
    expect(remarked.status).toBe(200);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const approved = await sheetVerb(h, sheet.id, 'approve', r.principal);
    expect(approved.status).toBe(200);
    return approved.body as ResultSheetDetailDto;
  }

  const liveRow = (r: ResultRoom, enrolmentId: bigint, termId: bigint | null = r.midTermId) =>
    db.result.findFirstOrThrow({
      where: { schoolId: r.school.id, enrolmentId, termId, supersededAt: null },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
    });

  const liveMark = (r: ResultRoom, assessmentId: bigint, enrolmentId: bigint) =>
    db.mark.findFirstOrThrow({ where: { schoolId: r.school.id, assessmentId, enrolmentId, status: 'live' } });

  const print = (path: string, who: Caller, site?: string) => {
    const req = request(h.app.getHttpServer()).get(api(path)).set('Cookie', who.cookie);
    return site === undefined ? req : req.set('Sec-Fetch-Site', site);
  };

  const correct = (markId: bigint | string, body: object, who: Caller, key = entryKey()) =>
    postKeyed(h, api(`/marks/${markId}/correct`), body, who.cookie, key);

  const decide = (id: string, verb: 'approve' | 'reject', who: Caller, reason?: string) =>
    h.send('post', api(`/mark-corrections/${id}/${verb}`), reason === undefined ? {} : { reason }, who.cookie);

  it('R279, R283, R284: the card is the stored row; prints are scriptless, escaped and audited; the toggles hide; cross-site refused', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r, 'Good <b>work</b> & "steady"');
    const row = await liveRow(r, r.enrolment1);

    const card = await h.get(api(`/results/${row.id}`), r.principal.cookie);
    expect(card.status).toBe(200);
    const dto = card.body as ResultDto;
    expect(dto).toMatchObject({
      id: String(row.id),
      sheetVersion: 1,
      schoolName: expect.any(String),
      termName: 'Mid-term',
      isFinal: false,
      className: 'Six',
      sectionName: 'A',
      studentName: 'Zara Khan',
      rollNo: 1,
      totalObtained: row.totalObtained,
      totalMax: row.totalMax,
      percentBp: row.percentBp,
      grade: row.grade,
      passed: row.passed,
      position: row.position,
      positionOf: row.positionOf,
      attendanceBp: row.attendanceBp,
      remark: 'Good <b>work</b> & "steady"',
      revised: false,
      supersededAt: null,
    });
    expect(dto.subjects.map((s) => [s.subjectName, s.obtained, s.max, s.percentBp, s.grade])).toEqual(
      row.subjects.map((s) => [s.subjectName, s.obtained, s.max, s.percentBp, s.grade]),
    );
    expect(JSON.stringify(dto)).not.toContain('ownChildOf');

    // Who reads: marks.view_all (the principal; an office grant), never a teacher or a guardian.
    expect((await h.get(api(`/results/${row.id}`), r.classTeacher.cookie)).status).toBe(403);
    expect((await h.get(api(`/results/${row.id}`), r.parentLogin.cookie)).status).toBe(403);
    expect((await h.get(api('/results/999999999'), r.principal.cookie)).status).toBe(404);

    // R283: no script, every text escaped; audited with ids only.
    const page = await print(`/results/${row.id}/print`, r.principal);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).toContain('Good &lt;b&gt;work&lt;/b&gt; &amp; &quot;steady&quot;');
    expect(page.text).toContain('Zara Khan');
    expect(page.text).toContain('Class teacher');
    expect(page.text).toContain('Principal');
    expect(page.text).toContain(`${row.position} / ${row.positionOf}`);
    expect(page.text).not.toContain('Revised');
    const printed = await db.auditLog.findMany({ where: { schoolId: r.school.id, action: 'result.printed' } });
    expect(printed.map((a) => a.metadata)).toEqual([{ resultId: String(row.id), sheetId: String(row.sheetId) }]);

    const sheetPage = await print(`/result-sheets/${row.sheetId}/print`, r.principal);
    expect(sheetPage.status).toBe(200);
    expect(sheetPage.text.match(/class="card"/g)).toHaveLength(2);
    expect(sheetPage.text.indexOf('Zara Khan')).toBeLessThan(sheetPage.text.indexOf('Ali Raza'));
    const sheetAudit = await db.auditLog.findMany({ where: { schoolId: r.school.id, action: 'result_sheet.printed' } });
    expect(sheetAudit.map((a) => a.metadata)).toEqual([{ sheetId: String(row.sheetId), cards: 2 }]);

    // A cross-site browser request is refused before it is counted.
    expect((await print(`/results/${row.id}/print`, r.principal, 'cross-site')).status).toBe(403);
    expect((await print(`/result-sheets/${row.sheetId}/print`, r.principal, 'same-site')).status).toBe(403);
    expect(await db.auditLog.count({ where: { schoolId: r.school.id, action: 'result.printed' } })).toBe(1);

    // The display toggles (editable after approval) hide position, attendance and remark.
    const toggles = await h.send(
      'patch',
      api(`/academic-years/${r.year.id}/result-settings`),
      { showPosition: false, showAttendance: false, showRemark: false },
      r.principal.cookie,
    );
    expect(toggles.status).toBe(200);
    const hidden = (await h.get(api(`/results/${row.id}`), r.principal.cookie)).body as ResultDto;
    expect(hidden).toMatchObject({
      position: null,
      positionOf: null,
      attendanceBp: null,
      remark: null,
      showPosition: false,
      showAttendance: false,
      showRemark: false,
      // The figures themselves are the stored row's (R279).
      percentBp: row.percentBp,
      totalObtained: row.totalObtained,
    });
    const hiddenPage = (await print(`/results/${row.id}/print`, r.principal)).text;
    expect(hiddenPage).not.toContain('Position');
    expect(hiddenPage).not.toContain('Attendance');
    expect(hiddenPage).not.toContain('steady');
  });

  it('R280, R281: a correction is a pending row, decided by another; approval re-composes version n+1, re-ranks, keeps the old rows, tells the corrected family once each', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const mathsExam = await liveMark(r, r.exams.mathsA, r.enrolment2);

    // Before publication a correction is refused: the sheet is returned and the mark re-entered.
    const early = await correct(mathsExam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher);
    expect(early.status).toBe(409);
    expect(errorOf(early).code).toBe(ErrorCode.MARK_CORRECTION_SHEET_NOT_PUBLISHED);

    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    expect((await sheetVerb(h, sheet.id, 'approve', r.principal)).status).toBe(200);
    const before1 = await liveRow(r, r.enrolment1);
    const before2 = await liveRow(r, r.enrolment2);
    expect([before1.position, before2.position]).toEqual([1, 2]);

    // Scope: the English teacher may not correct a Maths mark; a mark beyond the max is refused.
    expect((await correct(mathsExam.id, { obtained: 95, reason: 'Not mine' }, r.englishTeacher)).status).toBe(404);
    const tooHigh = await correct(mathsExam.id, { obtained: 101, reason: 'Too many' }, r.mathsTeacher);
    expect(errorOf(tooHigh).code).toBe(ErrorCode.MARK_EXCEEDS_MAX);
    const same = await correct(mathsExam.id, { obtained: 55, reason: 'Same value' }, r.mathsTeacher);
    expect(same.status).toBe(422);

    // The request: pending, keyed (a replay answers the same row), one at a time per mark.
    const key = entryKey();
    const asked = await correct(mathsExam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher, key);
    expect(asked.status).toBe(201);
    const pending = asked.body as MarkCorrectionDto;
    expect(pending).toMatchObject({
      status: 'pending',
      from: { obtained: 55, absent: false, excused: false },
      to: { obtained: 95, absent: false, excused: false },
      reason: 'Paper re-totalled',
      requestedByMe: true,
      studentName: 'Ali Raza',
    });
    const replay = await correct(mathsExam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as MarkCorrectionDto).id).toBe(pending.id);
    const twice = await correct(mathsExam.id, { obtained: 90, reason: 'Again' }, r.mathsTeacher);
    expect(errorOf(twice).code).toBe(ErrorCode.ILLEGAL_STATUS_TRANSITION);
    // The live mark is unchanged until the decision; the card too.
    expect((await liveMark(r, r.exams.mathsA, r.enrolment2)).id).toBe(mathsExam.id);

    // The queue: result.approve or marks.view_all.
    const queue = await h.get(api('/mark-corrections?status=pending'), r.principal.cookie);
    expect((queue.body as Page<MarkCorrectionDto>).data.map((c) => c.id)).toEqual([pending.id]);
    expect((await h.get(api('/mark-corrections'), r.mathsTeacher.cookie)).status).toBe(403);

    // R281: the requester never decides their own correction, even holding result.approve.
    await grant(h, r, r.mathsTeacher, Capability.RESULT_APPROVE);
    const own = await decide(pending.id, 'approve', r.mathsTeacher);
    expect(own.status).toBe(409);
    expect(errorOf(own)).toMatchObject({ code: ErrorCode.SELF_ACTION_FORBIDDEN, details: { reason: 'author' } });

    // The principal approves: version 2, born published, the full row set.
    const approved = await decide(pending.id, 'approve', r.principal);
    expect(approved.status).toBe(200);
    const decision = approved.body as MarkCorrectionDecisionDto;
    expect(decision.mark).toMatchObject({ status: 'approved', decidedByName: 'Nadia Principal' });
    expect(decision.revisedResult).toMatchObject({ sheetVersion: 2, revised: true, studentName: 'Ali Raza' });
    const versions = await db.resultSheet.findMany({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => [v.version, v.status, v.supersedesId])).toEqual([
      [1, 'published', null],
      [2, 'published', versions[0]!.id],
    ]);
    const after1 = await liveRow(r, r.enrolment1);
    const after2 = await liveRow(r, r.enrolment2);
    expect([after1.sheetId, after2.sheetId]).toEqual([versions[1]!.id, versions[1]!.id]);
    expect([after1.supersedesId, after2.supersedesId]).toEqual([before1.id, before2.id]);
    // Zara's figures did not change; Ali's Maths did (0.2 × 50 % + 0.8 × 95 % = 86 %).
    expect(after1).toMatchObject({ revised: false, percentBp: before1.percentBp, remark: before1.remark });
    expect(after2.revised).toBe(true);
    expect(after2.subjects.find((s) => s.classSubjectId === r.maths.classSubjectId)?.percentBp).toBe(8600);
    expect(after2.attendanceBp).toBe(before2.attendanceBp);
    // The old rows stay readable, superseded; the mark chain moved.
    expect((await db.result.findFirstOrThrow({ where: { schoolId: r.school.id, id: before2.id } })).supersededAt).not.toBeNull();
    expect(await db.mark.findFirstOrThrow({ where: { schoolId: r.school.id, id: mathsExam.id } })).toMatchObject({ status: 'superseded' });
    expect((await liveMark(r, r.exams.mathsA, r.enrolment2)).id).toBe(BigInt(pending.id));
    // Told once: Ali's family only (result_revised through result-notify { resultId }).
    expect(revisedTold).toEqual([after2.id]);
    expect(after1.notifiedAt === null).toBe(before1.notifiedAt === null);

    // R284: the superseded card prints "Superseded"; the revised one "Revised" with the date.
    expect((await print(`/results/${before2.id}/print`, r.principal)).text).toContain('SUPERSEDED');
    expect((await print(`/results/${after2.id}/print`, r.principal)).text).toContain('Revised on');
    expect(((await h.get(api(`/results/${before2.id}`), r.principal.cookie)).body as ResultDto).supersededAt).not.toBeNull();

    // A second correction (English absent → 100) re-ranks: Ali is now first, Zara's row revised by
    // its position; still only Ali's family is told (A15: one message per correction).
    const english = await liveMark(r, r.exams.englishA, r.enrolment2);
    const second = (await correct(english.id, { obtained: 100, reason: 'Script found' }, r.englishTeacher)).body as MarkCorrectionDto;
    // A rejection first: pending only once decided.
    const rejected = await decide(second.id, 'reject', r.principal, 'Ask the examiner first');
    expect((rejected.body as MarkCorrectionDto).status).toBe('rejected');
    expect(errorOf(await decide(second.id, 'approve', r.principal)).code).toBe(ErrorCode.MARK_CORRECTION_NOT_PENDING);
    const third = (await correct(english.id, { obtained: 100, reason: 'Script found, checked' }, r.englishTeacher)).body as MarkCorrectionDto;
    expect((await decide(third.id, 'approve', r.principal)).status).toBe(200);
    const final1 = await liveRow(r, r.enrolment1);
    const final2 = await liveRow(r, r.enrolment2);
    expect([final1.position, final2.position]).toEqual([2, 1]);
    expect([final1.revised, final2.revised]).toEqual([true, true]);
    expect(revisedTold).toEqual([after2.id, final2.id]);
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId } })).toBe(3);

    // Audited: requested, approved (with the new rows' ids), rejected with its reason.
    const actions = await db.auditLog.findMany({
      where: { schoolId: r.school.id, action: { startsWith: 'mark_correction.' } },
      orderBy: { id: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'mark_correction.requested',
      'mark_correction.approved',
      'mark_correction.requested',
      'mark_correction.rejected',
      'mark_correction.requested',
      'mark_correction.approved',
    ]);
    expect(actions[3]?.reason).toBe('Ask the examiner first');
    expect(actions[1]?.metadata).toMatchObject({ resultId: String(after2.id), revised: true, selfApproved: false });
  });

  it('R281: the decider\'s own child is refused; the sole principal approves their own request, recorded', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment1);
    // The principal is also child1's guardian; with a second principal they may not decide it.
    const father = await createGuardian(db, r.school, { fullName: 'Principal Father' });
    await linkGuardian(db, r.school, r.child1, father, { isPrimaryContact: false, isFeePayer: false, relationship: 'father' });
    await db.user.updateMany({ where: { schoolId: r.school.id, id: r.principal.userId }, data: { guardianId: father.id } });
    const second = await createSchoolUser(db, r.school, { systemRole: 'principal' });
    const asked = (await correct(exam.id, { obtained: 81, reason: 'One mark missed' }, r.mathsTeacher)).body as MarkCorrectionDto;
    const refused = await decide(asked.id, 'approve', r.principal);
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.SELF_ACTION_FORBIDDEN, details: { reason: 'own_child' } });
    expect(errorOf(await decide(asked.id, 'reject', r.principal, 'Not mine to decide')).details).toMatchObject({ reason: 'own_child' });
    await db.userRole.updateMany({
      where: { schoolId: r.school.id, id: second.userRoleId },
      data: { endedAt: new Date(), endedBy: r.principal.userId },
    });
    // Sole principal: their own child and their own request pass, recorded selfApproved.
    const exam2 = await liveMark(r, r.exams.englishA, r.enrolment1);
    const mine = (await correct(exam2.id, { obtained: 72, reason: 'Totalled again' }, r.principal)).body as MarkCorrectionDto;
    expect((await decide(mine.id, 'approve', r.principal)).status).toBe(200);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { schoolId: r.school.id, action: 'mark_correction.approved' },
    });
    expect(audit.metadata).toMatchObject({ selfApproved: true, selfRequest: true, ownChild: true, selfSubmitter: false });
  });

  it('contracts/slice-32.md §4: an excusal after publication is a correction — a new version at once, the family told', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const before = await liveRow(r, r.enrolment2);
    const absence = await liveMark(r, r.exams.englishA, r.enrolment2);
    const excused = await h.send('post', api(`/marks/${absence.id}/excuse`), { reason: 'Hospitalised' }, r.principal.cookie);
    expect(excused.status).toBe(200);
    const after = await liveRow(r, r.enrolment2);
    expect(after.supersedesId).toBe(before.id);
    expect(after.revised).toBe(true);
    // English is now not assessed (no test, exam excused): printed "—", out of the totals.
    expect(after.subjects.find((s) => s.classSubjectId === r.english.classSubjectId)?.status).toBe('not_assessed');
    expect(after.totalMax).toBe(before.totalMax - 100);
    expect(revisedTold).toEqual([after.id]);
    const audit = await db.auditLog.findFirstOrThrow({ where: { schoolId: r.school.id, action: 'mark.excused' } });
    expect(audit.metadata).toMatchObject({ revisedResultId: String(after.id) });
  });

  it('contracts/slice-32.md §4: an excusal while the term sheet is approved but unpublished is refused (its rows would go stale)', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    // A two-step school: the office approves, it does not publish.
    await grant(h, r, r.office, Capability.RESULT_APPROVE);
    const approved = await sheetVerb(h, sheet.id, 'approve', r.office);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const absence = await liveMark(r, r.exams.englishA, r.enrolment2);
    const refused = await h.send('post', api(`/marks/${absence.id}/excuse`), { reason: 'Hospitalised' }, r.principal.cookie);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.RESULT_SHEET_VERSION_OPEN, details: { sheetId: sheet.id } });
    // Nothing changed: the absence is live, unexcused.
    expect((await liveMark(r, r.exams.englishA, r.enrolment2)).id).toBe(absence.id);
    // Once published, the excusal is a correction like any other.
    expect((await sheetVerb(h, sheet.id, 'publish', r.principal)).status).toBe(200);
    const excused = await h.send('post', api(`/marks/${absence.id}/excuse`), { reason: 'Hospitalised' }, r.principal.cookie);
    expect(excused.status).toBe(200);
    expect((await liveRow(r, r.enrolment2)).revised).toBe(true);
  });

  it('R280: a correction re-composes the published final sheet in the same transaction', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const skip = await h.send(
      'post',
      api(`/terms/${r.annualTermId}/skip-class`),
      { classId: String(r.klass.id), reason: 'One term this year' },
      r.principal.cookie,
    );
    expect(skip.status).toBe(200);
    const final = await openSheet(h, r.classTeacher, r.sixA.id, null);
    expect(final.status).toBe(201);
    expect((await sheetVerb(h, final.body.id, 'approve', r.principal)).status).toBe(200);
    const finalBefore = await liveRow(r, r.enrolment2, null);

    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    const decided = (await decide(asked.id, 'approve', r.principal)).body as MarkCorrectionDecisionDto;
    const finalAfter = await liveRow(r, r.enrolment2, null);
    const termAfter = await liveRow(r, r.enrolment2);
    expect(finalAfter.supersedesId).toBe(finalBefore.id);
    expect(finalAfter.revised).toBe(true);
    // One held term: the final carries the term's figures.
    expect(finalAfter.percentBp).toBe(termAfter.percentBp);
    const finals = await db.resultSheet.findMany({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: null },
      orderBy: { version: 'asc' },
    });
    expect(finals.map((s) => [s.version, s.status])).toEqual([
      [1, 'published'],
      [2, 'published'],
    ]);
    // The final rows are not told again: one message, the term's.
    expect(revisedTold).toEqual([BigInt(decided.revisedResult.id)]);
  });

  it('R280 (fix round): a correction locks the open final sheet before reading it — a racing final decision serialises (CONCURRENT_UPDATE), an approved final refuses', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const skip = await h.send(
      'post',
      api(`/terms/${r.annualTermId}/skip-class`),
      { classId: String(r.klass.id), reason: 'One term this year' },
      r.principal.cookie,
    );
    expect(skip.status).toBe(200);
    const final = await openSheet(h, r.classTeacher, r.sixA.id, null);
    expect(final.status).toBe(201);
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;

    // Another transaction holds the final sheet (as its approval would) and moves it: the
    // correction waits on the row, then finds it changed and stops, retryable.
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query('BEGIN');
      await pg.query(`UPDATE result_sheets SET updated_at = updated_at + interval '1 millisecond' WHERE school_id = $1 AND id = $2`, [
        r.school.id,
        final.body.id,
      ]);
      const racing = decide(asked.id, 'approve', r.principal).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await pg.query('COMMIT');
      const lost = await racing;
      expect(lost.status).toBe(409);
      expect(errorOf(lost).code).toBe(ErrorCode.CONCURRENT_UPDATE);
    } finally {
      await pg.end();
    }
    // Nothing was written: one term version.
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId } })).toBe(1);

    // The final approved by the office (a two-step school) and not published: the retry is refused.
    await grant(h, r, r.office, Capability.RESULT_APPROVE);
    expect((await sheetVerb(h, final.body.id, 'approve', r.office)).body).toMatchObject({ status: 'approved' });
    const refused = await decide(asked.id, 'approve', r.principal);
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.RESULT_SHEET_VERSION_OPEN, details: { sheetId: final.body.id } });
    // Published, the correction goes through and re-composes the final too.
    expect((await sheetVerb(h, final.body.id, 'publish', r.principal)).status).toBe(200);
    const decided = await decide(asked.id, 'approve', r.principal);
    expect(decided.status).toBe(200);
    expect((await liveRow(r, r.enrolment2, null)).revised).toBe(true);
  });

  it('R281 (fix round): the submitter of the term sheet never decides its correction; the audit names each exception', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    await grant(h, r, r.classTeacher, Capability.RESULT_APPROVE);
    // The class teacher also teaches Maths, so the correction is in their write scope.
    await createTeacherAssignment(db, r.school, r.classTeacher, {
      role: 'subject_teacher',
      subjectId: r.maths.id,
      section: r.sixA,
      startsOn: isoDay(-30),
    });
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    const refused = await decide(asked.id, 'approve', r.classTeacher);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.SELF_ACTION_FORBIDDEN, details: { reason: 'submitter' } });
    // Nothing written: the mark is still the live one, one version.
    expect((await liveMark(r, r.exams.mathsA, r.enrolment2)).id).toBe(exam.id);
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId } })).toBe(1);
    expect((await decide(asked.id, 'approve', r.principal)).status).toBe(200);
    const v2 = await db.resultSheet.findFirstOrThrow({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId, version: 2 },
    });
    expect(v2).toMatchObject({ decidedBy: r.principal.userId, selfApproved: false });
    const audit = await db.auditLog.findFirstOrThrow({ where: { schoolId: r.school.id, action: 'mark_correction.approved' } });
    expect(audit.metadata).toMatchObject({ selfRequest: false, ownChild: false, selfSubmitter: false, selfApproved: false });
  });

  it('R280 (fix round): a correction re-composes over the subjects of the version, not a subject listed since', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const before = await liveRow(r, r.enrolment2);
    const science = await createSubject(db, r.school, { name: 'Science' });
    await db.classSubject.create({
      data: {
        schoolId: r.school.id,
        academicYearId: r.year.id,
        classId: r.klass.id,
        subjectId: science.id,
        sortOrder: 3,
        examMaxMarks: 100,
      },
    });
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    expect((await decide(asked.id, 'approve', r.principal)).status).toBe(200);
    const after = await liveRow(r, r.enrolment2);
    expect(after.subjects.map((s) => s.classSubjectId)).toEqual(before.subjects.map((s) => s.classSubjectId));
    expect(after.totalMax).toBe(before.totalMax);
    // Zara (untouched) keeps her figures exactly: not revised.
    expect((await liveRow(r, r.enrolment1)).revised).toBe(false);
  });

  it('R273 (fix round): a revised row the family was never told goes out as result_published; once told, result_revised', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const sent: string[] = [];
    const notifications = h.app.get(NotificationService, { strict: false });
    const original = notifications.send.bind(notifications);
    jest.spyOn(notifications, 'send').mockImplementation(async (schoolId, message) => {
      if (message.type === 'result_published' || message.type === 'result_revised')
        sent.push(`${message.type}:${String(message.subject?.id)}`);
      return original(schoolId, message);
    });
    const job = h.app.get(ResultNotifyJob, { strict: false });
    // The publication's job has not run yet (lost or queued) when the correction lands. Zara's
    // family (her mother) is the one told.
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment1);
    const first = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    const one = ((await decide(first.id, 'approve', r.principal)).body as MarkCorrectionDecisionDto).revisedResult;
    expect(one.revised).toBe(true);
    await job.run(r.school.id, { resultId: BigInt(one.id) });
    expect(sent).toEqual([`result_published:${one.id}`]);
    // Told now; a second correction is a revision of what they were told.
    const english = await liveMark(r, r.exams.englishA, r.enrolment1);
    const second = (await correct(english.id, { obtained: 75, reason: 'Script found' }, r.englishTeacher)).body as MarkCorrectionDto;
    const two = ((await decide(second.id, 'approve', r.principal)).body as MarkCorrectionDecisionDto).revisedResult;
    await job.run(r.school.id, { resultId: BigInt(two.id) });
    expect(sent).toEqual([`result_published:${one.id}`, `result_revised:${two.id}`]);
  });

  it('R280 (fix round): a correction of a student no longer on the re-composed roster is refused, no empty version', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    // Ali left before the term's last day (recorded late): he is off the roster the term composes.
    await db.enrolment.updateMany({
      where: { schoolId: r.school.id, id: r.enrolment2 },
      data: { status: 'left', endedOn: new Date(`${isoDay(-2)}T00:00:00.000Z`) },
    });
    const refused = await decide(asked.id, 'approve', r.principal);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe(ErrorCode.CONCURRENT_UPDATE);
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId } })).toBe(1);
    expect((await liveMark(r, r.exams.mathsA, r.enrolment2)).id).toBe(exam.id);
  });

  it('contracts/slice-32.md §4 (fix round): the requester withdraws their own pending correction; nobody else can', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment2);
    const asked = (await correct(exam.id, { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher)).body as MarkCorrectionDto;
    const withdraw = (who: Caller, reason?: string) =>
      h.send('post', api(`/mark-corrections/${asked.id}/withdraw`), reason === undefined ? {} : { reason }, who.cookie);
    // The grid shows the waiting correction, marked as the caller's own to the requester.
    const gridRow = async (who: Caller) =>
      ((await h.get(api(`/assessments/${r.exams.mathsA}/marks`), who.cookie)).body as {
        rows: { enrolmentId: string; pendingCorrectionId: string | null; pendingCorrectionMine: boolean }[];
      }).rows.find((row) => row.enrolmentId === String(r.enrolment2));
    expect(await gridRow(r.mathsTeacher)).toMatchObject({ pendingCorrectionId: asked.id, pendingCorrectionMine: true });
    expect(await gridRow(r.principal)).toMatchObject({ pendingCorrectionId: asked.id, pendingCorrectionMine: false });
    expect((await withdraw(r.mathsTeacher)).status).toBe(422);
    // Not theirs: the principal decides it instead, a teacher without the mark sees nothing.
    expect((await withdraw(r.principal, 'Not mine')).status).toBe(404);
    expect((await withdraw(r.englishTeacher, 'Not mine')).status).toBe(404);
    const done = await withdraw(r.mathsTeacher, 'Checked again: the total was right');
    expect(done.status).toBe(200);
    expect(done.body as MarkCorrectionDto).toMatchObject({ status: 'rejected', withdrawn: true, decidedByName: 'Bilal Maths' });
    expect(errorOf(await withdraw(r.mathsTeacher, 'Again')).code).toBe(ErrorCode.MARK_CORRECTION_NOT_PENDING);
    expect(errorOf(await decide(asked.id, 'approve', r.principal)).code).toBe(ErrorCode.MARK_CORRECTION_NOT_PENDING);
    // The live mark is untouched; the withdrawal is audited with its reason.
    expect((await liveMark(r, r.exams.mathsA, r.enrolment2)).id).toBe(exam.id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { schoolId: r.school.id, action: 'mark_correction.withdrawn' } });
    expect(audit).toMatchObject({ reason: 'Checked again: the total was right', actorUserId: r.mathsTeacher.userId });
    expect(audit.metadata).toMatchObject({ withdrawn: true });
    expect(await gridRow(r.mathsTeacher)).toMatchObject({ pendingCorrectionId: null, pendingCorrectionMine: false });
    // A fresh request is possible once the pending one is gone.
    expect((await correct(exam.id, { obtained: 96, reason: 'Re-totalled again' }, r.mathsTeacher)).status).toBe(201);
  });

  it('R282: withholding reads the dues endpoint at request time — on, the guardian is held back until paid; off, never', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const childResults = () => h.get(api(`/me/children/${r.child1.id}/results`), r.parentLogin.cookie);
    // A charge owed by Zara.
    await db.$executeRaw`SELECT asms_seed_school_finance(${r.school.id}::bigint)`;
    const tuition = await db.feeHead.findFirstOrThrow({ where: { schoolId: r.school.id, category: 'tuition' } });
    const charged = await postKeyed(
      h,
      api('/charges'),
      { enrolmentId: String(r.enrolment1), feeHeadId: String(tuition.id), amount: 2500, dueOn: isoDay(0), description: 'Tuition' },
      r.office.cookie,
    );
    expect(charged.status).toBe(201);

    // Off (the default): never withheld, whatever is owed.
    expect((await childResults()).body).toMatchObject({ withheld: false });
    await h.send('patch', api(`/academic-years/${r.year.id}/result-settings`), { withholdCardForDues: true }, r.principal.cookie);
    expect((await childResults()).body as MyChildResultsDto).toMatchObject({ withheld: true, outstanding: 2500 });
    // A staff read is never withheld.
    const row = await liveRow(r, r.enrolment1);
    expect((await h.get(api(`/results/${row.id}`), r.principal.cookie)).status).toBe(200);

    // A payment unlocks the card with no write to any result.
    const paid = await postKeyed(
      h,
      api('/payments'),
      {
        academicYearId: String(r.year.id),
        payerGuardianId: String(r.parent.id),
        studentIds: [String(r.child1.id)],
        amount: 2500,
        method: 'cash',
        receivedOn: isoDay(0),
      },
      r.office.cookie,
    );
    expect(paid.status).toBe(201);
    expect((await childResults()).body).toMatchObject({ withheld: false });
    expect((await liveRow(r, r.enrolment1)).id).toBe(row.id);
  });

  it('slice 34 (A11, R291): academic and completion certificates print the published result, snapshotted; none published is CERTIFICATE_NO_RESULT', async () => {
    const r = await resultRoom(h);
    const issue = (type: string) =>
      postKeyed(h, api(`/students/${r.child1.id}/certificates`), { type }, r.office.cookie);
    const none = await issue('academic');
    expect(none.status).toBe(409);
    expect(errorOf(none)).toMatchObject({ code: ErrorCode.CERTIFICATE_NO_RESULT, details: { certificateId: null } });
    expect(await db.certificate.count({ where: { schoolId: r.school.id } })).toBe(0);
    // A character certificate needs no result.
    expect((await issue('character')).status).toBe(201);

    await publishMidTerm(r);
    const row = await liveRow(r, r.enrolment1);
    const academic = (await issue('academic')).body as CertificateDto;
    expect(academic.body.result).toEqual({
      termName: 'Mid-term',
      isFinal: false,
      className: 'Six',
      sectionName: 'A',
      subjects: row.subjects.map((s) => ({
        subjectName: s.subjectName,
        obtained: s.status === 'assessed' ? s.obtained : null,
        max: s.max,
        percentBp: s.percentBp,
        grade: s.grade,
      })),
      totalObtained: row.totalObtained,
      totalMax: row.totalMax,
      percentBp: row.percentBp,
      grade: row.grade,
      passed: row.passed,
    });
    const page = await request(h.app.getHttpServer())
      .get(api(`/certificates/${academic.id}/print`))
      .set('Cookie', r.office.cookie)
      .set('Origin', ORIGIN);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Result: Mid-term, class Six A');
    expect(page.text).toContain('Mathematics');

    // The final, once published, is preferred (A11); a later correction changes nothing issued.
    await h.send(
      'post',
      api(`/terms/${r.annualTermId}/skip-class`),
      { classId: String(r.klass.id), reason: 'One term this year' },
      r.principal.cookie,
    );
    const final = await openSheet(h, r.classTeacher, r.sixA.id, null);
    expect((await sheetVerb(h, final.body.id, 'approve', r.principal)).status).toBe(200);
    const completion = (await issue('completion')).body as CertificateDto;
    expect(completion.body.result).toMatchObject({ termName: 'Final', isFinal: true });
    const exam = await liveMark(r, r.exams.mathsA, r.enrolment1);
    const asked = (await correct(exam.id, { obtained: 20, reason: 'Mis-keyed' }, r.mathsTeacher)).body as MarkCorrectionDto;
    expect((await decide(asked.id, 'approve', r.principal)).status).toBe(200);
    const again = (await h.get(api(`/certificates/${academic.id}`), r.office.cookie)).body as CertificateDto;
    expect(again.body.result).toEqual(academic.body.result);
  });
});
