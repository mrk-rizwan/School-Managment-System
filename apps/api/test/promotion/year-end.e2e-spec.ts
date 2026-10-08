// R300, the year-end script (phase-4-academic.md §8, contracts/slice-35.md §7): two sections of
// Class 5 and the final Class 10, a detained student, an alumnus, a withdrawn (not continuing)
// student, a suspended student promoted, arrears carried in their year, a correction approved
// after apply (revised_after_apply), the year closed, and the next year's charge generation
// finding exactly the new enrolments. The real AppModule and database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../core/app';
import { db, karachi, runMonth, structure } from '../fees/charges-support';
import { monthOf } from '../finance-reports/support';
import { closeTestDb } from '../support/schools';
import { day } from '../support/students';
import { approvedSheet, detailOf, promotionHttp, promotionWorld, rowOf, student, supersede } from './support';

describe('R300: the year-end script (e2e)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('promotes, detains, completes and withdraws; carries arrears; marks a later correction; closes the year; next year charges the new enrolments', async () => {
    const w = await promotionWorld(() => app);
    const by = w.principal.user.userId;
    const tuition = (academicYearId: bigint, classId: bigint, amount: number, from: string) =>
      structure(w.school, { academicYearId, classId, feeHeadId: w.heads.tuition, amount, effectiveFrom: from }, by);
    await tuition(w.yearA.id, w.a5, 3000, w.yearA.startsOn.slice(0, 7));
    await tuition(w.yearA.id, w.a10, 4000, w.yearA.startsOn.slice(0, 7));
    await tuition(w.yearB.id, w.b6, 3500, w.yearB.startsOn.slice(0, 7));
    await tuition(w.yearB.id, w.b5, 3000, w.yearB.startsOn.slice(0, 7));

    // 5-A: a pass, a fail (detained), a pass not continuing, a suspended pass. 5-B: two passes.
    // 10-A: a pass who completes school.
    const amina = await student(w, w.a5A, 'Amina Bashir');
    const bilal = await student(w, w.a5A, 'Bilal Shah');
    const danish = await student(w, w.a5A, 'Danish Iqbal');
    const esha = await student(w, w.a5A, 'Esha Noor', 'suspended');
    const farah = await student(w, w.a5B, 'Farah Javed');
    const ghazi = await student(w, w.a5B, 'Ghazi Khan');
    const hamid = await student(w, w.a10A, 'Hamid Ali');
    // Arrears: a past month of year A, generated and unpaid.
    await runMonth(app, w.school, w.yearA, monthOf(-45), karachi(`${monthOf(-45)}-01`));

    const fiveA = await approvedSheet(w, w.a5A, [
      [amina, true],
      [bilal, false],
      [danish, true],
      [esha, true],
    ], { publish: true });
    await approvedSheet(w, w.a5B, [
      [farah, true],
      [ghazi, true],
    ], { publish: true });
    await approvedSheet(w, w.a10A, [[hamid, true]], { publish: true });

    // Closing now is refused with the three sections.
    const early = await h.close(w.yearA.id, w.principal).expect(409);
    const blocking = (early.body as { error: { code: string; details: { sections: { sectionId: string }[] } } }).error;
    expect(blocking.code).toBe('PROMOTION_INCOMPLETE');
    expect(blocking.details.sections.map((s) => s.sectionId).sort()).toEqual([w.a5A.id, w.a5B.id, w.a10A.id].map(String).sort());

    const sheetA = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const sheetB = detailOf(await h.open(w.a5B.id, w.yearB.id, w.principal).expect(201));
    const sheet10 = detailOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(201));
    // Every student owes the past month: flagged, never blocked.
    for (const sheet of [sheetA, sheetB, sheet10]) expect(sheet.decisions.every((d) => d.arrearsFlag)).toBe(true);
    expect(rowOf(sheetA, bilal)).toMatchObject({ proposed: 'detain', decision: 'detain', targetClassId: w.b5.toString() });
    expect(rowOf(sheet10, hamid)).toMatchObject({ proposed: 'complete', decision: 'complete' });
    await h.decide(sheetA.id, [{ enrolmentId: danish.enrolmentId.toString(), decision: 'not_continuing', reason: 'Family moving to Karachi' }], w.principal).expect(200);

    const appliedA = detailOf(await h.apply(sheetA.id, w.principal).expect(200));
    const appliedB = detailOf(await h.apply(sheetB.id, w.principal).expect(200));
    await h.apply(sheet10.id, w.principal).expect(200);

    // Statuses: the alumnus, the withdrawn student; the suspended student stays suspended, promoted.
    const students = await db().student.findMany({ where: { schoolId: w.school.id, id: { in: [amina, bilal, danish, esha, hamid].map((p) => p.studentId) } } });
    const statusOf = (p: { studentId: bigint }) => students.find((s) => s.id === p.studentId)?.status;
    expect([amina, bilal, danish, esha, hamid].map(statusOf)).toEqual(['active', 'active', 'withdrawn', 'suspended', 'alumni']);

    // The new enrolments: five, in year B, no roll numbers.
    const next = await db().enrolment.findMany({ where: { schoolId: w.school.id, academicYearId: w.yearB.id }, orderBy: { id: 'asc' } });
    expect(next).toHaveLength(5);
    expect(next.every((e) => e.rollNo === null && e.status === 'active' && e.startedOn.getTime() === day(w.yearB.startsOn).getTime())).toBe(true);
    const placed = (p: { studentId: bigint }) => next.find((e) => e.studentId === p.studentId)?.classId;
    expect([amina, bilal, esha, farah, ghazi].map(placed)).toEqual([w.b6, w.b5, w.b6, w.b6, w.b6]);
    expect(rowOf(appliedB, farah).newEnrolmentId).toBe(next.find((e) => e.studentId === farah.studentId)?.id.toString());

    // Arrears stay in year A: the dues endpoint still shows them after promotion.
    const dues = await h.get(`/students/${amina.studentId}/dues-clearance`, w.principal).expect(200);
    expect((dues.body as { cleared: boolean; outstanding: number }).outstanding).toBeGreaterThan(0);
    const yearACharges = await db().charge.count({ where: { schoolId: w.school.id, studentId: amina.studentId, academicYearId: w.yearA.id, status: 'open' } });
    expect(yearACharges).toBeGreaterThan(0);

    // A correction approved after apply supersedes Amina's final result: the row is marked, the
    // enrolment apply opened stands.
    const aminaResult = fiveA.resultIds.get(amina.enrolmentId);
    if (aminaResult === undefined) throw new Error('no result');
    await supersede(w, aminaResult);
    const revised = rowOf(detailOf(await h.detail(sheetA.id, w.principal).expect(200)), amina);
    expect(revised).toMatchObject({ revisedAfterApply: true, newEnrolmentId: rowOf(appliedA, amina).newEnrolmentId });

    // The year closes; the next year opens for business and its first full month charges exactly
    // the new enrolments (not the withdrawn student, not the alumnus).
    expect(((await h.close(w.yearA.id, w.principal).expect(200)).body as { status: string }).status).toBe('closed');
    await h.post(`/academic-years/${w.yearB.id}/activate`, {}, w.principal).expect(200);
    const period = monthOf(200);
    await runMonth(app, w.school, w.yearB, period, karachi(`${period}-01`));
    const charged = await db().charge.findMany({ where: { schoolId: w.school.id, academicYearId: w.yearB.id, period } });
    expect(charged.map((c) => c.enrolmentId).sort()).toEqual(next.map((e) => e.id).sort());
    const amountOf = (p: { studentId: bigint }) => charged.find((c) => c.studentId === p.studentId)?.amount;
    expect([amina, bilal, esha].map(amountOf)).toEqual([3500, 3000, 3500]);
  });
});
