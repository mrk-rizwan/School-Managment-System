// Slice 31 end to end (contracts/slice-31.md; phase-4-academic.md R267-R278): a sheet is created by
// an explicit POST and previewed from the live marks; the class teacher writes remarks and submits
// (gaps refused, tests locked); the principal returns or approves (composed and stored, published
// when they hold result.publish); publication tells the families; the inbox lists the queue.
import {
  Capability,
  composeResult,
  composeSubject,
  DEFAULT_GRADE_BANDS,
  ErrorCode,
  positions,
} from '@asms/shared';
import type { ApprovalsDto } from '../../src/modules/approvals/approvals.dto';
import type { AssessmentDto } from '../../src/modules/assessments/assessments.dto';
import type { ResultSheetDetailDto, ResultSheetDto } from '../../src/modules/results/results.dto';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ResultComposer } from '../../src/modules/results/result-composer';
import { ResultNotifyJob } from '../../src/modules/results/result-notify.job';
import { captureOutbox } from '../diary/support';
import { errorOf, StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';
import {
  createGuardian,
  createStudent,
  createTeacherAssignment,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import { grant } from '../assessments/support';
import {
  api,
  createTest,
  enterMarks,
  entryKey,
  markMidTerm,
  openSheet,
  resultRoom,
  returnSheet,
  sheetVerb,
  type ResultRoom,
} from './support';

interface Page<T> {
  data: T[];
  total: number;
}

describe('result sheets (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let notified: bigint[] = [];

  beforeAll(async () => {
    await h.start();
  });

  beforeEach(() => {
    captureOutbox(h);
    notified = [];
    jest
      .spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'resultNotifyAfterCommit')
      .mockImplementation((_schoolId, sheetId) => {
        notified.push(sheetId);
      });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const HELD = isoDay(-5);
  const detail = async (id: string, who = (r: ResultRoom) => r.classTeacher, r?: ResultRoom) => {
    if (!r) throw new Error('room');
    const res = await h.get(api(`/result-sheets/${id}`), who(r).cookie);
    expect(res.status).toBe(200);
    return res.body as ResultSheetDetailDto;
  };

  it('R267: an explicit POST creates the sheet once; a repeat answers the open version; a GET never writes', async () => {
    const r = await resultRoom(h);
    const before = await db.resultSheet.count({ where: { schoolId: r.school.id } });
    const list = await h.get(api('/result-sheets'), r.classTeacher.cookie);
    expect((list.body as Page<ResultSheetDto>).total).toBe(0);
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id } })).toBe(before);

    const first = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'draft',
      version: 1,
      termName: 'Mid-term',
      isFinal: false,
      source: 'preview',
    });
    const again = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await db.resultSheet.count({ where: { schoolId: r.school.id } })).toBe(1);
    const audit = await db.auditLog.findMany({
      where: { schoolId: r.school.id, action: 'result_sheet.created' },
    });
    expect(audit).toHaveLength(1);

    // Another section's class teacher, and a subject teacher, reach no sheet of 6-A.
    expect((await openSheet(h, r.mathsTeacher, r.sixA.id, r.midTermId)).status).toBe(404);
    expect(
      (await h.get(api(`/result-sheets/${first.body.id}`), r.mathsTeacher.cookie)).status,
    ).toBe(404);
    // The final sheet needs the held terms published first (R275).
    const final = await openSheet(h, r.principal, r.sixA.id, null);
    expect(final.status).toBe(409);
    expect(errorOf({ body: final.body }).code).toBe(ErrorCode.RESULT_SHEET_TERMS_UNPUBLISHED);
  });

  it('R268-R270, R272: preview, remarks, gaps refused, submit locks, approve stores what the pure functions give, published', async () => {
    const r = await resultRoom(h);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    // Nothing entered: every applicable assessment is a gap.
    const empty = await sheetVerb(h, sheet.id, 'submit', r.classTeacher);
    expect(empty.status).toBe(409);
    expect(errorOf(empty).code).toBe(ErrorCode.MARKS_INCOMPLETE);
    expect((errorOf(empty).details as { missing: unknown[] }).missing).toHaveLength(4);

    const test = await markMidTerm(h, r, HELD);
    const remark = await h.send(
      'patch',
      api(`/result-sheets/${sheet.id}`),
      { remarks: [{ enrolmentId: String(r.enrolment1), remark: 'A steady, careful worker.' }] },
      r.classTeacher.cookie,
    );
    expect(remark.status).toBe(200);
    const preview = remark.body as ResultSheetDetailDto;
    expect(preview.flags.missingCount).toBe(0);
    const zara = preview.preview.find((p) => p.enrolmentId === String(r.enrolment1));
    const ali = preview.preview.find((p) => p.enrolmentId === String(r.enrolment2));
    expect(zara).toMatchObject({
      percentBp: 7450,
      grade: 'B',
      passed: true,
      position: 1,
      positionOf: 2,
      remark: 'A steady, careful worker.',
    });
    expect(ali).toMatchObject({
      percentBp: 2700,
      grade: 'F',
      passed: false,
      failedSubjects: 1,
      position: 2,
    });
    // The subject teacher cannot write a remark (R276's author is the class teacher).
    const notCt = await h.send(
      'patch',
      api(`/result-sheets/${sheet.id}`),
      { remarks: [{ enrolmentId: String(r.enrolment1), remark: 'x y z' }] },
      r.mathsTeacher.cookie,
    );
    expect(notCt.status).toBe(404);

    const submitted = await sheetVerb(h, sheet.id, 'submit', r.classTeacher);
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({
      status: 'submitted',
      submittedByMe: true,
      cover: false,
    });
    // Tests locked; no new test; no live mark on the exam; no void (R265, R268).
    const locked = await db.assessment.findFirst({
      where: { schoolId: r.school.id, id: BigInt(test) },
    });
    expect(locked?.lockedAt).not.toBeNull();
    const asTest = await h.get(api(`/assessments/${test}`), r.mathsTeacher.cookie);
    expect((asTest.body as AssessmentDto).locked).toBe(true);
    const exam = await h.get(api(`/assessments/${r.exams.mathsA}`), r.mathsTeacher.cookie);
    expect(exam.body).toMatchObject({ locked: true, canEnterMarks: false });
    await expect(
      enterMarks(h, r.exams.mathsA, r.mathsTeacher, [[r.enrolment1, 90]]),
    ).rejects.toThrow(/ASSESSMENT_LOCKED/);
    await expect(
      createTest(h, r.mathsTeacher, {
        classSubjectId: r.maths.classSubjectId,
        sectionId: r.sixA.id,
        maxMarks: 10,
        heldOn: HELD,
      }),
    ).rejects.toThrow(/RESULT_SHEET_NOT_DRAFT/);
    const voided = await h.send(
      'post',
      api(`/assessments/${r.exams.mathsA}/void`),
      { reason: 'Set up twice' },
      r.principal.cookie,
    );
    expect(errorOf(voided).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    // R257: the class's subject list is frozen while a sheet is under review; R254: the term too.
    const reorder = await h.send(
      'patch',
      api(`/classes/${r.klass.id}`),
      {
        subjects: [
          { subjectId: String(r.english.id), sortOrder: 1, examMaxMarks: 100 },
          { subjectId: String(r.maths.id), sortOrder: 2, examMaxMarks: 100 },
        ],
      },
      r.principal.cookie,
    );
    expect(errorOf(reorder).code).toBe(ErrorCode.CLASS_SUBJECTS_FROZEN);
    const reweigh = await h.send(
      'patch',
      api(`/terms/${r.midTermId}`),
      { weight: 40 },
      r.principal.cookie,
    );
    expect(errorOf(reweigh).code).toBe(ErrorCode.TERM_IN_USE);
    // Remarks are frozen once submitted.
    const late = await h.send(
      'patch',
      api(`/result-sheets/${sheet.id}`),
      { remarks: [{ enrolmentId: String(r.enrolment2), remark: 'Late note' }] },
      r.classTeacher.cookie,
    );
    expect(errorOf(late).code).toBe(ErrorCode.RESULT_SHEET_NOT_DRAFT);

    // R278: the principal's inbox holds it, equal to GET /result-sheets?status=submitted.
    const inbox = (await h.get(api('/me/approvals'), r.principal.cookie)).body as ApprovalsDto;
    const queue = (await h.get(api('/result-sheets?status=submitted&limit=10'), r.principal.cookie))
      .body as Page<ResultSheetDto>;
    expect(inbox.results?.count).toBe(1);
    expect(inbox.results?.items).toEqual(queue.data);
    expect(queue.data[0]?.id).toBe(sheet.id);

    const approved = await sheetVerb(h, sheet.id, 'approve', r.principal);
    expect(approved.status).toBe(200);
    const stored = approved.body as ResultSheetDetailDto;
    expect(stored).toMatchObject({ status: 'published', source: 'stored', selfApproved: false });
    expect(notified).toEqual([BigInt(sheet.id)]);

    // R270: the stored rows equal the shared functions over the live marks.
    const results = await db.result.findMany({
      where: { schoolId: r.school.id, sheetId: BigInt(sheet.id) },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { enrolmentId: 'asc' },
    });
    expect(results).toHaveLength(2);
    // The seeded bands are the defaults (asms_seed_year_results).
    const settingsRow = await db.resultSettings.findFirst({
      where: { schoolId: r.school.id, academicYearId: r.year.id },
    });
    expect(settingsRow?.bands).toEqual(DEFAULT_GRADE_BANDS);
    const expected = [
      { tests: [[15, 20]], exams: { maths: 80, english: 70 }, enrolmentId: r.enrolment1 },
      { tests: [[10, 20]], exams: { maths: 55, english: null }, enrolmentId: r.enrolment2 },
    ].map((s) => {
      const maths = composeSubject({
        tests: s.tests.map(([o, m]) => ({
          obtained: o!,
          max: m!,
          absent: false,
          excused: false,
          applicable: true,
        })),
        exam: { obtained: s.exams.maths, max: 100, absent: false, excused: false },
        weights: { test: 20, exam: 80 },
        max: 100,
      });
      const english = composeSubject({
        tests: [],
        exam:
          s.exams.english === null
            ? { obtained: null, max: 100, absent: true, excused: false }
            : { obtained: s.exams.english, max: 100, absent: false, excused: false },
        weights: { test: 20, exam: 80 },
        max: 100,
      });
      return composeResult({
        subjects: [
          { key: 'm', ...maths },
          { key: 'e', ...english },
        ],
        bands: DEFAULT_GRADE_BANDS,
        passRule: 'all_subjects',
        passPercent: 40,
      });
    });
    const ranks = positions(expected);
    results.forEach((row, i) => {
      expect(row).toMatchObject({
        totalObtained: expected[i]!.totalObtained,
        totalMax: expected[i]!.totalMax,
        percentBp: expected[i]!.percentBp,
        grade: expected[i]!.grade,
        passed: expected[i]!.passed,
        position: ranks[i]!.position,
        positionOf: ranks[i]!.positionOf,
        termId: r.midTermId,
      });
      expect(row.publishedAt).not.toBeNull();
      expect(row.subjects.map((s) => s.subjectName)).toEqual(['Mathematics', 'English']);
    });
    expect(results[0]!.remark).toBe('A steady, careful worker.');
    // The snapshot is on the sheet (R256's "regardless").
    const row = await db.resultSheet.findFirst({
      where: { schoolId: r.school.id, id: BigInt(sheet.id) },
    });
    expect(row).toMatchObject({
      testWeight: 20,
      examWeight: 80,
      passPercent: 40,
      passRule: 'all_subjects',
    });
    // R256: the year's settings are now frozen.
    const frozen = await h.send(
      'patch',
      api(`/academic-years/${r.year.id}/result-settings`),
      { passPercent: 33 },
      r.principal.cookie,
    );
    expect(errorOf(frozen).code).toBe(ErrorCode.RESULT_SETTINGS_LOCKED);
    const actions = (
      await db.auditLog.findMany({
        where: { schoolId: r.school.id, subjectType: 'result_sheet' },
        orderBy: { id: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'result_sheet.created',
      'result_sheet.submitted',
      'result_sheet.approved',
      'result_sheet.published',
    ]);

    // R273: the job tells one message per student, the family by the receipt rule (SMS allowed).
    const sent = await h.app.get(ResultNotifyJob).run(r.school.id, { sheetId: BigInt(sheet.id) });
    expect(sent).toBeGreaterThanOrEqual(1);
    const again = await h.app.get(ResultNotifyJob).run(r.school.id, { sheetId: BigInt(sheet.id) });
    expect(again).toBe(0);
  });

  it('R269, R271, R272: return needs a reason and unlocks; the submitter never decides; approval without result.publish waits approved', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const noReason = await h.send(
      'post',
      api(`/result-sheets/${sheet.id}/return`),
      {},
      r.principal.cookie,
    );
    expect(noReason.status).toBe(422);
    const back = await returnSheet(h, sheet.id, r.principal);
    expect(back.body).toMatchObject({
      status: 'returned',
      returnReason: 'Recheck the English marks',
    });
    const returned = await db.auditLog.findFirst({
      where: { schoolId: r.school.id, action: 'result_sheet.returned' },
    });
    expect(returned).toMatchObject({
      reason: 'Recheck the English marks',
      actorUserId: r.principal.userId,
    });
    expect(returned?.metadata).toMatchObject({ from: 'submitted' });
    const tests = await db.assessment.findMany({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, kind: 'test' },
    });
    expect(tests.every((t) => t.lockedAt === null)).toBe(true);
    // Unlocked: a mark can change again.
    await enterMarks(h, r.exams.englishA, r.englishTeacher, [[r.enrolment2, 'absent']]);

    // A second principal approves without publishing when they lack result.publish? Both
    // principals hold it; a custom office grant of result.approve alone shows the wait.
    await grant(h, r, r.office, Capability.RESULT_APPROVE);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const approved = await sheetVerb(h, sheet.id, 'approve', r.office);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', canPublish: false });
    expect(notified).toEqual([]);
    const notYet = await db.result.findMany({
      where: { schoolId: r.school.id, sheetId: BigInt(sheet.id) },
    });
    expect(notYet.every((x) => x.publishedAt === null)).toBe(true);
    // From approved it can be returned (its rows superseded) or published.
    const back2 = await returnSheet(h, sheet.id, r.office, 'One more check');
    expect(back2.body).toMatchObject({ status: 'returned' });
    const superseded = await db.result.findMany({
      where: { schoolId: r.school.id, sheetId: BigInt(sheet.id) },
    });
    expect(superseded.every((x) => x.supersededAt !== null)).toBe(true);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    expect((await sheetVerb(h, sheet.id, 'approve', r.office)).body).toMatchObject({
      status: 'approved',
    });
    const publish = await sheetVerb(h, sheet.id, 'publish', r.principal);
    expect(publish.body).toMatchObject({ status: 'published' });
    expect(notified).toEqual([BigInt(sheet.id)]);
    const live = await db.result.findMany({
      where: { schoolId: r.school.id, sheetId: BigInt(sheet.id), supersededAt: null },
    });
    expect(live).toHaveLength(2);
    expect(live.every((x) => x.publishedAt !== null)).toBe(true);
    const twice = await sheetVerb(h, sheet.id, 'publish', r.principal);
    expect(errorOf(twice).code).toBe(ErrorCode.RESULT_SHEET_NOT_APPROVED);
  });

  /** 6-B has no class teacher: the principal (assessment.define) marks English, opens and submits. */
  async function principalSubmitsSixB(r: ResultRoom): Promise<string> {
    await enterMarks(h, r.exams.mathsB, r.bTeacher, [[r.enrolmentB, 60]]);
    await enterMarks(h, r.exams.englishB, r.principal, [[r.enrolmentB, 66]]);
    const { status, body } = await openSheet(h, r.principal, r.sixB.id, r.midTermId);
    expect(status).toBe(201);
    const submitted = await sheetVerb(h, body.id, 'submit', r.principal);
    expect(submitted.status).toBe(200);
    return body.id;
  }

  it('R271: the sole principal approves their own submission, recorded self_approved', async () => {
    const r = await resultRoom(h);
    const sheet = await principalSubmitsSixB(r);
    const self = await sheetVerb(h, sheet, 'approve', r.principal);
    if (self.status !== 200)
      console.log(
        h.logs
          .filter((l) => l.includes('rror'))
          .slice(-3)
          .join(' || '),
      );
    expect(self.status).toBe(200);
    expect(self.body).toMatchObject({ status: 'published', selfApproved: true });
    const audit = await db.auditLog.findFirst({
      where: { schoolId: r.school.id, action: 'result_sheet.approved', subjectId: BigInt(sheet) },
    });
    expect(audit?.metadata).toMatchObject({ selfApproved: true });
  });

  it('R271: with a second principal the submitter may not decide; the other principal does', async () => {
    const r = await resultRoom(h);
    const second = await h.caller(r.school, 'principal', 'Rabia Second');
    const sheet = await principalSubmitsSixB(r);
    const own = await sheetVerb(h, sheet, 'approve', r.principal);
    expect(own.status).toBe(409);
    expect(errorOf(own)).toMatchObject({
      code: ErrorCode.SELF_ACTION_FORBIDDEN,
      details: { reason: 'submitter' },
    });
    const ownReturn = await returnSheet(h, sheet, r.principal);
    expect(errorOf(ownReturn).code).toBe(ErrorCode.SELF_ACTION_FORBIDDEN);
    const other = await sheetVerb(h, sheet, 'approve', second);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ status: 'published', selfApproved: false });
    // The database's line behind the service (trigger result_sheets_not_self).
    await expect(
      db.$executeRaw`UPDATE result_sheets SET status = 'returned', decided_by = submitted_by, decided_at = now(), return_reason = 'x x x' WHERE school_id = ${r.school.id} AND id = ${BigInt(sheet)}`,
    ).rejects.toThrow();
  });

  it('R276: own-child flags from the mark author, the remark writer and the approver; carried in the audit row', async () => {
    const r = await resultRoom(h);
    // The Maths teacher is also the guardian of Zara (one login, both capacities).
    const father = await createGuardian(db, r.school, { fullName: 'Bilal Khan' });
    await linkGuardian(db, r.school, r.child1, father, {
      relationship: 'father',
      isPrimaryContact: false,
      isFeePayer: false,
    });
    await db.user.updateMany({
      where: { schoolId: r.school.id, id: r.mathsTeacher.userId },
      data: { guardianId: father.id },
    });
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    const view = await detail(sheet.id, (x) => x.classTeacher, r);
    const zara = view.preview.find((p) => p.enrolmentId === String(r.enrolment1));
    expect(zara?.ownChildFlags.map((f) => f.role)).toEqual(['mark_author']);
    expect(zara?.subjects.find((s) => s.subjectName === 'Mathematics')?.ownChildOf).toBe(
      String(r.mathsTeacher.userId),
    );
    expect(view.preview.find((p) => p.enrolmentId === String(r.enrolment2))?.ownChildFlags).toEqual(
      [],
    );
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const inbox = (await h.get(api('/me/approvals'), r.principal.cookie)).body as ApprovalsDto;
    expect(inbox.results?.items[0]?.ownChildFlags.map((f) => f.role)).toEqual(['mark_author']);
    expect((await sheetVerb(h, sheet.id, 'approve', r.principal)).status).toBe(200);
    const audit = await db.auditLog.findFirst({
      where: { schoolId: r.school.id, action: 'result_sheet.approved' },
    });
    expect(audit?.metadata).toMatchObject({
      ownChildFlags: `${r.mathsTeacher.userId}:mark_author`,
    });
    const stored = await db.result.findFirst({
      where: { schoolId: r.school.id, enrolmentId: r.enrolment1 },
    });
    expect(stored?.ownChildFlags).toEqual([
      { userId: String(r.mathsTeacher.userId), role: 'mark_author' },
    ]);
  });

  it('cover: a cover of the class teacher submits, recorded with the assignment', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const ct = await db.teacherAssignment.findFirst({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, role: 'class_teacher' },
    });
    const cover = await createTeacherAssignment(db, r.school, r.bTeacher, {
      role: 'cover',
      section: r.sixA,
      startsOn: isoDay(-1),
      endsOn: isoDay(1),
      coversAssignmentId: ct!.id,
    });
    const { body: sheet } = await openSheet(h, r.bTeacher, r.sixA.id, r.midTermId);
    const submitted = await sheetVerb(h, sheet.id, 'submit', r.bTeacher);
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ cover: true });
    const row = await db.resultSheet.findFirst({
      where: { schoolId: r.school.id, id: BigInt(sheet.id) },
    });
    expect(row?.submittedUnderAssignmentId).toBe(cover.id);
  });

  it('§2.4: a test two sheets hold stays locked until both are returned; a return clears only its own set', async () => {
    const r = await resultRoom(h);
    const test = await markMidTerm(h, r, HELD);
    // A student who moved from 6-B to 6-A: their 6-B test counts on the 6-A sheet (§0.25).
    const moved = await createStudent(db, r.school, { fullName: 'Moved Student' });
    const movedB = (
      await enrol(db, r.school, moved, r.sixB, {
        startedOn: isoDay(-30),
        endedOn: isoDay(-10),
        status: 'completed',
        rollNo: 2,
      })
    ).id;
    const movedA = (await enrol(db, r.school, moved, r.sixA, { startedOn: isoDay(-9), rollNo: 3 }))
      .id;
    const bTest = await createTest(h, r.bTeacher, {
      classSubjectId: r.maths.classSubjectId,
      sectionId: r.sixB.id,
      maxMarks: 20,
      heldOn: isoDay(-15),
    });
    await enterMarks(h, bTest, r.bTeacher, [
      [r.enrolmentB, 12],
      [movedB, 14],
    ]);
    await enterMarks(h, test, r.mathsTeacher, [[movedA, 11]]);
    await enterMarks(h, r.exams.mathsA, r.mathsTeacher, [[movedA, 50]]);
    await enterMarks(h, r.exams.englishA, r.englishTeacher, [[movedA, 52]]);
    const lockedAt = async (id: string) =>
      (await db.assessment.findFirst({ where: { schoolId: r.school.id, id: BigInt(id) } }))
        ?.lockedAt ?? null;

    const { body: a } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, a.id, 'submit', r.classTeacher)).status).toBe(200);
    expect(await lockedAt(bTest)).not.toBeNull();
    expect(await lockedAt(test)).not.toBeNull();
    const b = await principalSubmitsSixB(r);
    const second = await h.caller(r.school, 'principal', 'Rabia Second');
    // 6-A returned: its own test unlocks; the 6-B test stays locked (6-B's sheet holds it).
    expect((await returnSheet(h, a.id, r.principal)).status).toBe(200);
    expect(await lockedAt(test)).toBeNull();
    expect(await lockedAt(bTest)).not.toBeNull();
    const stillLocked = await h.send(
      'post',
      api(`/assessments/${bTest}/submit-marks`),
      {
        entries: [
          {
            enrolmentId: String(r.enrolmentB),
            obtained: 13,
            clientEntryKey: entryKey(),
            basedOnMarkId: null,
          },
        ],
      },
      r.bTeacher.cookie,
    );
    expect(errorOf(stillLocked).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    // 6-B returned too (by the other principal): now nothing holds it.
    expect((await returnSheet(h, b, second)).status).toBe(200);
    expect(await lockedAt(bTest)).toBeNull();
  });

  it('§2.2: canRemark for the author while draft or returned, the final sheet included; canSubmit for a term sheet only', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const { body: term } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect(term).toMatchObject({ canRemark: true, canSubmit: true });
    // The principal reads it but is not its author (6-A has a class teacher).
    expect(await detail(term.id, (x) => x.principal, r)).toMatchObject({
      canRemark: false,
      canSubmit: false,
    });
    expect((await sheetVerb(h, term.id, 'submit', r.classTeacher)).body).toMatchObject({
      canRemark: false,
      canSubmit: false,
    });
    expect((await sheetVerb(h, term.id, 'approve', r.principal)).status).toBe(200);
    // The Annual term is not held for the class: the final opens once the Mid-term is published.
    expect(
      (
        await h.send(
          'post',
          api(`/terms/${r.annualTermId}/skip-class`),
          { classId: String(r.klass.id), reason: 'One term this year' },
          r.principal.cookie,
        )
      ).status,
    ).toBe(200);
    const final = await openSheet(h, r.classTeacher, r.sixA.id, null);
    expect(final.status).toBe(201);
    expect(final.body).toMatchObject({ canRemark: true, canSubmit: false });
    const remarked = await h.send(
      'patch',
      api(`/result-sheets/${final.body.id}`),
      { remarks: [{ enrolmentId: String(r.enrolment1), remark: 'A good year.' }] },
      r.classTeacher.cookie,
    );
    expect(remarked.status).toBe(200);
    expect(
      (remarked.body as ResultSheetDetailDto).preview.find(
        (p) => p.enrolmentId === String(r.enrolment1),
      )?.remark,
    ).toBe('A good year.');
  });

  it('R271: canDecide is false for the submitter unless they are the sole principal', async () => {
    const r = await resultRoom(h);
    const sheet = await principalSubmitsSixB(r);
    // One principal: they may decide their own submission (recorded self_approved).
    expect(await detail(sheet, (x) => x.principal, r)).toMatchObject({ canDecide: true });
    // Two principals: the submitter may not; the other may.
    const second = await h.caller(r.school, 'principal', 'Rabia Second');
    expect(await detail(sheet, (x) => x.principal, r)).toMatchObject({ canDecide: false });
    expect(await detail(sheet, () => second, r)).toMatchObject({ canDecide: true });
  });

  it('GET /result-sheets composes only the submitted queue, at most ten a page', async () => {
    const r = await resultRoom(h);
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const composer = h.app.get(ResultComposer, { strict: false });
    const term = jest.spyOn(composer, 'term');
    const all = await h.get(api('/result-sheets?limit=50'), r.principal.cookie);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ limit: 50, total: 1 });
    expect(term).not.toHaveBeenCalled();
    const queue = await h.get(api('/result-sheets?status=submitted&limit=50'), r.principal.cookie);
    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ limit: 10, total: 1 });
    expect(term).toHaveBeenCalledTimes(1);
  });
});
