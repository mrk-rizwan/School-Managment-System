// Phase 5 slice 42 (contracts/slice-42.md §2.2, §3; phase-5-extended.md A9, R333, R336, R338): the
// class ranking is computed when the last section of a class-term publishes, as a new version
// after a correction (the old one superseded, `results` untouched), ties shared and the unassessed
// listed without a place; racing recomputes serialise; a class that does not hold the term needs
// none; the merit list reads only the live version, pending until the class is complete, and its
// CSV is the rows shown.
import { classRanking } from '@asms/shared';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ClassRankingService } from '../../src/modules/results/class-ranking.service';
import { asSchool, tx } from '../messaging/support';
import { captureOutbox } from '../diary/support';
import { StaffHarness } from '../staff/support';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { isoDay } from '../support/students';
import { api, enterMarks, entryKey, markMidTerm, openSheet, postKeyed, resultRoom, sheetVerb, type ResultRoom } from '../results/support';
import { csvGet, expectCsvHeaders, parseCsv } from './support';

interface MeritList {
  status: 'ranked' | 'pending' | 'not_held';
  className: string;
  termName: string;
  rankingId: string | null;
  trigger: string | null;
  pendingSections: { sectionId: string; sectionName: string }[];
  data: {
    classPosition: number | null;
    positionOf: number | null;
    resultId: string;
    studentName: string;
    sectionName: string;
    percentBp: number | null;
  }[];
  total: number;
}

