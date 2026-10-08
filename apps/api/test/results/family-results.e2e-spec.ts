// Slice 33 end to end (contracts/slice-33.md; phase-4-academic.md R274, R78, R282 (the family
// side), R285-R288): a guardian and a student read only published, live results of their own child
// or self; class-test marks show as entered (tests only, live, non-voided); a withheld card shows
// the guardian the figure owed and the student nothing; the student page lists published results
// across years in the caller's scope; the two reports read the stored rows.
import { Capability, ErrorCode } from '@asms/shared';
import type { MyAssessmentMarkDto, MyChildResultsDto, MyResultDto } from '../../src/modules/results/my-results.dto';
import type { SectionSummaryReportDto, SubjectReportDto } from '../../src/modules/results/result-reports.dto';
import type { ResultDto, ResultSheetDetailDto } from '../../src/modules/results/results.dto';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ResultCardsService } from '../../src/modules/results/result-cards.service';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { grant } from '../assessments/support';
import { captureOutbox, guardianLogin, studentLogin } from '../diary/support';
import { errorOf, StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';

import { createGuardian, isoDay, linkGuardian } from '../support/students';
import {
  api,
  createTest,
  enterMarks,
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

describe('family and student results, result reports (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  beforeAll(async () => {
    await h.start();
  });

  beforeEach(() => {
    captureOutbox(h);
    jest
      .spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'resultNotifyAfterCommit')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const HELD = isoDay(-5);

  /** 6-A's Mid-term marked, submitted by the class teacher and approved (published) by the principal. */
  async function publishMidTerm(r: ResultRoom): Promise<ResultSheetDetailDto> {
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    const approved = await sheetVerb(h, sheet.id, 'approve', r.principal);
    expect(approved.status).toBe(200);
    expect((approved.body as ResultSheetDetailDto).status).toBe('published');
    return approved.body as ResultSheetDetailDto;
  }

  const stored = (r: ResultRoom, enrolmentId: bigint) =>
    db.result.findFirstOrThrow({
      where: { schoolId: r.school.id, enrolmentId, supersededAt: null },
      include: { subjects: true },
    });

  it('R274, R285, R286, R78: published and live only, own child only; class tests as entered, never exams or voided tests', async () => {
    const r = await resultRoom(h);
    const parent = r.parentLogin.cookie;
    const mine = (path: string) => h.get(api(`/me/children/${r.child1.id}${path}`), parent);

    // A voided test never shows; its mark was live.
    const voided = await createTest(h, r.mathsTeacher, {
      classSubjectId: r.maths.classSubjectId,
      sectionId: r.sixA.id,
      maxMarks: 10,
      heldOn: HELD,
      name: 'Spelling quiz',
    });
    await enterMarks(h, voided, r.mathsTeacher, [[r.enrolment1, 7]]);
    const voidRes = await h.send('post', api(`/assessments/${voided}/void`), { reason: 'Wrong paper set' }, r.mathsTeacher.cookie);
    expect(voidRes.status).toBe(200);

    // Nothing published yet: an empty view, never a draft (R274).
    const empty = await mine('/results');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      studentId: String(r.child1.id),
      academicYearId: null,
      years: [],
      terms: [],
      final: null,
      withheld: false,
      outstanding: null,
    });

    const sheet = await publishMidTerm(r);

    // R286: the Maths class test (15/20) shows; the two exam marks and the voided quiz do not.
    const tests = await mine('/assessments');
    expect(tests.status).toBe(200);
    const page = tests.body as Page<MyAssessmentMarkDto>;
    expect(page.total).toBe(1);
    expect(page.data[0]).toMatchObject({
      name: 'Weekly test',
      subjectName: 'Mathematics',
      maxMarks: 20,
      obtained: 15,
      absent: false,
      termId: String(r.midTermId),
      heldOn: HELD,
    });
    expect((await mine(`/assessments?termId=${r.annualTermId}`)).body).toMatchObject({ total: 0 });

    // R274: the published term result, with the stored figures.
    const zara = await stored(r, r.enrolment1);
    const list = (await mine('/results')).body as MyChildResultsDto;
    expect(list).toMatchObject({
      academicYearId: String(r.year.id),
      years: [{ id: String(r.year.id) }],
      final: null,
      withheld: false,
      outstanding: null,
    });
    expect(list.terms).toEqual([
      expect.objectContaining({
        id: String(zara.id),
        termId: String(r.midTermId),
        isFinal: false,
        percentBp: zara.percentBp,
        grade: zara.grade,
        className: 'Six',
        sectionName: 'A',
        revised: false,
      }),
    ]);
    const card = await mine(`/results/${zara.id}`);
    expect(card.status).toBe(200);
    const body = card.body as MyResultDto;
    expect(body).toMatchObject({ withheld: false, outstanding: null });
    expect(body.result).toMatchObject({
      id: String(zara.id),
      sheetId: sheet.id,
      studentId: String(r.child1.id),
      percentBp: zara.percentBp,
    });
    expect(body.result?.subjects).toHaveLength(zara.subjects.length);

    // R285 / R78: another child's result through this child, an unlinked child, a staff caller.
    const ali = await stored(r, r.enrolment2);
    expect((await mine(`/results/${ali.id}`)).status).toBe(404);
    for (const path of ['/results', `/results/${ali.id}`, '/assessments']) {
      expect((await h.get(api(`/me/children/${r.child2.id}${path}`), parent)).status).toBe(404);
    }
    expect((await h.get(api(`/me/children/${r.child1.id}/results`), r.classTeacher.cookie)).status).toBe(403);

    // The student's own login: own results only (the student from the session).
    const self = await studentLogin(db, r.school, r.child2);
    const own = (await h.get(api('/me/student/results'), self.cookie)).body as MyChildResultsDto;
    expect(own.studentId).toBe(String(r.child2.id));
    expect(own.terms.map((t) => t.id)).toEqual([String(ali.id)]);
    expect((await h.get(api(`/me/student/results/${ali.id}`), self.cookie)).status).toBe(200);
    expect((await h.get(api(`/me/student/results/${zara.id}`), self.cookie)).status).toBe(404);
    expect(((await h.get(api('/me/student/assessments'), self.cookie)).body as Page<MyAssessmentMarkDto>).data).toEqual([
      expect.objectContaining({ obtained: 10, maxMarks: 20 }),
    ]);
    expect((await h.get(api('/me/student/results'), parent)).status).toBe(403);

    // R274: a superseded row is gone from both routes (a correction's new row replaces it).
    await db.result.updateMany({ where: { schoolId: r.school.id, id: zara.id }, data: { supersededAt: new Date() } });
    expect((await mine(`/results/${zara.id}`)).status).toBe(404);
    expect(((await mine('/results')).body as MyChildResultsDto).terms).toEqual([]);
  });

  /** A correction of Ali's Maths exam (55 → 95), requested by the Maths teacher; returns its id. */
  async function requestCorrection(r: ResultRoom): Promise<string> {
    const exam = await db.mark.findFirstOrThrow({
      where: { schoolId: r.school.id, assessmentId: r.exams.mathsA, enrolmentId: r.enrolment2, status: 'live' },
    });
    const asked = await postKeyed(h, api(`/marks/${exam.id}/correct`), { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher.cookie, entryKey());
    expect(asked.status).toBe(201);
    return (asked.body as { id: string }).id;
  }

  it('R287 (fix round): the section summary of a corrected sheet reads each version as approved — v1 its original rows, v2 the corrected ones', async () => {
    const r = await resultRoom(h);
    const v1 = await publishMidTerm(r);
    const before = await db.result.findMany({ where: { schoolId: r.school.id, sheetId: BigInt(v1.id) } });
    const correction = await requestCorrection(r);
    expect((await h.send('post', api(`/mark-corrections/${correction}/approve`), {}, r.principal.cookie)).status).toBe(200);
    const v2 = await db.resultSheet.findFirstOrThrow({
      where: { schoolId: r.school.id, sectionId: r.sixA.id, termId: r.midTermId, version: 2 },
    });
    const after = await db.result.findMany({ where: { schoolId: r.school.id, sheetId: v2.id } });
    const summary = async (sheetId: string) =>
      (await h.get(api(`/result-reports/section-summary?sheetId=${sheetId}`), r.principal.cookie)).body as SectionSummaryReportDto;
    const meanBp = (values: (number | null)[]) => {
      const kept = values.filter((v): v is number => v !== null);
      return Math.floor((2 * kept.reduce((a, b) => a + b, 0) + kept.length) / (2 * kept.length));
    };
    const old = await summary(v1.id);
    expect(old).toMatchObject({
      students: before.length,
      passed: before.filter((x) => x.passed === true).length,
      averageBp: meanBp(before.map((x) => x.percentBp)),
    });
    expect(old.students).toBe(2);
    const fresh = await summary(String(v2.id));
    expect(fresh).toMatchObject({
      students: after.length,
      passed: after.filter((x) => x.passed === true).length,
      averageBp: meanBp(after.map((x) => x.percentBp)),
    });
    expect(fresh.averageBp).not.toBe(old.averageBp);
  });

  it('R274 (fix round): a pending correction never shows to the family; once approved the old row is gone from their view', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    // Ali's family: a guardian with a login, linked for this test.
    const father = await createGuardian(db, r.school, { fullName: 'Raza Senior' });
    await linkGuardian(db, r.school, r.child2, father, { canLogin: true, relationship: 'father' });
    const login = await guardianLogin(db, r.school, father);
    const v1 = await stored(r, r.enrolment2);
    const correction = await requestCorrection(r);
    const list = async () =>
      (await h.get(api(`/me/children/${r.child2.id}/results`), login.cookie)).body as MyChildResultsDto;
    expect((await list()).terms.map((t) => [t.id, t.percentBp, t.revised])).toEqual([[String(v1.id), v1.percentBp, false]]);
    const card = (await h.get(api(`/me/children/${r.child2.id}/results/${v1.id}`), login.cookie)).body as MyResultDto;
    expect(card.result?.subjects.find((s) => s.classSubjectId === String(r.maths.classSubjectId))?.examObtained).toBe(55);
    expect((await h.send('post', api(`/mark-corrections/${correction}/approve`), {}, r.principal.cookie)).status).toBe(200);
    const v2 = await stored(r, r.enrolment2);
    expect((await list()).terms.map((t) => [t.id, t.revised])).toEqual([[String(v2.id), true]]);
    expect((await h.get(api(`/me/children/${r.child2.id}/results/${v1.id}`), login.cookie)).status).toBe(404);
  });

  it('R78 (fix round): a guardian whose login is off, whose link ended, or who was merged away reads nothing (404)', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const zara = await stored(r, r.enrolment1);
    const paths = [
      api(`/me/children/${r.child1.id}/results`),
      api(`/me/children/${r.child1.id}/results/${zara.id}`),
      api(`/me/children/${r.child1.id}/assessments`),
    ];
    const statuses = async (cookie: string) => Promise.all(paths.map(async (p) => (await h.get(p, cookie)).status));
    expect(await statuses(r.parentLogin.cookie)).toEqual([200, 200, 200]);
    const link = { schoolId: r.school.id, studentId: r.child1.id, guardianId: r.parent.id };
    // can_login off on the link.
    await db.studentGuardian.updateMany({ where: link, data: { canLogin: false } });
    expect(await statuses(r.parentLogin.cookie)).toEqual([404, 404, 404]);
    await db.studentGuardian.updateMany({ where: link, data: { canLogin: true } });
    expect(await statuses(r.parentLogin.cookie)).toEqual([200, 200, 200]);
    // The link ended.
    const second = await createGuardian(db, r.school, { fullName: 'Second Mother' });
    await linkGuardian(db, r.school, r.child1, second, { canLogin: true, relationship: 'guardian', isPrimaryContact: false, isFeePayer: false });
    const secondLogin = await guardianLogin(db, r.school, second);
    expect(await statuses(secondLogin.cookie)).toEqual([200, 200, 200]);
    await db.studentGuardian.updateMany({
      where: { schoolId: r.school.id, studentId: r.child1.id, guardianId: second.id },
      data: { endedAt: new Date() },
    });
    expect(await statuses(secondLogin.cookie)).toEqual([404, 404, 404]);
    // Merged into another guardian record.
    const keeper = await createGuardian(db, r.school, { fullName: 'Sana Khan (kept)' });
    await db.guardian.updateMany({ where: { schoolId: r.school.id, id: r.parent.id }, data: { status: 'merged', mergedIntoId: keeper.id } });
    expect(await statuses(r.parentLogin.cookie)).toEqual([404, 404, 404]);
  });

  it('R288 (fix round): on the student page a subject teacher reaches the student but not the report card; the class teacher reads it', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const path = api(`/students/${r.child1.id}/results`);
    const maths = await h.get(path, r.mathsTeacher.cookie);
    expect(maths.status).toBe(200);
    expect(maths.body).toMatchObject({ total: 0, data: [] });
    expect(((await h.get(path, r.classTeacher.cookie)).body as Page<ResultDto>).total).toBe(1);
    expect(((await h.get(path, r.principal.cookie)).body as Page<ResultDto>).total).toBe(1);
  });

  it('R282 (family side): a withheld card shows the guardian the figure owed, the student no figure; never a card', async () => {
    const r = await resultRoom(h);
    await publishMidTerm(r);
    const zara = await stored(r, r.enrolment1);
    const withheld = jest
      .spyOn(h.app.get(ResultCardsService, { strict: false }), 'withheldFor')
      .mockResolvedValue({ withheld: true, outstanding: 4500 });

    const list = (await h.get(api(`/me/children/${r.child1.id}/results`), r.parentLogin.cookie))
      .body as MyChildResultsDto;
    expect(list).toMatchObject({ withheld: true, outstanding: 4500 });
    expect(list.terms[0]).toMatchObject({ percentBp: zara.percentBp, grade: zara.grade });
    const card = await h.get(api(`/me/children/${r.child1.id}/results/${zara.id}`), r.parentLogin.cookie);
    expect(card.status).toBe(200);
    expect(card.body).toEqual({ withheld: true, outstanding: 4500, result: null });

    const self = await studentLogin(db, r.school, r.child1);
    const own = (await h.get(api('/me/student/results'), self.cookie)).body as MyChildResultsDto;
    expect(own).toMatchObject({ withheld: true, outstanding: null });
    expect(own.terms[0]).toMatchObject({ percentBp: null, grade: null });
    expect((await h.get(api(`/me/student/results/${zara.id}`), self.cookie)).body).toEqual({
      withheld: true,
      outstanding: null,
      result: null,
    });

    // A staff read is never withheld (R282).
    const staff = await h.get(api(`/students/${r.child1.id}/results`), r.principal.cookie);
    expect((staff.body as Page<ResultDto>).data[0]?.percentBp).toBe(zara.percentBp);
    expect(withheld).toHaveBeenCalledWith(r.school.id, r.child1.id, r.year.id);
    expect(withheld).toHaveBeenCalledTimes(4); // two lists and two cards; the staff read never asks
  });

  it('R288: the student page lists published, live results, newest first, in the caller\'s student scope', async () => {
    const r = await resultRoom(h);
    const path = api(`/students/${r.child1.id}/results`);
    expect((await h.get(path, r.principal.cookie)).body).toMatchObject({ total: 0, data: [] });
    await publishMidTerm(r);
    const zara = await stored(r, r.enrolment1);
    const res = await h.get(path, r.principal.cookie);
    expect(res.status).toBe(200);
    expect((res.body as Page<ResultDto>).data.map((d) => d.id)).toEqual([String(zara.id)]);
    // student.view as scoped: 6-A's class teacher reaches Zara; 6-B's teacher does not (404).
    expect((await h.get(path, r.classTeacher.cookie)).status).toBe(200);
    expect((await h.get(path, r.bTeacher.cookie)).status).toBe(404);
    expect((await h.get(api('/students/999999999/results'), r.principal.cookie)).status).toBe(404);
    expect((await h.get(path, r.parentLogin.cookie)).status).toBe(403);
  });

  it('R287: the section summary counts the stored passed rows; the subject report averages the stored percent_bp', async () => {
    const r = await resultRoom(h);
    const sheet = await publishMidTerm(r);
    const rows = await db.result.findMany({
      where: { schoolId: r.school.id, sheetId: BigInt(sheet.id), supersededAt: null },
      include: { subjects: true },
    });
    const meanBp = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);

    const summary = await h.get(api(`/result-reports/section-summary?sheetId=${sheet.id}`), r.principal.cookie);
    expect(summary.status).toBe(200);
    const s = summary.body as SectionSummaryReportDto;
    expect(s).toMatchObject({
      sheetId: sheet.id,
      status: 'published',
      sectionName: 'A',
      students: rows.length,
      passed: rows.filter((x) => x.passed === true).length,
      failed: rows.filter((x) => x.passed === false).length,
      averageBp: meanBp(rows.flatMap((x) => (x.percentBp === null ? [] : [x.percentBp]))),
    });
    expect(s.grades.reduce((a, g) => a + g.count, 0)).toBe(rows.length);
    expect(s.subjects.map((x) => x.subjectName)).toEqual(['Mathematics', 'English']);
    const mathsBps = rows.flatMap((x) =>
      x.subjects.filter((y) => y.classSubjectId === r.maths.classSubjectId && y.percentBp !== null).map((y) => y.percentBp ?? 0),
    );
    expect(s.subjects[0]).toMatchObject({ assessed: mathsBps.length, averageBp: meanBp(mathsBps) });

    const subject = await h.get(
      api(`/result-reports/subject?termId=${r.midTermId}&classSubjectId=${r.maths.classSubjectId}`),
      r.principal.cookie,
    );
    expect(subject.status).toBe(200);
    const sub = subject.body as SubjectReportDto;
    expect(sub).toMatchObject({ subjectName: 'Mathematics', assessed: mathsBps.length, averageBp: meanBp(mathsBps) });
    expect(sub.sections).toHaveLength(1);
    expect(sub.sections[0]).toMatchObject({ sectionName: 'A', published: true, averageBp: meanBp(mathsBps) });
    expect(sub.sections[0]?.top[0]?.percentBp).toBe(Math.max(...mathsBps));
    expect(sub.sections[0]?.bottom[0]?.percentBp).toBe(Math.min(...mathsBps));

    // A draft sheet has no stored rows; an unknown sheet or subject is 404; office needs the grant.
    const { body: draft } = await openSheet(h, r.principal, r.sixB.id, r.midTermId);
    const refused = await h.get(api(`/result-reports/section-summary?sheetId=${draft.id}`), r.principal.cookie);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe(ErrorCode.RESULT_SHEET_NOT_APPROVED);
    expect((await h.get(api('/result-reports/section-summary?sheetId=999999999'), r.principal.cookie)).status).toBe(404);
    expect(
      (await h.get(api(`/result-reports/subject?termId=${r.midTermId}&classSubjectId=999999999`), r.principal.cookie)).status,
    ).toBe(404);
    expect((await h.get(api('/result-reports/section-summary'), r.principal.cookie)).status).toBe(422);
    const officePath = api(`/result-reports/section-summary?sheetId=${sheet.id}`);
    expect((await h.get(officePath, r.office.cookie)).status).toBe(403);
    await grant(h, r, r.office, Capability.MARKS_VIEW_ALL);
    expect((await h.get(officePath, r.office.cookie)).status).toBe(200);
  });

  it('slice 36 (security L4): the reports need marks.view_all school-wide — a section-scoped holder is 404', async () => {
    const r = await resultRoom(h);
    const sheet = await publishMidTerm(r);
    // No source scopes marks.view_all to sections today; one that did is simulated: the guard's
    // scope for the class teacher's marks.view_all is their marks.enter scope (their section).
    await grant(h, r, r.classTeacher, Capability.MARKS_VIEW_ALL);
    const permissions = h.app.get(PermissionsService, { strict: false });
    const canAny = permissions.canAny.bind(permissions);
    jest.spyOn(permissions, 'canAny').mockImplementation((schoolId, access, keys) =>
      access.userId === r.classTeacher.userId && keys.includes(Capability.MARKS_VIEW_ALL)
        ? canAny(schoolId, access, [Capability.MARKS_ENTER])
        : canAny(schoolId, access, keys),
    );
    const summary = api(`/result-reports/section-summary?sheetId=${sheet.id}`);
    const subject = api(`/result-reports/subject?termId=${r.midTermId}&classSubjectId=${r.maths.classSubjectId}`);
    expect((await h.get(summary, r.classTeacher.cookie)).status).toBe(404);
    expect((await h.get(subject, r.classTeacher.cookie)).status).toBe(404);
    expect((await h.get(summary, r.principal.cookie)).status).toBe(200);
    expect((await h.get(subject, r.principal.cookie)).status).toBe(200);
  });
});
