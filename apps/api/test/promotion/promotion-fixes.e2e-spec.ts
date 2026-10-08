// Slice 35 review fixes (contracts/slice-35.md §1, §3, §6; phase-4-academic.md R295, R297,
// R298): apply after the year's end with status changes dated after it; a section-scoped caller
// completing a final class; `complete` only for a final class; the results held still while apply
// runs; and cancelling an open sheet.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { createTestApp } from '../core/app';
import { db } from '../fees/charges-support';
import { closeTestDb } from '../support/schools';
import { createTeacherAssignment, day, isoDay } from '../support/students';
import {
  approvedSheet,
  detailOf,
  promotionHttp,
  promotionWorld,
  rowOf,
  student,
  type PromotionWorld,
} from './support';

interface ErrorBody {
  error: { code: string; details: Record<string, unknown> | null; fields?: { field: string }[] };
}
const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

describe('slice 35 review fixes (e2e)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const changeStatus = (w: PromotionWorld, studentId: bigint, status: string, effectiveOn: string) =>
    h.post(`/students/${studentId}/change-status`, { status, effectiveOn, reason: 'Office record' }, w.principal);

  it('contracts/slice-35.md §3: after the year ended, a status change dated after its end moves the date forward instead of dead-ending apply', async () => {
    // Year A ended ten days ago; B began nine days ago.
    const w = await promotionWorld(() => app, { yearAEndsIn: -10 });
    const suspended = await student(w, w.a10A, 'Ayesha Noor');
    const leaver = await student(w, w.a10A, 'Kamran Ali');
    const plain = await student(w, w.a10A, 'Sana Iqbal');
    await approvedSheet(w, w.a10A, [
      [suspended, true],
      [leaver, true],
      [plain, true],
    ]);
    // After the year's end: one suspended five days ago, one suspended and back since four days ago.
    expect((await changeStatus(w, suspended.studentId, 'suspended', isoDay(-5))).status).toBe(200);
    expect((await changeStatus(w, leaver.studentId, 'suspended', isoDay(-6))).status).toBe(200);
    expect((await changeStatus(w, leaver.studentId, 'active', isoDay(-4))).status).toBe(200);
    const sheet = detailOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(201));
    await h
      .decide(sheet.id, [{ enrolmentId: leaver.enrolmentId.toString(), decision: 'not_continuing', reason: 'Joining a college' }], w.principal)
      .expect(200);
    const applied = await h.apply(sheet.id, w.principal);
    expect(applied.status).toBe(200);

    const changes = await db().studentStatusChange.findMany({
      where: { schoolId: w.school.id, studentId: { in: [suspended.studentId, leaver.studentId, plain.studentId] }, toStatus: { in: ['alumni', 'withdrawn'] } },
    });
    const on = (studentId: bigint) => changes.find((c) => c.studentId === studentId);
    // Raised to the last change; the plain completion stays on the year's end.
    expect(on(suspended.studentId)).toMatchObject({ fromStatus: 'suspended', toStatus: 'alumni', effectiveOn: day(isoDay(-5)) });
    expect(on(leaver.studentId)).toMatchObject({ toStatus: 'withdrawn', effectiveOn: day(isoDay(-4)) });
    expect(on(plain.studentId)).toMatchObject({ toStatus: 'alumni', effectiveOn: day(w.yearA.endsOn) });
    const left = await db().enrolment.findFirstOrThrow({ where: { schoolId: w.school.id, id: leaver.enrolmentId } });
    expect(left).toMatchObject({ status: 'left', endedOn: day(isoDay(-4)) });
    const completed = await db().enrolment.findFirstOrThrow({ where: { schoolId: w.school.id, id: suspended.enrolmentId } });
    expect(completed).toMatchObject({ status: 'completed', endedOn: day(w.yearA.endsOn) });
  });

  it('contracts/slice-35.md §3: an enrolment that starts after the year’s end is refused by name, not by a dates check', async () => {
    const w = await promotionWorld(() => app, { yearAEndsIn: -10 });
    const early = await student(w, w.a5A, 'Hamza Tariq');
    // Recorded into year A after it ended (a late admission in the wrong year).
    const late = await student(w, w.a5A, 'Hira Tariq');
    await db().enrolment.updateMany({ where: { schoolId: w.school.id, id: late.enrolmentId }, data: { startedOn: day(isoDay(-3)) } });
    await approvedSheet(w, w.a5A, [
      [early, true],
      [late, true],
    ]);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const refused = await h.apply(sheet.id, w.principal);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: 'PROMOTION_ENROLMENT_AFTER_YEAR',
      details: { enrolmentIds: [late.enrolmentId.toString()] },
    });
    // Nothing written.
    const rows = await db().enrolment.findMany({ where: { schoolId: w.school.id, studentId: { in: [early.studentId, late.studentId] } } });
    expect(rows.every((e) => e.status === 'active')).toBe(true);
  });

  it('R297: a section-scoped caller (a class teacher granted assessment.define) applies a final class: completions reach alumni', async () => {
    const w = await promotionWorld(() => app);
    await createTeacherAssignment(db(), w.school, w.teacher.user, { role: 'class_teacher', section: w.a10A, startsOn: w.yearA.startsOn });
    await db().userCapabilityGrant.create({
      data: { schoolId: w.school.id, userId: w.teacher.user.userId, capabilityKey: 'assessment.define', effect: 'grant', grantedBy: w.principal.user.userId, reason: 'Year-end help' },
    });
    const senior = await student(w, w.a10A, 'Ali Raza');
    const second = await student(w, w.a10A, 'Usman Ali');
    await approvedSheet(w, w.a10A, [
      [senior, true],
      [second, true],
    ]);
    const sheet = detailOf(await h.open(w.a10A.id, w.yearB.id, w.teacher).expect(201));
    expect(rowOf(sheet, senior).decision).toBe('complete');
    const applied = await h.apply(sheet.id, w.teacher);
    expect(applied.status).toBe(200);
    const alumnus = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: senior.studentId } });
    expect(alumnus.status).toBe('alumni');
    expect(rowOf(detailOf(applied), senior).appliedAt).not.toBeNull();
  });

  it('R295: only a final class completes — refused on the decision, and re-checked at apply', async () => {
    const w = await promotionWorld(() => app);
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    await approvedSheet(w, w.a5A, [[pass, true]]);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const refused = await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'complete', reason: 'Leaving after class 5' }], w.principal);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('decisions[0].decision');

    // A final class whose flag is lifted after deciding: apply refuses the completion.
    const senior = await student(w, w.a10A, 'Ali Raza');
    await approvedSheet(w, w.a10A, [[senior, true]]);
    const finalSheet = detailOf(await h.open(w.a10A.id, w.yearB.id, w.principal).expect(201));
    await db().class.updateMany({ where: { schoolId: w.school.id, id: w.a10 }, data: { isFinal: false } });
    const late = await h.apply(finalSheet.id, w.principal);
    expect(late.status).toBe(409);
    expect(errorOf(late)).toMatchObject({
      code: 'PROMOTION_TARGET_INVALID',
      details: { reason: 'not_final', enrolmentIds: [senior.enrolmentId.toString()] },
    });
  });

  it('R298: apply holds the rows’ results still — a correction under way when apply starts makes it refuse', async () => {
    const w = await promotionWorld(() => app);
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    const { resultIds } = await approvedSheet(w, w.a5A, [[pass, true]]);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      // A correction superseding the result, not yet committed.
      await pg.query('BEGIN');
      await pg.query('UPDATE results SET superseded_at = now() WHERE school_id = $1 AND id = $2', [w.school.id, resultIds.get(pass.enrolmentId)]);
      const racing = h.apply(sheet.id, w.principal).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await pg.query('COMMIT');
      const res = await racing;
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'PROMOTION_RESULT_SUPERSEDED', details: { enrolmentIds: [pass.enrolmentId.toString()] } });
    } finally {
      await pg.end();
    }
    expect(detailOf(await h.detail(sheet.id, w.principal).expect(200)).status).toBe('open');
  });

  it('contracts/slice-35.md §1: the principal cancels an open sheet with a reason; its rows stay; the section opens another', async () => {
    const w = await promotionWorld(() => app);
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    await approvedSheet(w, w.a5A, [[pass, true]]);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const cancel = (by: typeof w.principal, body: object) => h.post(`/promotion-sheets/${sheet.id}/cancel`, body, by);

    // Only a principal: a teacher granted assessment.define is refused.
    await db().userCapabilityGrant.create({
      data: { schoolId: w.school.id, userId: w.teacher.user.userId, capabilityKey: 'assessment.define', effect: 'grant', grantedBy: w.principal.user.userId, reason: 'Year-end help' },
    });
    const teacher = await cancel(w.teacher, { reason: 'Wrong year' });
    expect(teacher.status).toBe(403);
    expect(errorOf(teacher).details).toMatchObject({ reason: 'principal_required' });
    expect((await cancel(w.principal, {})).status).toBe(422);

    const done = await cancel(w.principal, { reason: 'Opened into the wrong year' });
    expect(done.status).toBe(200);
    expect(detailOf(done)).toMatchObject({ status: 'cancelled', rows: 1 });
    const audit = await db().auditLog.findFirstOrThrow({ where: { schoolId: w.school.id, action: 'promotion_sheet.cancelled' } });
    expect(audit).toMatchObject({ reason: 'Opened into the wrong year', subjectId: BigInt(sheet.id) });

    // Closed to every verb; a second cancel too.
    expect(errorOf(await cancel(w.principal, { reason: 'Again' })).code).toBe('PROMOTION_SHEET_NOT_OPEN');
    expect(errorOf(await h.apply(sheet.id, w.principal)).code).toBe('PROMOTION_SHEET_NOT_OPEN');
    const decided = await h.decide(sheet.id, [{ enrolmentId: pass.enrolmentId.toString(), decision: 'detain', reason: 'x x x' }], w.principal);
    expect(errorOf(decided).code).toBe('PROMOTION_SHEET_NOT_OPEN');
    // The section's slot is free: a new sheet opens and applies; the year-close guard still wants it applied.
    const again = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    expect(again.id).not.toBe(sheet.id);
    const list = await h.get(`/promotion-sheets?sectionId=${w.a5A.id}&status=cancelled`, w.principal);
    expect((list.body as { data: { id: string }[] }).data.map((s) => s.id)).toEqual([sheet.id]);
  });

  it('slice 36 (security L2): a decision other than the proposal for the decider’s own child is refused unless sole principal (selfApproved); own-child rows are flagged', async () => {
    const w = await promotionWorld(() => app);
    const mine = await student(w, w.a5A, 'Usman Principal');
    const other = await student(w, w.a5A, 'Nida Rauf');
    // approvedSheet adds a second principal (its decider): the principal is not the sole one.
    await approvedSheet(w, w.a5A, [
      [mine, true],
      [other, false],
    ]);
    await h.parentOf(w, w.principal.user, mine);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    const decide = (decision: string, reason?: string) =>
      h.decide(sheet.id, [{ enrolmentId: mine.enrolmentId.toString(), decision, ...(reason ? { reason } : {}) }], w.principal);

    // The proposal itself stands: allowed, flagged.
    await decide('promote').expect(200);
    const [agreed] = await h.audit(w.school, 'promotion_sheet.decided');
    expect(agreed?.metadata).toEqual({
      decisions: { [mine.enrolmentId.toString()]: expect.objectContaining({ to: 'promote', ownChild: 'true' }) },
    });
    // Differing from it is refused; another child's row is unaffected.
    const refused = await decide('detain', 'Not ready for Class 6');
    expect([refused.status, errorOf(refused).code, errorOf(refused).details]).toEqual([409, 'SELF_ACTION_FORBIDDEN', { reason: 'own_child' }]);
    expect(rowOf(detailOf(await h.detail(sheet.id, w.principal).expect(200)), mine).decision).toBe('promote');
    const others = await h.decide(sheet.id, [{ enrolmentId: other.enrolmentId.toString(), decision: 'promote', reason: 'Passed the re-test' }], w.principal);
    expect(others.status).toBe(200);

    // The other principal leaves: the sole principal may, recorded selfApproved.
    await db().userRole.updateMany({
      where: { schoolId: w.school.id, systemRole: 'principal', userId: { not: w.principal.user.userId }, endedAt: null },
      data: { endedAt: new Date(), endedBy: w.principal.user.userId },
    });
    await decide('detain', 'Not ready for Class 6').expect(200);
    const audits = await h.audit(w.school, 'promotion_sheet.decided');
    expect(audits.at(-1)?.metadata).toEqual({
      decisions: { [mine.enrolmentId.toString()]: expect.objectContaining({ to: 'detain', ownChild: 'true' }) },
      selfApproved: true,
    });
    expect(audits[1]?.metadata).toEqual({
      decisions: { [other.enrolmentId.toString()]: expect.not.objectContaining({ ownChild: expect.anything() }) },
    });
  });
});
