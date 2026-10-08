// R300, the year-end script (phase-4-academic.md §8, contracts/slice-35.md §7): two sections of
// Class 5 and the final Class 10, a detained student, an alumnus, a withdrawn (not continuing)
// student, a suspended student promoted, arrears carried in their year, a correction approved
// after apply (revised_after_apply), the year closed, and the next year's charge generation
// finding exactly the new enrolments. The real AppModule and database. Since slice 36 the results
// are real: the Mid-term marked, its sheets submitted and approved, the finals approved, and the
// correction asked for and approved through the API.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { createTestApp } from '../core/app';
import { db, karachi, runMonth, structure } from '../fees/charges-support';
import { monthOf } from '../finance-reports/support';
import { closeTestDb } from '../support/schools';
import { ORIGIN } from '../payments/payments-support';
import { createSubject, createTeacherAssignment, day, isoDay, type TestSection } from '../support/students';
import { detailOf, promotionHttp, promotionWorld, rowOf, student } from './support';

describe('R300: the year-end script (e2e)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    const outbox = app.get(OutboxDispatcher, { strict: false });
    jest.spyOn(outbox, 'resultNotifyAfterCommit').mockImplementation(() => undefined);
    jest.spyOn(outbox, 'resultRevisedNotifyAfterCommit').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
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

    // The results, through the API: Mathematics on both classes, the Annual term not held for
    // them, the Mid-term exams entered (75 passes, 20 fails), each term sheet submitted by the
    // class teacher and approved (published) by the principal, then each final approved.
    const schoolId = w.school.id;
    const maths = await createSubject(db(), w.school, { name: 'Mathematics' });
    for (const classId of [w.a5, w.a10]) {
      await db().classSubject.create({
        data: { schoolId, academicYearId: w.yearA.id, classId, subjectId: maths.id, sortOrder: 1, examMaxMarks: 100 },
      });
    }
    for (const section of [w.a5A, w.a5B, w.a10A]) {
      await createTeacherAssignment(db(), w.school, w.teacher.user, { role: 'class_teacher', section, startsOn: w.yearA.startsOn });
      await createTeacherAssignment(db(), w.school, w.teacher.user, {
        role: 'subject_teacher',
        subjectId: maths.id,
        section,
        startsOn: w.yearA.startsOn,
      });
    }
    const [mid, annual] = await db().academicTerm.findMany({ where: { schoolId, academicYearId: w.yearA.id }, orderBy: { sortOrder: 'asc' } });
    for (const classId of [w.a5, w.a10]) {
      await h.post(`/terms/${annual!.id}/skip-class`, { classId: String(classId), reason: 'One term this year' }, w.principal).expect(200);
    }
    await h.post(`/terms/${mid!.id}/set-up-exams`, {}, w.principal).expect(200);
    const exams = await db().assessment.findMany({ where: { schoolId, termId: mid!.id, kind: 'exam' } });
    const examOf = (section: TestSection) => exams.find((e) => e.sectionId === section.id)!;
    const publish = async (section: TestSection, marks: readonly (readonly [{ enrolmentId: bigint }, number])[]) => {
      await h
        .http()
        .post(`/api/v1/assessments/${examOf(section).id}/submit-marks`)
        .set('Cookie', w.teacher.cookie)
        .set('Origin', ORIGIN)
        .send({
          entries: marks.map(([p, obtained]) => ({
            enrolmentId: String(p.enrolmentId),
            obtained,
            clientEntryKey: newIdempotencyKey(),
            basedOnMarkId: null,
          })),
        })
        .expect(200);
      const term = await h.post(`/sections/${section.id}/result-sheets`, { termId: String(mid!.id) }, w.teacher).expect(201);
      const termSheetId = (term.body as { id: string }).id;
      await h.post(`/result-sheets/${termSheetId}/submit`, {}, w.teacher).expect(200);
      const approvedTerm = await h.post(`/result-sheets/${termSheetId}/approve`, {}, w.principal).expect(200);
      expect((approvedTerm.body as { status: string }).status).toBe('published');
      const final = await h.post(`/sections/${section.id}/result-sheets`, { termId: null }, w.principal).expect(201);
      const finalSheetId = (final.body as { id: string }).id;
      const approvedFinal = await h.post(`/result-sheets/${finalSheetId}/approve`, {}, w.principal).expect(200);
      expect((approvedFinal.body as { status: string }).status).toBe('published');
    };
    // Distinct marks, so the correction below moves no one else's position.
    await publish(w.a5A, [
      [amina, 75],
      [bilal, 20],
      [danish, 70],
      [esha, 65],
    ]);
    await publish(w.a5B, [
      [farah, 75],
      [ghazi, 75],
    ]);
    await publish(w.a10A, [[hamid, 75]]);
    const finalOf = (p: { enrolmentId: bigint }) =>
      db().result.findFirstOrThrow({ where: { schoolId, enrolmentId: p.enrolmentId, termId: null, supersededAt: null } });
    expect([(await finalOf(amina)).passed, (await finalOf(bilal)).passed]).toEqual([true, false]);

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
    // The detained student stays in the same-name section of the same class next year.
    expect(rowOf(sheetA, bilal)).toMatchObject({
      proposed: 'detain',
      decision: 'detain',
      targetClassId: w.b5.toString(),
      targetSectionId: w.b5A.id.toString(),
    });
    expect(rowOf(sheet10, hamid)).toMatchObject({ proposed: 'complete', decision: 'complete' });
    // A suspended student cannot be not continuing (reactivate first): refused.
    const suspendedOut = await h.decide(sheetA.id, [{ enrolmentId: esha.enrolmentId.toString(), decision: 'not_continuing', reason: 'Not coming back' }], w.principal);
    expect([suspendedOut.status, (suspendedOut.body as { error: { code: string } }).error.code]).toEqual([409, 'STUDENT_NOT_ACTIVE']);
    await h.decide(sheetA.id, [{ enrolmentId: danish.enrolmentId.toString(), decision: 'not_continuing', reason: 'Family moving to Karachi' }], w.principal).expect(200);

    const appliedA = detailOf(await h.apply(sheetA.id, w.principal).expect(200));
    const appliedB = detailOf(await h.apply(sheetB.id, w.principal).expect(200));
    await h.apply(sheet10.id, w.principal).expect(200);

    // Statuses: the alumnus, the withdrawn student; the suspended student stays suspended, promoted.
    const students = await db().student.findMany({ where: { schoolId: w.school.id, id: { in: [amina, bilal, danish, esha, hamid].map((p) => p.studentId) } } });
    const statusOf = (p: { studentId: bigint }) => students.find((s) => s.id === p.studentId)?.status;
    expect([amina, bilal, danish, esha, hamid].map(statusOf)).toEqual(['active', 'active', 'withdrawn', 'suspended', 'alumni']);
    // The withdrawal takes effect today (inside the year, which ends later).
    const withdrawal = await db().studentStatusChange.findFirstOrThrow({ where: { schoolId, studentId: danish.studentId, toStatus: 'withdrawn' } });
    expect(withdrawal.effectiveOn).toEqual(day(isoDay(0)));

    // The new enrolments: five, in year B, no roll numbers.
    const next = await db().enrolment.findMany({ where: { schoolId: w.school.id, academicYearId: w.yearB.id }, orderBy: { id: 'asc' } });
    expect(next).toHaveLength(5);
    expect(next.every((e) => e.rollNo === null && e.status === 'active' && e.startedOn.getTime() === day(w.yearB.startsOn).getTime())).toBe(true);
    const placed = (p: { studentId: bigint }) => next.find((e) => e.studentId === p.studentId)?.classId;
    expect([amina, bilal, esha, farah, ghazi].map(placed)).toEqual([w.b6, w.b5, w.b6, w.b6, w.b6]);
    expect(next.find((e) => e.studentId === bilal.studentId)?.sectionId).toBe(w.b5A.id);
    expect(rowOf(appliedB, farah).newEnrolmentId).toBe(next.find((e) => e.studentId === farah.studentId)?.id.toString());

    // Arrears stay in year A: the dues endpoint still shows them after promotion.
    const dues = await h.get(`/students/${amina.studentId}/dues-clearance`, w.principal).expect(200);
    expect((dues.body as { cleared: boolean; outstanding: number }).outstanding).toBeGreaterThan(0);
    const yearACharges = await db().charge.count({ where: { schoolId: w.school.id, studentId: amina.studentId, academicYearId: w.yearA.id, status: 'open' } });
    expect(yearACharges).toBeGreaterThan(0);

    // A correction asked for and approved after apply (POST /marks/:id/correct, then approve)
    // re-composes 5-A's term and final results as new versions with the full row set, but
    // results_promotion_revised marks only the applied row whose figures changed (Amina's); the
    // enrolment apply opened stands; 5-A's other rows and 5-B are untouched.
    const aminaMark = await db().mark.findFirstOrThrow({
      where: { schoolId, assessmentId: examOf(w.a5A).id, studentId: amina.studentId, status: 'live' },
    });
    const asked = await h.post(`/marks/${aminaMark.id}/correct`, { obtained: 80, reason: 'Paper re-totalled' }, w.teacher, newIdempotencyKey()).expect(201);
    await h.post(`/mark-corrections/${(asked.body as { id: string }).id}/approve`, {}, w.principal).expect(200);
    expect((await finalOf(amina)).percentBp).toBe(8000);
    const afterA = detailOf(await h.detail(sheetA.id, w.principal).expect(200));
    expect(rowOf(afterA, amina)).toMatchObject({ revisedAfterApply: true, newEnrolmentId: rowOf(appliedA, amina).newEnrolmentId });
    // The others' results were superseded too (the full row set), unchanged: not marked.
    expect(await db().result.count({ where: { schoolId, enrolmentId: bilal.enrolmentId, termId: null, supersededAt: { not: null } } })).toBe(1);
    expect([bilal, danish, esha].map((p) => rowOf(afterA, p).revisedAfterApply)).toEqual([false, false, false]);
    expect(rowOf(detailOf(await h.detail(sheetB.id, w.principal).expect(200)), farah).revisedAfterApply).toBe(false);

    // The year closes; the next year opens for business and its first full month charges exactly
    // the new enrolments (not the withdrawn student, not the alumnus).
    expect(((await h.close(w.yearA.id, w.principal).expect(200)).body as { status: string }).status).toBe('closed');
    // Dues stay open after the year closes (rule 30): the arrears are still owed in year A.
    const duesAfter = await h.get(`/students/${amina.studentId}/dues-clearance`, w.principal).expect(200);
    expect((duesAfter.body as { outstanding: number }).outstanding).toBeGreaterThan(0);
    expect(await db().charge.count({ where: { schoolId, studentId: amina.studentId, academicYearId: w.yearA.id, status: 'open' } })).toBeGreaterThan(0);
    await h.post(`/academic-years/${w.yearB.id}/activate`, {}, w.principal).expect(200);
    const period = monthOf(200);
    await runMonth(app, w.school, w.yearB, period, karachi(`${period}-01`));
    const charged = await db().charge.findMany({ where: { schoolId: w.school.id, academicYearId: w.yearB.id, period } });
    expect(charged.map((c) => c.enrolmentId).sort()).toEqual(next.map((e) => e.id).sort());
    const amountOf = (p: { studentId: bigint }) => charged.find((c) => c.studentId === p.studentId)?.amount;
    expect([amina, bilal, esha].map(amountOf)).toEqual([3500, 3000, 3500]);
  });
});
