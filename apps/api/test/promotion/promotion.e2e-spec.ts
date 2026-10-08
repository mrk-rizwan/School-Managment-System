// Slice 35: promotion and year end (phase-4-academic.md §1.1 rule 30, §3.2, §7.1, R294-R299;
// contracts/slice-35.md). Opening a sheet from the approved final (or only held term's) result,
// the proposals and arrears flags, decisions with reasons, apply in one transaction (enrolments
// completed and opened, alumni, withdrawals), the refusals, revised_after_apply, and the
// year-close guard. The real AppModule and database; results are written straight to the tables.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { db, karachi, runMonth, structure } from '../fees/charges-support';
import { monthOf } from '../finance-reports/support';
import { closeTestDb } from '../support/schools';
import { createSection, day, isoDay } from '../support/students';
import {
  approvedSheet,
  detailOf,
  promotionHttp,
  promotionWorld,
  rowOf,
  student,
  supersede,
  type PromotionWorld,
} from './support';

interface ErrorBody {
  error: { code: string; details: Record<string, unknown> | null };
}
const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

describe('slice 35: promotion and year end (e2e)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /**
   * Class 5-A of a fresh world: a pass, a fail, one with nothing assessed, a passing leaver and a
   * passing suspended pupil; the final sheet approved with their results.
   */
  async function classFive(w: PromotionWorld) {
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    const fail = await student(w, w.a5A, 'Hira Tariq');
    const none = await student(w, w.a5A, 'Zainab Khan');
    const leaver = await student(w, w.a5A, 'Bilal Shah');
    const suspended = await student(w, w.a5A, 'Usman Ali', 'suspended');
    const sheet = await approvedSheet(w, w.a5A, [
      [pass, true],
      [fail, false],
      [none, null],
      [leaver, true],
      [suspended, true],
    ]);
    return { pass, fail, none, leaver, suspended, sheet };
  }

  it('R294: needs the approved final sheet; proposes promote, detain or nothing; prefills a complete proposal; flags arrears without blocking', async () => {
    const w = await promotionWorld(() => app);
    // Tuition overdue for the pupils enrolled before the month ran: their arrears are flagged.
    await structure(w.school, { academicYearId: w.yearA.id, classId: w.a5, feeHeadId: w.heads.tuition, amount: 3000, effectiveFrom: w.yearA.startsOn.slice(0, 7) }, w.principal.user.userId);
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    const fail = await student(w, w.a5A, 'Hira Tariq');
    await runMonth(app, w.school, w.yearA, monthOf(-45), karachi(`${monthOf(-45)}-01`));
    const none = await student(w, w.a5A, 'Zainab Khan');

    // No final sheet yet: refused, nothing written.
    const early = await h.open(w.a5A.id, w.yearB.id, w.principal);
    expect(early.status).toBe(409);
    expect(errorOf(early)).toMatchObject({ code: 'PROMOTION_FINAL_NOT_APPROVED', details: { sectionId: w.a5A.id.toString() } });

    await approvedSheet(w, w.a5A, [
      [pass, true],
      [fail, false],
      [none, null],
    ]);
    // The target year is another, planned or active, year.
    expect(errorOf(await h.open(w.a5A.id, w.yearA.id, w.principal).expect(422)).code).toBe('VALIDATION_FAILED');

    const key = newIdempotencyKey();
    const opened = await h.open(w.a5A.id, w.yearB.id, w.principal, key).expect(201);
    const sheet = detailOf(opened);
    expect(sheet).toMatchObject({ status: 'open', rows: 3, undecided: 1, targetYearHasClasses: true });
    expect(rowOf(sheet, pass)).toMatchObject({
      proposed: 'promote',
      decision: 'promote',
      passed: true,
      targetClassId: w.b6.toString(),
      targetSectionId: w.b6A.id.toString(),
      arrearsFlag: true,
      reason: null,
    });
    // Detained into the namesake class of the target year.
    expect(rowOf(sheet, fail)).toMatchObject({
      proposed: 'detain',
      decision: 'detain',
      targetClassId: w.b5.toString(),
      targetSectionId: w.b5A.id.toString(),
      arrearsFlag: true,
    });
    expect(rowOf(sheet, none)).toMatchObject({ proposed: null, decision: null, passed: null, arrearsFlag: false });

    // A replay of the key answers the same sheet; another open is refused while this one is open.
    const replay = await h.open(w.a5A.id, w.yearB.id, w.principal, key).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(detailOf(replay).id).toBe(sheet.id);
    const again = await h.open(w.a5A.id, w.yearB.id, w.principal).expect(409);
    expect(errorOf(again)).toMatchObject({ code: 'PROMOTION_SHEET_OPEN', details: { sheetId: sheet.id } });

    // The list, filtered by year.
    const list = await h.get(`/promotion-sheets?academicYearId=${w.yearA.id}`, w.principal).expect(200);
    expect((list.body as { data: { id: string; undecided: number }[] }).data).toEqual([
      expect.objectContaining({ id: sheet.id, undecided: 1 }),
    ]);
    const audit = await db().auditLog.findMany({ where: { schoolId: w.school.id, action: 'promotion_sheet.opened' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ rows: 3, source: 'final', arrears: 2, proposed: { promote: 1, detain: 1, complete: 0, none: 1 } });
  });

  it('R294: a final class proposes complete; a year with one held term promotes from that term; the next class must be of the target year', async () => {
    const w = await promotionWorld(() => app);
    const senior = await student(w, w.a10A, 'Ali Raza');
    // Class 10 holds only the Mid-term: its term sheet is the source.
    const terms = await db().academicTerm.findMany({ where: { schoolId: w.school.id, academicYearId: w.yearA.id }, orderBy: { sortOrder: 'asc' } });
    const [mid, annual] = terms;
    if (!mid || !annual) throw new Error('seeded terms missing');
    await db().termSkip.create({
      data: { schoolId: w.school.id, academicYearId: w.yearA.id, termId: annual.id, classId: w.a10, reason: 'Board exams', createdBy: w.principal.user.userId },
    });
    // A final sheet does not count for a one-term class.
    await approvedSheet(w, w.a10A, [[senior, true]]);
    expect(errorOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(409)).code).toBe('PROMOTION_FINAL_NOT_APPROVED');
    await approvedSheet(w, w.a10A, [[senior, true]], { termId: mid.id });
    const sheet = detailOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(201));
    expect(rowOf(sheet, senior)).toMatchObject({ proposed: 'complete', decision: 'complete', targetClassId: null });

    // Class 5's next class must be in the target year: a third year has no Class 6.
    const pupil = await student(w, w.a5B, 'Sara Ahmed');
    await approvedSheet(w, w.a5B, [[pupil, true]]);
    const yearC = await db().academicYear.create({
      data: { schoolId: w.school.id, name: 'Year C', startsOn: day(isoDay(600)), endsOn: day(isoDay(900)), status: 'planned' },
    });
    const other = await h.open(w.a5B.id, yearC.id, w.principal).expect(409);
    expect(errorOf(other)).toMatchObject({ code: 'PROMOTION_TARGET_INVALID', details: { reason: 'other_year' } });
    // A closed target year is refused.
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: yearC.id }, data: { status: 'closed' } });
    expect(errorOf(await h.open(w.a5B.id, yearC.id, w.principal).expect(409)).code).toBe('ACADEMIC_YEAR_CLOSED');
  });

  it('R295: a decision other than the proposal, or with none, needs a reason; not_continuing needs student.status.change and an active student', async () => {
    const w = await promotionWorld(() => app);
    const { pass, fail, none, suspended } = await classFive(w);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));

    const refuse = async (decisions: object[], code: string) => {
      const res = await h.decide(sheet.id, decisions, w.principal);
      expect(errorOf(res).code).toBe(code);
      return res;
    };
    // Promote a failed student without a reason: refused on the reason.
    const noReason = await refuse([{ enrolmentId: fail.enrolmentId.toString(), decision: 'promote' }], 'VALIDATION_FAILED');
    expect(JSON.stringify(errorOf(noReason).details)).toContain('decisions[0].reason');
    // No proposal: any decision needs a reason.
    await refuse([{ enrolmentId: none.enrolmentId.toString(), decision: 'detain' }], 'VALIDATION_FAILED');
    // A student not on the sheet.
    await refuse([{ enrolmentId: '999999999', decision: 'detain', reason: 'Repeat the year' }], 'VALIDATION_FAILED');
    // A suspended student cannot be marked not continuing (reactivate first).
    await refuse(
      [{ enrolmentId: suspended.enrolmentId.toString(), decision: 'not_continuing', reason: 'Family moving abroad' }],
      'STUDENT_NOT_ACTIVE',
    );
    // A target class of another year is refused.
    await refuse(
      [{ enrolmentId: pass.enrolmentId.toString(), decision: 'promote', targetClassId: w.a10.toString() }],
      'PROMOTION_TARGET_INVALID',
    );

    // assessment.define granted to a teacher, without student.status.change: not_continuing is refused.
    await db().userCapabilityGrant.create({
      data: { schoolId: w.school.id, userId: w.teacher.user.userId, capabilityKey: 'assessment.define', effect: 'grant', grantedBy: w.principal.user.userId, reason: 'Year-end help' },
    });
    const teacherTry = await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'not_continuing', reason: 'Moving to Lahore' }], w.teacher);
    expect(teacherTry.status).toBe(403);
    expect(errorOf(teacherTry).details).toMatchObject({ capabilities: ['student.status.change'] });

    const ok = await h
      .decide(
        sheet.id,
        [
          { enrolmentId: fail.enrolmentId.toString(), decision: 'promote', reason: 'Passed the re-sit' },
          { enrolmentId: none.enrolmentId.toString(), decision: 'detain', reason: 'Joined late; repeats the class' },
          { enrolmentId: pass.enrolmentId.toString(), decision: 'promote', targetSectionId: w.b6B.id.toString() },
        ],
        w.principal,
      )
      .expect(200);
    const decided = detailOf(ok);
    expect(rowOf(decided, fail)).toMatchObject({ decision: 'promote', proposed: 'detain', reason: 'Passed the re-sit', targetClassId: w.b6.toString(), targetSectionId: w.b6A.id.toString() });
    expect(rowOf(decided, none)).toMatchObject({ decision: 'detain', proposed: null, targetClassId: w.b5.toString() });
    expect(rowOf(decided, pass)).toMatchObject({ decision: 'promote', reason: null, targetSectionId: w.b6B.id.toString() });
    expect(rowOf(decided, pass).decidedByName).not.toBeNull();
    const audit = await db().auditLog.findFirstOrThrow({ where: { schoolId: w.school.id, action: 'promotion_sheet.decided' } });
    expect(audit.metadata).toMatchObject({ decisions: { [fail.enrolmentId.toString()]: { from: 'detain', to: 'promote', reason: 'Passed the re-sit' } } });
  });

  it('R297: apply closes as completed on the year end, opens the target year with no roll number, sets alumni, withdraws not_continuing; once only', async () => {
    const w = await promotionWorld(() => app);
    const { pass, fail, none, leaver, suspended } = await classFive(w);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));

    // An undecided row blocks apply.
    const incomplete = await h.apply(sheet.id, w.principal).expect(409);
    expect(errorOf(incomplete).code).toBe('PROMOTION_INCOMPLETE');
    expect((errorOf(incomplete).details as { enrolmentIds: string[] }).enrolmentIds).toEqual([none.enrolmentId.toString()]);

    await h
      .decide(
        sheet.id,
        [
          { enrolmentId: none.enrolmentId.toString(), decision: 'detain', reason: 'Nothing assessed; repeats' },
          { enrolmentId: leaver.enrolmentId.toString(), decision: 'not_continuing', reason: 'Family moving to Lahore' },
        ],
        w.principal,
      )
      .expect(200);
    const key = newIdempotencyKey();
    const applied = detailOf(await h.apply(sheet.id, w.principal, key).expect(200));
    expect(applied).toMatchObject({ status: 'applied' });
    expect(applied.appliedAt).not.toBeNull();

    const enrolments = await db().enrolment.findMany({ where: { schoolId: w.school.id, studentId: { in: [pass, fail, none, leaver, suspended].map((p) => p.studentId) } } });
    const of = (studentId: bigint) => enrolments.filter((e) => e.studentId === studentId).sort((a, b) => Number(a.id - b.id));
    for (const [p, classId, sectionId] of [
      [pass, w.b6, w.b6A.id],
      [fail, w.b5, w.b5A.id],
      [none, w.b5, w.b5A.id],
      [suspended, w.b6, w.b6A.id],
    ] as const) {
      const [old, next] = of(p.studentId);
      expect(old).toMatchObject({ status: 'completed', endedOn: day(w.yearA.endsOn) });
      expect(next).toMatchObject({ status: 'active', academicYearId: w.yearB.id, classId, sectionId, rollNo: null, startedOn: day(w.yearB.startsOn) });
      expect(rowOf(applied, p).newEnrolmentId).toBe(next?.id.toString());
    }
    // not_continuing: withdrawn on min(today, the year's end) = today, the enrolment left.
    const [left] = of(leaver.studentId);
    expect(left).toMatchObject({ status: 'left', endedOn: day(isoDay(0)) });
    const statuses = await db().student.findMany({ where: { schoolId: w.school.id, id: { in: [leaver.studentId, suspended.studentId, pass.studentId] } } });
    expect(Object.fromEntries(statuses.map((s) => [s.id.toString(), s.status]))).toEqual({
      [leaver.studentId.toString()]: 'withdrawn',
      [suspended.studentId.toString()]: 'suspended',
      [pass.studentId.toString()]: 'active',
    });
    const change = await db().auditLog.findFirstOrThrow({ where: { schoolId: w.school.id, action: 'student.status_changed', subjectId: leaver.studentId } });
    expect(change.metadata).toMatchObject({ from: 'active', to: 'withdrawn', source: 'promotion', enrolmentClosed: true });

    // Once: a second apply is refused; a replay of the same key answers the applied sheet.
    expect(errorOf(await h.apply(sheet.id, w.principal).expect(409)).code).toBe('PROMOTION_SHEET_NOT_OPEN');
    const replay = await h.apply(sheet.id, w.principal, key).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    // Decisions are frozen once applied.
    const late = await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'detain', reason: 'Too late' }], w.principal);
    expect(errorOf(late).code).toBe('PROMOTION_SHEET_NOT_OPEN');
    const audit = await db().auditLog.findFirstOrThrow({ where: { schoolId: w.school.id, action: 'promotion_sheet.applied' } });
    expect(audit.metadata).toMatchObject({ promote: 2, detain: 2, complete: 0, not_continuing: 1, effectiveOn: isoDay(0) });

    // A final class: complete closes the enrolment and makes the student an alumnus (the status
    // route still refuses alumni, R36).
    const senior = await student(w, w.a10A, 'Ali Raza');
    await approvedSheet(w, w.a10A, [[senior, true]]);
    const finalSheet = detailOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(201));
    await h.apply(finalSheet.id, w.principal).expect(200);
    const alumnus = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: senior.studentId } });
    expect(alumnus.status).toBe('alumni');
    const seniorEnrolments = await db().enrolment.findMany({ where: { schoolId: w.school.id, studentId: senior.studentId } });
    expect(seniorEnrolments).toEqual([expect.objectContaining({ status: 'completed', endedOn: day(w.yearA.endsOn) })]);
    const statusRoute = await h.post(`/students/${pass.studentId}/change-status`, { status: 'alumni', effectiveOn: isoDay(0), reason: 'Completed school' }, w.principal);
    expect([statusRoute.status, errorOf(statusRoute).code]).toEqual([409, 'ILLEGAL_STATUS_TRANSITION']);
  });

  it('R298: a target archived since deciding, or a result superseded since reading, is refused until re-decided', async () => {
    const w = await promotionWorld(() => app);
    const { pass, fail, none, sheet: source } = await classFive(w);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    await h.decide(sheet.id, [{ enrolmentId: none.enrolmentId.toString(), decision: 'detain', reason: 'Repeats the class' }], w.principal).expect(200);

    // The pass's final result is corrected (superseded) after the sheet read it.
    const passResult = source.resultIds.get(pass.enrolmentId);
    if (passResult === undefined) throw new Error('no result');
    await supersede(w, passResult);
    const stale = await h.apply(sheet.id, w.principal).expect(409);
    expect(errorOf(stale)).toMatchObject({ code: 'PROMOTION_RESULT_SUPERSEDED', details: { enrolmentIds: [pass.enrolmentId.toString()] } });
    expect(rowOf(detailOf(await h.detail(sheet.id, w.principal).expect(200)), pass).resultSuperseded).toBe(true);
    // Re-deciding re-reads: no live approved result now, so no proposal and the reason is required.
    await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'promote' }], w.principal).expect(422);
    const redecided = detailOf(
      await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'promote', reason: 'Result under correction; promoted' }], w.principal).expect(200),
    );
    expect(rowOf(redecided, pass)).toMatchObject({ resultId: null, proposed: null, resultSuperseded: false });

    // Class 5 of the target year is archived after the fail was detained into it.
    await db().class.updateMany({ where: { schoolId: w.school.id, id: w.b5 }, data: { status: 'archived' } });
    const archived = await h.apply(sheet.id, w.principal).expect(409);
    expect(errorOf(archived)).toMatchObject({ code: 'PROMOTION_TARGET_INVALID', details: { reason: 'archived' } });
    expect([fail.enrolmentId.toString(), none.enrolmentId.toString()]).toContain(
      (errorOf(archived).details as { enrolmentIds: string[] }).enrolmentIds[0],
    );
    // Nothing moved.
    const active = await db().enrolment.count({ where: { schoolId: w.school.id, academicYearId: w.yearB.id } });
    expect(active).toBe(0);
  });

  it('R299: the year closes only when every section with someone in force on its last day has an applied sheet', async () => {
    const w = await promotionWorld(() => app);
    const { pass, fail, none } = await classFive(w);
    // 5-B's only pupil left during the year: nobody in force on the last day, no sheet needed.
    await student(w, w.a5B, 'Gone Early').then((p) =>
      db().enrolment.updateMany({ where: { schoolId: w.school.id, id: p.enrolmentId }, data: { status: 'left', endedOn: day(isoDay(-10)) } }),
    );
    // An archived empty section never blocks either.
    await createSection(db(), w.school, { id: w.a10, academicYearId: w.yearA.id }, { name: 'Z', deletedAt: new Date() });

    const refused = await h.close(w.yearA.id, w.principal).expect(409);
    expect(errorOf(refused)).toMatchObject({
      code: 'PROMOTION_INCOMPLETE',
      details: { sections: [{ sectionId: w.a5A.id.toString(), sectionName: 'A', className: 'Class 5' }] },
    });
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    // An open sheet still blocks.
    expect(errorOf(await h.close(w.yearA.id, w.principal).expect(409)).code).toBe('PROMOTION_INCOMPLETE');
    await h.decide(sheet.id, [{ enrolmentId: none.enrolmentId.toString(), decision: 'detain', reason: 'Repeats the class' }], w.principal).expect(200);
    await h.apply(sheet.id, w.principal).expect(200);
    const closed = await h.close(w.yearA.id, w.principal).expect(200);
    expect((closed.body as { status: string }).status).toBe('closed');
    // The applied rows stand; the new enrolments are in year B.
    expect(await db().enrolment.count({ where: { schoolId: w.school.id, academicYearId: w.yearB.id, studentId: { in: [pass.studentId, fail.studentId, none.studentId] } } })).toBe(3);
  });

  it('§1.1: a result superseded after apply marks the row revised_after_apply; the applied enrolments stand', async () => {
    const w = await promotionWorld(() => app);
    const { pass, none, sheet: source } = await classFive(w);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    await h.decide(sheet.id, [{ enrolmentId: none.enrolmentId.toString(), decision: 'detain', reason: 'Repeats the class' }], w.principal).expect(200);
    const applied = detailOf(await h.apply(sheet.id, w.principal).expect(200));
    expect(rowOf(applied, pass).revisedAfterApply).toBe(false);
    const passResult = source.resultIds.get(pass.enrolmentId);
    if (passResult === undefined) throw new Error('no result');
    await supersede(w, passResult);
    const after = detailOf(await h.detail(sheet.id, w.principal).expect(200));
    expect(rowOf(after, pass)).toMatchObject({ revisedAfterApply: true, decision: 'promote', newEnrolmentId: rowOf(applied, pass).newEnrolmentId });
  });

  it('a sheet or section of another school is 404', async () => {
    const w = await promotionWorld(() => app);
    const other = await promotionWorld(() => app);
    await classFive(w);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    await h.detail(sheet.id, other.principal).expect(404);
    await h.apply(sheet.id, other.principal).expect(404);
    await h.open(w.a5A.id, other.yearB.id, other.principal).expect(404);
    // The office holds no assessment.define.
    await h.detail(sheet.id, w.office).expect(403);
  });
});