describe('R333: class rankings and the merit list (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const HELD = isoDay(-5);

  beforeAll(async () => {
    await h.start();
  });
  beforeEach(() => {
    captureOutbox(h);
    const outbox = h.app.get(OutboxDispatcher, { strict: false });
    jest.spyOn(outbox, 'resultNotifyAfterCommit').mockImplementation(() => undefined);
    jest.spyOn(outbox, 'resultRevisedNotifyAfterCommit').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const merit = async (r: ResultRoom, termId: bigint = r.midTermId, who = r.principal) => {
    const res = await h.get(api(`/result-reports/merit-list?classId=${r.klass.id}&termId=${termId}`), who.cookie);
    expect(res.status).toBe(200);
    return res.body as MeritList;
  };
  const versions = (r: ResultRoom) =>
    db.classRanking.findMany({ where: { schoolId: r.school.id, classId: r.klass.id }, orderBy: { id: 'asc' } });
  const liveResults = (r: ResultRoom) =>
    db.result.findMany({
      where: { schoolId: r.school.id, termId: r.midTermId, supersededAt: null, publishedAt: { not: null } },
      orderBy: { id: 'asc' },
    });

  it('R333, R336: pending until the last section publishes; then ranked across sections; a correction is a new version; the merit list and its CSV read the live one', async () => {
    const r = await resultRoom(h);
    const schoolId = r.school.id;
    await markMidTerm(h, r, HELD);
    const { body: sheetA } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheetA.id, 'submit', r.classTeacher)).status).toBe(200);
    expect((await sheetVerb(h, sheetA.id, 'approve', r.principal)).body).toMatchObject({ status: 'published' });

    // 6-B (an enrolment in force on the term's last day) has not published: no ranking, pending.
    expect(await versions(r)).toEqual([]);
    const pending = await merit(r);
    expect(pending).toMatchObject({ status: 'pending', className: 'Six', rankingId: null, data: [], total: 0 });
    expect(pending.pendingSections.map((s) => s.sectionName)).toEqual(['B']);

    // 6-B publishes (the sole principal enters, submits and self-approves): the class ranks.
    await enterMarks(h, r.exams.mathsB, r.bTeacher, [[r.enrolmentB, 60]]);
    await enterMarks(h, r.exams.englishB, r.principal, [[r.enrolmentB, 66]]);
    const { body: sheetB } = await openSheet(h, r.principal, r.sixB.id, r.midTermId);
    expect((await sheetVerb(h, sheetB.id, 'submit', r.principal)).status).toBe(200);
    expect((await sheetVerb(h, sheetB.id, 'approve', r.principal)).body).toMatchObject({ status: 'published' });

    const [first, ...more] = await versions(r);
    expect(more).toEqual([]);
    expect(first).toMatchObject({ trigger: 'publish', supersedesId: null, supersededAt: null, termId: r.midTermId });
    const live = await liveResults(r);
    expect(live).toHaveLength(3);
    // The positions are the shared classRanking of the stored percentages, across both sections.
    const expected = classRanking(live.map((x) => ({ resultId: String(x.id), studentId: String(x.studentId), percentBp: x.percentBp })));
    const rows = await db.classRankingRow.findMany({ where: { schoolId, rankingId: first?.id } });
    expect(rows.map((x) => [String(x.resultId), x.classPosition, x.positionOf]).sort()).toEqual(
      expected.map((x) => [x.resultId, x.classPosition, x.positionOf]).sort(),
    );
    // The card keeps the section position: 6-B's only student is 1 of 1 in the section.
    const resultB = live.find((x) => x.enrolmentId === r.enrolmentB);
    expect([resultB?.position, resultB?.positionOf]).toEqual([1, 1]);
    const computed = await db.auditLog.findFirstOrThrow({ where: { schoolId, action: 'class_ranking.computed', subjectId: first?.id } });
    expect(computed.metadata).toMatchObject({ trigger: 'publish', rows: 3, positioned: 3, classId: String(r.klass.id) });

    // The merit list: the live version, best first.
    const ranked = await merit(r);
    expect(ranked).toMatchObject({ status: 'ranked', rankingId: String(first?.id), trigger: 'publish', pendingSections: [], total: 3 });
    expect(ranked.data.map((d) => d.resultId)).toEqual(expected.map((x) => x.resultId));
    expect(ranked.data.map((d) => d.classPosition)).toEqual(expected.map((x) => x.classPosition));

    // Its CSV: exactly those rows, audited with the filters.
    const csv = await csvGet(h.app, `/result-reports/merit-list?classId=${r.klass.id}&termId=${r.midTermId}&format=csv`, r.principal.cookie);
    expectCsvHeaders(csv, 'merit-list');
    const [header, ...records] = parseCsv(csv.text);
    expect(header).toEqual(['Position', 'Of', 'Student', 'Admission no', 'Section', 'Percent', 'Grade', 'Passed']);
    expect(records.map((x) => x[2])).toEqual(ranked.data.map((d) => d.studentName));
    expect(records.map((x) => x[5])).toEqual(ranked.data.map((d) => (d.percentBp === null ? '' : String(d.percentBp / 100))));
    const exported = await db.auditLog.findFirstOrThrow({ where: { schoolId, action: 'result_report.exported' } });
    expect(exported.metadata).toMatchObject({
      report: 'merit-list',
      rowCount: 3,
      filters: { classId: String(r.klass.id), termId: String(r.midTermId) },
    });

    // A correction of Ali's Maths exam (55 -> 95) approved: a new version superseding the first.
    const exam = await db.mark.findFirstOrThrow({
      where: { schoolId, assessmentId: r.exams.mathsA, enrolmentId: r.enrolment2, status: 'live' },
    });
    const asked = await postKeyed(h, api(`/marks/${exam.id}/correct`), { obtained: 95, reason: 'Paper re-totalled' }, r.mathsTeacher.cookie, entryKey());
    expect(asked.status).toBe(201);
    const decided = await h.send('post', api(`/mark-corrections/${(asked.body as { id: string }).id}/approve`), {}, r.principal.cookie);
    expect(decided.status).toBe(200);
    const [old, next, ...none] = await versions(r);
    expect(none).toEqual([]);
    expect(old?.supersededAt).not.toBeNull();
    expect(next).toMatchObject({ trigger: 'correction', supersedesId: old?.id, supersededAt: null });
    // `results` untouched by the ranking: 6-B's row is the same live row; the corrected section's
    // rows are the cascade's new version, and the new ranking names exactly the live rows.
    const after = await liveResults(r);
    expect(after.find((x) => x.enrolmentId === r.enrolmentB)?.id).toBe(resultB?.id);
    const nextRows = await db.classRankingRow.findMany({ where: { schoolId, rankingId: next?.id } });
    expect(nextRows.map((x) => x.resultId).sort()).toEqual(after.map((x) => x.id).sort());
    const reread = await merit(r);
    expect(reread.rankingId).toBe(String(next?.id));
    expect(reread.data.map((d) => d.resultId).sort()).toEqual(after.map((x) => String(x.id)).sort());
    // The old version's rows stay, naming the superseded results.
    expect(await db.classRankingRow.count({ where: { schoolId, rankingId: old?.id } })).toBe(3);
  });

  it('R333: ties share a place, the unassessed are listed without one; racing recomputes serialise into a chain; a term the class does not hold needs none', async () => {
    const r = await resultRoom(h);
    const schoolId = r.school.id;
    const decider = (await createSchoolUser(db, r.school, { systemRole: 'principal' })).userId;
    // Both sections' Mid-term sheets published, written directly: Zara and Sara tie at 80 %, Ali
    // has nothing assessed (no percentage, grade, verdict or place).
    const now = new Date();
    for (const [sectionId, rows] of [
      [r.sixA.id, [[r.enrolment1, r.child1.id, 8000], [r.enrolment2, r.child2.id, null]]],
      [r.sixB.id, [[r.enrolmentB, r.childB.id, 8000]]],
    ] as const) {
      const sheet = await db.resultSheet.create({
        data: { schoolId, academicYearId: r.year.id, termId: r.midTermId, classId: r.klass.id, sectionId, createdBy: r.principal.userId },
      });
      const where = { schoolId, id: sheet.id };
      await db.resultSheet.updateMany({ where, data: { status: 'submitted', submittedBy: r.classTeacher.userId, submittedAt: now } });
      await db.resultSheet.updateMany({
        where,
        data: {
          status: 'approved',
          decidedBy: decider,
          decidedAt: now,
          testWeight: 20,
          examWeight: 80,
          passPercent: 40,
          passRule: 'all_subjects',
          bands: [{ grade: 'A', minPercent: 80 }, { grade: 'F', minPercent: 0 }],
        },
      });
      await db.resultSheet.updateMany({ where, data: { status: 'published', publishedBy: decider, publishedAt: now } });
      for (const [enrolmentId, studentId, percentBp] of rows) {
        await db.result.create({
          data: {
            schoolId,
            sheetId: sheet.id,
            enrolmentId,
            studentId,
            academicYearId: r.year.id,
            termId: r.midTermId,
            totalObtained: percentBp === null ? 0 : 80,
            totalMax: percentBp === null ? 0 : 100,
            percentBp,
            grade: percentBp === null ? null : 'A',
            passed: percentBp === null ? null : true,
            position: percentBp === null ? null : 1,
            positionOf: percentBp === null ? null : 1,
            publishedAt: now,
          },
        });
      }
    }
    const rankings = h.app.get(ClassRankingService, { strict: false });
    const recompute = () =>
      asSchool(h.app, schoolId, () => tx.run(() => rankings.recompute(schoolId, r.klass.id, r.midTermId, 'import', r.principal.userId)));
    const firstId = await recompute();
    expect(firstId).not.toBeNull();
    const list = await merit(r);
    expect(list.data.map((d) => [d.studentName, d.classPosition, d.positionOf])).toEqual([
      ['Sara Malik', 1, 2],
      ['Zara Khan', 1, 2],
      ['Ali Raza', null, null],
    ]);

    // Two recomputes at once: the advisory lock serialises them; each supersedes the one before.
    const [a, b] = await Promise.all([recompute(), recompute()]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const chain = await versions(r);
    expect(chain).toHaveLength(3);
    expect(chain.filter((v) => v.supersededAt === null)).toHaveLength(1);
    expect(new Set(chain.map((v) => v.supersedesId))).toEqual(new Set([null, chain[0]?.id, chain[1]?.id]));
    expect(chain.every((v) => v.trigger === 'import')).toBe(true);

    // The Annual term: nothing published yet — pending, both sections named; skipped — not held.
    expect((await merit(r, r.annualTermId)).pendingSections.map((s) => s.sectionName)).toEqual(['A', 'B']);
    await db.termSkip.create({
      data: { schoolId, academicYearId: r.year.id, termId: r.annualTermId, classId: r.klass.id, reason: 'No annual exam this year', createdBy: r.principal.userId },
    });
    expect(await merit(r, r.annualTermId)).toMatchObject({ status: 'not_held', pendingSections: [], data: [] });
    const skipped = await asSchool(h.app, schoolId, () =>
      tx.run(() => rankings.recompute(schoolId, r.klass.id, r.annualTermId, 'publish', r.principal.userId)),
    );
    expect(skipped).toBeNull();
  });

  it('R338: the merit list is marks.view_all, school-wide; an unknown class or a term of another year is 404', async () => {
    const r = await resultRoom(h);
    const other = await resultRoom(h);
    expect((await h.get(api(`/result-reports/merit-list?classId=${r.klass.id}&termId=${r.midTermId}`), r.classTeacher.cookie)).status).toBe(403);
    expect((await h.get(api(`/result-reports/merit-list?classId=${other.klass.id}&termId=${other.midTermId}`), r.principal.cookie)).status).toBe(404);
    expect((await h.get(api(`/result-reports/merit-list?classId=${r.klass.id}&termId=${other.midTermId}`), r.principal.cookie)).status).toBe(404);
    expect((await h.get(api(`/result-reports/merit-list?classId=${r.klass.id}`), r.principal.cookie)).status).toBe(422);
    // A GET never writes: no ranking appears from reading a pending list.
    await merit(r);
    expect(await versions(r)).toEqual([]);
  });
});
