// Slice 19 over HTTP (phase-3-financial.md slice 19): charges (R186), late-fee waivers (R185),
// adjustments up to what is owed, concessions (R182, R183, A6), the own-child refusal with the
// sole-principal exception (R232, R253), the principal gate (R233), statements (R205), the
// requested monthly run through a real queue (R179), campaigns (R184), the admission and
// readmission fee (R239), closed years (R242) and teachers (R234). The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { JobRunner } from '../../src/jobs/job-runner';
import { chargeRunJobId, JOB, QUEUE } from '../../src/messaging/queues';
import { createTestApp, queuedJob } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createGuardian, day, isoDay, type TestAcademicYear, type TestSection } from '../support/students';
import {
  classWithSection,
  db,
  financeSchool,
  lateFees,
  karachi,
  pupil,
  runMonth,
  session2026,
  structure,
  type FinanceHeads,
  type Pupil,
} from './charges-support';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

interface ErrorBody {
  error: { code: string; details: Record<string, unknown> & { fields?: { path: string; code: string }[] } };
}
interface Charge {
  id: string;
  kind: string;
  status: string;
  amount: number;
  grossAmount: number;
  concessionAmount: number;
  creditedAmount: number;
  outstanding: number;
  adjustsChargeId: string | null;
  lateFeeForChargeId: string | null;
  concessionId: string | null;
  feeHeadId: string;
  studentName: string;
  className: string;
}
interface Run {
  id: string;
  status: string;
  kind: string;
  period: string;
  chargesInserted: number;
  campaignId: string | null;
}
interface Concession {
  id: string;
  status: string;
  selfApproved: boolean;
  heads: { feeHeadId: string }[];
}

type Session = TestSchoolSession & { user: TestSchoolUser };

describe('slice 19: charges, concessions, campaigns over HTTP (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const signIn = async (school: TestSchool, systemRole: SystemRole): Promise<Session> => {
    const user = await createSchoolUser(db(), school, { systemRole });
    return { ...(await createSchoolSession(db(), school, user)), user };
  };
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const send = (method: 'post' | 'patch', path: string, body: object, s: { cookie: string }, key?: string) => {
    const req = http()[method](`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const post = (path: string, body: object, s: { cookie: string }, key?: string) => send('post', path, body, s, key);
  const err = (res: request.Response) => res.body as ErrorBody;
  const audit = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  interface World {
    school: TestSchool;
    heads: FinanceHeads;
    year: TestAcademicYear;
    classId: bigint;
    section: TestSection;
    principal: Session;
    office: Session;
    teacher: Session;
    child: Pupil;
  }

  /** A priced class (tuition 3,000, annual 5,000, admission 10,000), a child, three signed-in roles. */
  async function world(): Promise<World> {
    const fs = await financeSchool();
    const principal = await signIn(fs.school, 'principal');
    const office = await signIn(fs.school, 'office_staff');
    const teacher = await signIn(fs.school, 'teacher');
    const year = await session2026(fs.school);
    const { classId, section } = await classWithSection(fs.school, year);
    for (const [feeHeadId, amount] of [
      [fs.heads.tuition, 3000],
      [fs.heads.annual, 5000],
      [fs.heads.admission, 10000],
    ] as const) {
      await structure(fs.school, { academicYearId: year.id, classId, feeHeadId, amount, effectiveFrom: '2026-04' }, principal.user.userId);
    }
    const child = await pupil(fs.school, section, { startedOn: '2026-04-01', fullName: 'Hamza Tariq' });
    return { ...fs, year, classId, section, principal, office, teacher, child };
  }

  /** October's generated charges for the world's child. */
  async function october(w: World): Promise<Charge[]> {
    await runMonth(app, w.school, w.year, '2026-10', karachi('2026-10-01'));
    const res = await get(`/charges?studentId=${w.child.studentId}&sort=dueOn`, w.office).expect(200);
    return (res.body as { data: Charge[] }).data;
  }

  /** Makes `user` a guardian of `child` (R232's own child). */
  async function parentOf(w: World, user: TestSchoolUser, child: Pupil): Promise<void> {
    await db().user.updateMany({ where: { schoolId: w.school.id, id: user.userId }, data: { guardianId: child.guardianId } });
  }

  // ------------------------------------------------------------------------- R234

  it('R234: a teacher reaches no slice-19 route', async () => {
    const w = await world();
    const reads = ['/charges', '/charges/1', '/charges/generation-runs', '/concessions', '/charge-campaigns', `/students/${w.child.studentId}/fee-statement`];
    for (const path of reads) expect((await get(path, w.teacher)).status).toBe(403);
    const writes: [string, object][] = [
      ['/charges', {}],
      ['/charges/generate-month', {}],
      ['/charges/1/void', {}],
      ['/charges/1/waive', {}],
      ['/charges/1/adjust', {}],
      ['/concessions', {}],
      ['/concessions/1/approve', {}],
      ['/charge-campaigns', {}],
      ['/charge-campaigns/preview-targets', {}],
    ];
    for (const [path, body] of writes) expect((await post(path, body, w.teacher, newIdempotencyKey())).status).toBe(403);
  });

  // ------------------------------------------------------------------------- charges

  it('R186: the office raises a manual charge (replayed once), voids it; a generated charge is the principal\'s to void, with its open late fee', async () => {
    const w = await world();
    const key = newIdempotencyKey();
    const body = { enrolmentId: w.child.enrolmentId.toString(), feeHeadId: w.heads.exam.toString(), amount: 750, dueOn: isoDay(3), description: 'Science lab breakage' };
    const created = await post('/charges', body, w.office, key).expect(201);
    const manual = created.body as Charge;
    expect([manual.kind, manual.amount, manual.status, manual.outstanding, manual.studentName]).toEqual(['manual', 750, 'open', 750, 'Hamza Tariq']);
    const replay = await post('/charges', body, w.office, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as Charge).id]).toEqual(['true', manual.id]);
    expect((await audit(w.school, 'charge.created')).length).toBe(1);
    // A due date in the past, an archived head.
    expect((await post('/charges', { ...body, dueOn: isoDay(-1) }, w.office, newIdempotencyKey())).status).toBe(422);

    await post(`/charges/${manual.id}/void`, { reason: 'Raised in error' }, w.office).expect(200);
    const again = await post(`/charges/${manual.id}/void`, { reason: 'Raised in error' }, w.office);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.CHARGE_NOT_OPEN]);

    // Generated: the office has no concession.grant; a principal voids it and its late fee.
    const [tuition] = (await october(w)).filter((c) => c.feeHeadId === w.heads.tuition.toString());
    if (!tuition) throw new Error('no tuition');
    await db().schoolSettings.updateMany({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi('2026-09-01') },
    });
    expect(await lateFees(app, w.school, karachi('2026-10-20'))).toBe(1);
    expect((await post(`/charges/${tuition.id}/void`, { reason: 'Wrong amount' }, w.office)).status).toBe(403);
    const voided = await post(`/charges/${tuition.id}/void`, { reason: 'Wrong amount' }, w.principal).expect(200);
    expect((voided.body as Charge).status).toBe('voided');
    const fee = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, kind: 'late_fee' } });
    expect([fee.status, fee.voidReason]).toEqual(['voided', 'Wrong amount']);
    const rows = await audit(w.school, 'charge.voided');
    expect(rows.map((r) => [r.actorUserId, r.reason])).toEqual([
      [w.office.user.userId, 'Raised in error'],
      [w.principal.user.userId, 'Wrong amount'],
    ]);
  });

  it('R185: only a principal waives, only a late fee, only while open', async () => {
    const w = await world();
    const [tuition] = (await october(w)).filter((c) => c.feeHeadId === w.heads.tuition.toString());
    await db().schoolSettings.updateMany({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi('2026-09-01') },
    });
    await lateFees(app, w.school, karachi('2026-10-20'));
    const fee = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, kind: 'late_fee' } });
    const notLate = await post(`/charges/${tuition?.id}/waive`, { reason: 'Hardship' }, w.principal);
    expect([notLate.status, err(notLate).error.code]).toEqual([409, ErrorCode.CHARGE_NOT_LATE_FEE]);
    expect((await post(`/charges/${fee.id}/waive`, { reason: 'Hardship' }, w.office)).status).toBe(403);
    const waived = await post(`/charges/${fee.id}/waive`, { reason: 'Paid at the bank in time' }, w.principal).expect(200);
    expect([(waived.body as Charge).status, (waived.body as Charge).lateFeeForChargeId]).toEqual(['waived', tuition?.id]);
    const twice = await post(`/charges/${fee.id}/waive`, { reason: 'Again' }, w.principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.CHARGE_NOT_OPEN]);
    expect((await audit(w.school, 'charge.waived')).map((r) => r.reason)).toEqual(['Paid at the bank in time']);
  });

  it('R186: an adjustment is its own settled row raising credited_amount; beyond what is owed, with nothing paid to de-allocate, is refused', async () => {
    const w = await world();
    const [tuition] = (await october(w)).filter((c) => c.feeHeadId === w.heads.tuition.toString());
    const key = newIdempotencyKey();
    const partial = await post(`/charges/${tuition?.id}/adjust`, { amount: 1000, reason: 'Sibling discount agreed' }, w.principal, key).expect(201);
    expect([(partial.body as Charge).kind, (partial.body as Charge).status, (partial.body as Charge).adjustsChargeId]).toEqual(['adjustment', 'settled', tuition?.id]);
    const replay = await post(`/charges/${tuition?.id}/adjust`, { amount: 1000, reason: 'Sibling discount agreed' }, w.principal, key).expect(200);
    expect((replay.body as Charge).id).toBe((partial.body as Charge).id);
    const after = (await get(`/charges/${tuition?.id}`, w.office).expect(200)).body as Charge;
    expect([after.creditedAmount, after.outstanding, after.status]).toEqual([1000, 2000, 'open']);
    // A charge carrying a credit is not voided: the credit would point at nothing owed.
    const credited = await post(`/charges/${tuition?.id}/void`, { reason: 'Wrong amount' }, w.principal);
    expect([credited.status, err(credited).error.code, err(credited).error.details.reason]).toEqual([409, ErrorCode.CHARGE_HAS_ALLOCATIONS, 'has_credits']);
    const beyond = await post(`/charges/${tuition?.id}/adjust`, { amount: 2001, reason: 'Too much' }, w.principal, newIdempotencyKey());
    expect([beyond.status, err(beyond).error.code, err(beyond).error.details.reason, err(beyond).error.details.outstanding]).toEqual([
      409, ErrorCode.CHARGE_NOT_OPEN, 'exceeds_outstanding', 2000,
    ]);
    await post(`/charges/${tuition?.id}/adjust`, { amount: 2000, reason: 'Rest forgiven' }, w.principal, newIdempotencyKey()).expect(201);
    const settled = (await get(`/charges/${tuition?.id}`, w.office).expect(200)).body as Charge;
    expect([settled.status, settled.outstanding]).toEqual(['settled', 0]);
    const closed = await post(`/charges/${tuition?.id}/adjust`, { amount: 1, reason: 'More' }, w.principal, newIdempotencyKey());
    expect([closed.status, err(closed).error.code]).toEqual([409, ErrorCode.CHARGE_NOT_OPEN]);
    // The office holds no concession.grant; a principal-by-grant would still fail requirePrincipal.
    expect((await post(`/charges/${tuition?.id}/adjust`, { amount: 1, reason: 'Office' }, w.office, newIdempotencyKey())).status).toBe(403);
    expect((await audit(w.school, 'charge.adjusted')).map((r) => r.actorUserId)).toEqual([w.principal.user.userId, w.principal.user.userId]);
  });

  it('R232, R253: nobody voids, waives or adjusts their own child\'s charge; a sole principal may, recorded selfApproved; a second principal ends it', async () => {
    const w = await world();
    await october(w);
    // An office clerk who is the child's parent: their manual charge for the child cannot be voided by them.
    await parentOf(w, w.office.user, w.child);
    const manual = await post(
      '/charges',
      { enrolmentId: w.child.enrolmentId.toString(), feeHeadId: w.heads.exam.toString(), amount: 100, dueOn: isoDay(2), description: 'Trip' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    const own = await post(`/charges/${(manual.body as Charge).id}/void`, { reason: 'Mine' }, w.office);
    expect([own.status, err(own).error.code, err(own).error.details.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'own_child']);

    // The sole principal, parent of another child: allowed, audited selfApproved.
    const mine = await pupil(w.school, w.section, { startedOn: '2026-04-01' });
    await parentOf(w, w.principal.user, mine);
    await runMonth(app, w.school, w.year, '2026-10', karachi('2026-10-02'));
    const [mineTuition, mineAnnual] = await db().charge.findMany({ where: { schoolId: w.school.id, studentId: mine.studentId }, orderBy: { id: 'asc' } });
    await post(`/charges/${mineTuition?.id}/adjust`, { amount: 100, reason: 'Own child, sole principal' }, w.principal, newIdempotencyKey()).expect(201);
    expect((await audit(w.school, 'charge.adjusted'))[0]?.metadata).toMatchObject({ selfApproved: true });
    // A second principal: the exception ends.
    await signIn(w.school, 'principal');
    const refused = await post(`/charges/${mineAnnual?.id}/void`, { reason: 'Mine' }, w.principal);
    expect([refused.status, err(refused).error.details.reason]).toEqual([409, 'own_child']);
  });

  it('R205: the statement shows both dates and separate lines; charged − concession − credits − paid = outstanding', async () => {
    const w = await world();
    const [tuition] = (await october(w)).filter((c) => c.feeHeadId === w.heads.tuition.toString());
    await post(`/charges/${tuition?.id}/adjust`, { amount: 500, reason: 'Goodwill' }, w.principal, newIdempotencyKey()).expect(201);
    const res = await get(`/students/${w.child.studentId}/fee-statement`, w.office).expect(200);
    const statement = res.body as {
      academicYearId: string;
      charges: { data: (Charge & { dueOn: string; createdAt: string })[]; total: number };
      adjustments: Charge[];
      payments: unknown[];
      totals: { charged: number; concession: number; adjustments: number; paid: number; outstanding: number; advance: number };
    };
    expect(statement.academicYearId).toBe(w.year.id.toString());
    expect(statement.charges.total).toBe(2);
    expect(statement.charges.data.every((c) => c.dueOn !== undefined && c.createdAt !== undefined)).toBe(true);
    expect(statement.adjustments.map((a) => a.amount)).toEqual([500]);
    expect(statement.totals).toEqual({ charged: 8000, concession: 0, adjustments: 500, paid: 0, outstanding: 7500, advance: 0 });
    const t = statement.totals;
    expect(t.charged - t.concession - t.adjustments - t.paid).toBe(t.outstanding);
    expect((await get('/students/999999999/fee-statement', w.office)).status).toBe(404);
  });

  // ------------------------------------------------------------------------- concessions

  it('R183: the office requests, principals are told; a principal approves and credits the open charges (A6); one live per head', async () => {
    const w = await world();
    const charges = await october(w);
    const tuition = charges.find((c) => c.feeHeadId === w.heads.tuition.toString());
    const body = {
      studentId: w.child.studentId.toString(),
      academicYearId: w.year.id.toString(),
      kind: 'percentage',
      value: 50,
      feeHeadIds: [w.heads.tuition.toString()],
      effectiveFrom: '2026-10',
      reason: 'Father lost his job',
    };
    const requested = await post('/concessions', body, w.office, newIdempotencyKey()).expect(201);
    const concession = requested.body as Concession;
    expect(concession.status).toBe('requested');
    const told = await db().message.findMany({ where: { schoolId: w.school.id, type: 'concession_requested' } });
    expect(told.map((m) => m.staffId)).toEqual([w.principal.user.staffId]);
    // One live per student, year and head.
    const second = await post('/concessions', body, w.office, newIdempotencyKey());
    expect([second.status, err(second).error.code, err(second).error.details.concessionId]).toEqual([409, ErrorCode.CONCESSION_EXISTS, concession.id]);
    // A fine is never concession-eligible.
    const fine = await post('/concessions', { ...body, feeHeadIds: [w.heads.fine.toString()] }, w.office, newIdempotencyKey());
    expect([fine.status, err(fine).error.code]).toEqual([409, ErrorCode.CONCESSION_HEAD_NOT_ELIGIBLE]);
    // The office cannot decide.
    expect((await post(`/concessions/${concession.id}/approve`, {}, w.office)).status).toBe(403);

    const approved = await post(`/concessions/${concession.id}/approve`, { applyToOpenCharges: true }, w.principal).expect(200);
    const decision = approved.body as { concession: Concession; adjustments: Charge[] };
    expect(decision.concession.status).toBe('approved');
    expect(decision.adjustments.map((a) => [a.amount, a.adjustsChargeId, a.kind])).toEqual([[1500, tuition?.id, 'adjustment']]);
    const decided = await db().message.findMany({ where: { schoolId: w.school.id, type: 'concession_decided' } });
    expect(decided.map((m) => m.staffId)).toEqual([w.office.user.staffId]);
    expect((await audit(w.school, 'concession.approved')).map((r) => [r.actorUserId, r.metadata])).toEqual([
      [w.principal.user.userId, expect.objectContaining({ appliedToOpenCharges: 1, creditedAmount: 1500, selfApproved: false })],
    ]);
    const again = await post(`/concessions/${concession.id}/approve`, {}, w.principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.CONCESSION_NOT_PENDING]);

    // November's generation applies it (R182); ending affects future charges only.
    await runMonth(app, w.school, w.year, '2026-11', karachi('2026-11-01'));
    const nov = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, studentId: w.child.studentId, period: '2026-11', kind: 'generated' } });
    expect([nov.grossAmount, nov.concessionAmount, nov.amount]).toEqual([3000, 1500, 1500]);
    await post(`/concessions/${concession.id}/end`, { reason: 'Back at work' }, w.principal).expect(200);
    await runMonth(app, w.school, w.year, '2026-12', karachi('2026-12-01'));
    const dec = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, studentId: w.child.studentId, period: '2026-12', kind: 'generated' } });
    expect(dec.concessionAmount).toBe(0);
    expect((await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: nov.id } })).amount).toBe(1500);
    expect((await audit(w.school, 'concession.ended')).length).toBe(1);
  });

  it('R183: a principal holding both keys creates it approved (directApproval); a rejection needs a reason; concurrent requests make one', async () => {
    const w = await world();
    const body = (head: bigint) => ({
      studentId: w.child.studentId.toString(),
      academicYearId: w.year.id.toString(),
      kind: 'fixed',
      value: 1000,
      feeHeadIds: [head.toString()],
      effectiveFrom: '2026-10',
      reason: 'Staff child',
    });
    const direct = await post('/concessions', body(w.heads.tuition), w.principal, newIdempotencyKey()).expect(201);
    expect([(direct.body as Concession).status, (direct.body as Concession).selfApproved]).toEqual(['approved', false]);
    expect((await audit(w.school, 'concession.created'))[0]?.metadata).toMatchObject({ directApproval: true });

    const [a, b] = await Promise.all([
      post('/concessions', body(w.heads.annual), w.office, newIdempotencyKey()),
      post('/concessions', body(w.heads.annual), w.office, newIdempotencyKey()),
    ]);
    expect([a?.status, b?.status].sort()).toEqual([201, 409]);
    const live = (a?.status === 201 ? a : b)?.body as Concession;
    expect((await post(`/concessions/${live.id}/reject`, {}, w.principal)).status).toBe(422);
    const rejected = await post(`/concessions/${live.id}/reject`, { reason: 'Not eligible' }, w.principal).expect(200);
    expect((rejected.body as Concession).status).toBe('rejected');
    expect((await audit(w.school, 'concession.rejected')).map((r) => r.reason)).toEqual(['Not eligible']);
    // A rejected one frees the head for a new request.
    await post('/concessions', body(w.heads.annual), w.office, newIdempotencyKey()).expect(201);
  });

  it('R232, R253: nobody approves a concession for their own child unless sole principal (selfApproved)', async () => {
    const w = await world();
    await parentOf(w, w.principal.user, w.child);
    const req = await post(
      '/concessions',
      { studentId: w.child.studentId.toString(), academicYearId: w.year.id.toString(), kind: 'percentage', value: 25, feeHeadIds: [w.heads.tuition.toString()], effectiveFrom: '2026-10', reason: 'Own child' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    const second = await signIn(w.school, 'principal');
    const refused = await post(`/concessions/${(req.body as Concession).id}/approve`, {}, w.principal);
    expect([refused.status, err(refused).error.details.reason]).toEqual([409, 'own_child']);
    // The second principal is not the parent: they approve.
    const ok = await post(`/concessions/${(req.body as Concession).id}/approve`, {}, second).expect(200);
    expect((ok.body as { concession: Concession }).concession.selfApproved).toBe(false);
  });

  it('R242: a closed year refuses concessions, generation and manual charges', async () => {
    const w = await world();
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: w.year.id }, data: { status: 'closed' } });
    const concession = await post(
      '/concessions',
      { studentId: w.child.studentId.toString(), academicYearId: w.year.id.toString(), kind: 'percentage', value: 25, feeHeadIds: [w.heads.tuition.toString()], effectiveFrom: '2026-10', reason: 'Late request' },
      w.office,
      newIdempotencyKey(),
    );
    expect([concession.status, err(concession).error.code]).toEqual([409, ErrorCode.ACADEMIC_YEAR_CLOSED]);
    const month = await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2026-10' }, w.office);
    expect([month.status, err(month).error.code, err(month).error.details.reason]).toEqual([409, ErrorCode.MONTH_NOT_GENERATABLE, 'year_closed']);
    const manual = await post(
      '/charges',
      { enrolmentId: w.child.enrolmentId.toString(), feeHeadId: w.heads.exam.toString(), amount: 100, dueOn: isoDay(2), description: 'Trip' },
      w.office,
      newIdempotencyKey(),
    );
    expect([manual.status, err(manual).error.code]).toEqual([409, ErrorCode.ACADEMIC_YEAR_CLOSED]);
  });

  // ------------------------------------------------------------------------- generation

  it('R179: generate-month queues a run on a real queue; the job runs it; a second request answers the same run; structure writes wait', async () => {
    const w = await world();
    {
      const future = await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2027-02' }, w.office);
      expect([future.status, err(future).error.details.reason]).toEqual([409, 'future']);
      const outside = await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2026-03' }, w.office);
      expect([outside.status, err(outside).error.details.reason]).toEqual([409, 'outside_year']);
      // regenerateVoided is the principal's.
      expect((await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2026-10', regenerateVoided: true }, w.office)).status).toBe(403);

      const queued = await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2026-10' }, w.office).expect(201);
      const run = queued.body as Run;
      expect([run.status, run.kind, run.period]).toEqual(['queued', 'monthly', '2026-10']);
      const same = await post('/charges/generate-month', { academicYearId: w.year.id.toString(), period: '2026-10' }, w.office).expect(200);
      expect((same.body as Run).id).toBe(run.id);
      // CHARGE_RUN_IN_PROGRESS: a structure write for the year waits for the run.
      const busy = await post(
        '/fee-structures',
        { academicYearId: w.year.id.toString(), classId: w.classId.toString(), feeHeadId: w.heads.tuition.toString(), amount: 3500, effectiveFrom: '2026-11' },
        w.principal,
        newIdempotencyKey(),
      );
      expect([busy.status, err(busy).error.code, err(busy).error.details.runId]).toEqual([409, ErrorCode.CHARGE_RUN_IN_PROGRESS, run.id]);

      // The job, as enqueued after commit, read back from the queue and run by the runner.
      const job = await queuedJob(app, QUEUE.messaging, chargeRunJobId(BigInt(run.id)));
      expect([job?.name, job?.data]).toEqual([JOB.chargeRun, { schoolId: w.school.id.toString(), runId: run.id }]);
      const runner = app.get(JobRunner, { strict: false });
      expect(await runner.messaging(job?.name ?? '', job?.data)).toBe('done');
      // A replayed job finds the run claimed (R105).
      expect(await runner.messaging(job?.name ?? '', job?.data)).toBe('done');
      const done = (await get(`/charges/generation-runs/${run.id}`, w.office).expect(200)).body as Run;
      expect([done.status, done.chargesInserted]).toEqual(['done', 2]);
      const list = (await get(`/charges/generation-runs?academicYearId=${w.year.id}`, w.office).expect(200)).body as { data: Run[] };
      expect(list.data.map((r) => r.id)).toEqual([run.id]);
      expect((await audit(w.school, 'charge_run.requested')).length).toBe(1);
      expect((await audit(w.school, 'charge_run.completed')).map((r) => r.actorUserId)).toEqual([w.office.user.userId]);
    }
  });

  // ------------------------------------------------------------------------- campaigns

  it('R184: a campaign is composed, previewed, generated once by its job, and cancelling voids nothing', async () => {
    const w = await world();
    const second = await pupil(w.school, w.section, { startedOn: '2026-04-01' });
    const other = await classWithSection(w.school, w.year);
    const outsider = await pupil(w.school, other.section, { startedOn: '2026-04-01' });
    // A 50% exam concession for the second child, applied because the campaign asks.
    const concession = await db().concession.create({
      data: {
        schoolId: w.school.id, studentId: second.studentId, academicYearId: w.year.id, enrolmentId: second.enrolmentId,
        kind: 'percentage', value: 50, effectiveFrom: '2026-04', reason: 'Merit', requestedBy: w.principal.user.userId,
        status: 'approved', decidedBy: w.principal.user.userId, decidedAt: new Date(),
      },
    });
    await db().concessionHead.create({ data: { schoolId: w.school.id, concessionId: concession.id, feeHeadId: w.heads.exam } });

    const body = {
      name: 'Mid-term exam fee',
      academicYearId: w.year.id.toString(),
      feeHeadId: w.heads.exam.toString(),
      amount: 800,
      dueOn: '2026-12-10',
      applyConcessions: true,
      audiences: [{ kind: 'class', targetId: w.classId.toString() }],
    };
    // The office holds charge.create but not charge.campaign.send.
    expect((await post('/charge-campaigns', body, w.office, newIdempotencyKey())).status).toBe(403);
    const monthly = await post('/charge-campaigns', { ...body, feeHeadId: w.heads.tuition.toString() }, w.principal, newIdempotencyKey());
    expect([monthly.status, err(monthly).error.details.fields?.[0]?.path]).toEqual([422, 'feeHeadId']);
    const { name: _name, dueOn: _dueOn, ...previewBody } = body;
    const preview = await post('/charge-campaigns/preview-targets', previewBody, w.principal).expect(200);
    expect(preview.body).toEqual({ targets: { students: 2, enrolments: 2 }, concessions: { affected: 1, totalReduction: 400 } });

    const created = await post('/charge-campaigns', body, w.principal, newIdempotencyKey()).expect(201);
    const campaign = created.body as { id: string; status: string };
    await send('patch', `/charge-campaigns/${campaign.id}`, { amount: 900 }, w.principal).expect(200);
    const queued = await post(`/charge-campaigns/${campaign.id}/generate`, {}, w.principal).expect(201);
    const run = queued.body as Run;
    expect([run.kind, run.campaignId, run.status]).toEqual(['campaign', campaign.id, 'queued']);
    const twice = await post(`/charge-campaigns/${campaign.id}/generate`, {}, w.principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.CAMPAIGN_NOT_DRAFT]);
    // While generating it is not a draft: no edits.
    expect((await send('patch', `/charge-campaigns/${campaign.id}`, { amount: 1000 }, w.principal)).status).toBe(409);

    const runner = app.get(JobRunner, { strict: false });
    expect(await runner.messaging(JOB.chargeRun, { schoolId: w.school.id.toString(), runId: run.id })).toBe('done');
    const charges = await db().charge.findMany({ where: { schoolId: w.school.id, campaignId: BigInt(campaign.id) }, orderBy: { studentId: 'asc' } });
    expect(charges.map((c) => [c.studentId, c.kind, c.grossAmount, c.concessionAmount, c.amount, c.dueOn.toISOString().slice(0, 10)])).toEqual(
      [
        [w.child.studentId, 'campaign', 900, 0, 900, '2026-12-10'],
        [second.studentId, 'campaign', 900, 450, 450, '2026-12-10'],
      ],
    );
    expect(charges.some((c) => c.studentId === outsider.studentId)).toBe(false);
    const after = (await get(`/charge-campaigns/${campaign.id}`, w.principal).expect(200)).body as { status: string; generatedCount: number };
    expect([after.status, after.generatedCount]).toEqual(['generated', 2]);
    const families = await db().message.findMany({ where: { schoolId: w.school.id, type: 'fee_charged', subjectId: BigInt(run.id) } });
    expect(families.length).toBe(2);
    expect(families.every((m) => m.body.includes('Mid-term exam fee'))).toBe(true);

    await post(`/charge-campaigns/${campaign.id}/cancel`, { reason: 'Exams postponed' }, w.principal).expect(200);
    for (const action of ['charge_campaign.created', 'charge_campaign.updated', 'charge_campaign.cancelled']) {
      expect((await audit(w.school, action)).map((r) => r.actorUserId)).toEqual([w.principal.user.userId]);
    }
    expect(await db().charge.count({ where: { schoolId: w.school.id, campaignId: BigInt(campaign.id), status: 'voided' } })).toBe(0);

    // An audience reaching nobody.
    const empty = await classWithSection(w.school, w.year);
    const nobody = await post('/charge-campaigns', { ...body, name: 'Empty', audiences: [{ kind: 'class', targetId: empty.classId.toString() }] }, w.principal, newIdempotencyKey()).expect(201);
    const none = await post(`/charge-campaigns/${(nobody.body as { id: string }).id}/generate`, {}, w.principal);
    expect([none.status, err(none).error.code]).toEqual([409, ErrorCode.CAMPAIGN_NO_TARGETS]);
    expect((await audit(w.school, 'charge_campaign.generate_requested')).length).toBe(1);
  });

  // ------------------------------------------------------------------------- admission

  it('R239: admission charges the once head; partial by the office is requested, free by the principal is approved; readmission charges a new once charge', async () => {
    const w = await world();
    const admit = (s: Session, admissionFee: object | undefined, fullName: string, dateOfBirth: string) =>
      post(
        '/admissions',
        {
          student: { fullName, gender: 'female', dateOfBirth, bForm: null },
          guardians: [{ guardianId: w.child.guardianId.toString(), relationship: 'father', isPrimaryContact: true, isFeePayer: true, canLogin: false }],
          enrolment: { classId: w.classId.toString(), sectionId: w.section.id.toString() },
          ...(admissionFee === undefined ? {} : { admissionFee }),
          acknowledgedDuplicateStudentIds: [w.child.studentId.toString()],
        },
        s,
        newIdempotencyKey(),
      );
    // Shape: partial needs an amount below the fee.
    expect((await admit(w.office, { decision: 'partial' }, 'Zainab Akhtar', '2016-02-01')).status).toBe(422);
    const partial = await admit(w.office, { decision: 'partial', amount: 6000 }, 'Zainab Akhtar', '2016-02-01').expect(201);
    const charges = (partial.body as { charges: Charge[] }).charges;
    expect(charges.map((c) => [c.kind, c.grossAmount, c.concessionAmount, c.amount])).toEqual([['generated', 10000, 0, 10000]]);
    const requested = await db().concession.findMany({ where: { schoolId: w.school.id, status: 'requested' } });
    expect(requested.map((c) => [c.kind, c.value])).toEqual([['fixed', 4000]]);

    const free = await admit(w.principal, { decision: 'free' }, 'Maryam Akhtar', '2017-05-09').expect(201);
    expect((free.body as { charges: Charge[] }).charges.map((c) => [c.amount, c.status, c.concessionAmount])).toEqual([[0, 'settled', 10000]]);
    const freeStudent = (free.body as { student: { id: string } }).student.id;

    // Readmission: the admission fee is charged again on the new enrolment.
    await db().student.updateMany({ where: { schoolId: w.school.id, id: BigInt(freeStudent) }, data: { status: 'withdrawn' } });
    await db().enrolment.updateMany({ where: { schoolId: w.school.id, studentId: BigInt(freeStudent) }, data: { status: 'left', endedOn: day(isoDay(-1)) } });
    const readmit = await post(
      `/students/${freeStudent}/readmit`,
      { classId: w.classId.toString(), sectionId: w.section.id.toString(), reason: 'Returned from abroad' },
      w.office,
    ).expect(200);
    // A new once charge on the new enrolment; with no decision sent, the live free concession carries it.
    expect((readmit.body as { charges: Charge[] }).charges.map((c) => [c.grossAmount, c.amount, c.status])).toEqual([[10000, 0, 'settled']]);
    expect((await audit(w.school, 'charge.admission_fee')).length).toBe(3);
    // A teacher would see no money in the result (R234): the office here does.
    const guardian = await createGuardian(db(), w.school);
    void guardian;
  });

  it('R239: a same-year readmission reuses the live admission concession for the same decision, and replaces it for a different one', async () => {
    const w = await world();
    const admit = async (fullName: string, dateOfBirth: string, admissionFee: object) =>
      (
        await post(
          '/admissions',
          {
            student: { fullName, gender: 'female', dateOfBirth, bForm: null },
            guardians: [{ guardianId: w.child.guardianId.toString(), relationship: 'father', isPrimaryContact: true, isFeePayer: true, canLogin: false }],
            enrolment: { classId: w.classId.toString(), sectionId: w.section.id.toString() },
            admissionFee,
            acknowledgedDuplicateStudentIds: [w.child.studentId.toString()],
          },
          w.principal,
          newIdempotencyKey(),
        ).expect(201)
      ).body as { student: { id: string } };
    const leave = async (studentId: string) => {
      await db().student.updateMany({ where: { schoolId: w.school.id, id: BigInt(studentId) }, data: { status: 'withdrawn' } });
      await db().enrolment.updateMany({ where: { schoolId: w.school.id, studentId: BigInt(studentId) }, data: { status: 'left', endedOn: day(isoDay(-1)) } });
    };
    const readmit = (studentId: string, admissionFee?: object) =>
      post(
        `/students/${studentId}/readmit`,
        { classId: w.classId.toString(), sectionId: w.section.id.toString(), reason: 'Came back', ...(admissionFee === undefined ? {} : { admissionFee }) },
        w.principal,
      ).expect(200);
    const concessionsOf = (studentId: string) =>
      db().concession.findMany({ where: { schoolId: w.school.id, studentId: BigInt(studentId) }, orderBy: { id: 'asc' } });

    // Free at admission, free again at readmission: the same concession carries the new charge.
    const free = await admit('Ayesha Noor', '2016-03-01', { decision: 'free' });
    await leave(free.student.id);
    const again = (await readmit(free.student.id, { decision: 'free' })).body as { charges: Charge[] };
    const [first] = await concessionsOf(free.student.id);
    expect(again.charges.map((c) => [c.amount, c.status, c.concessionId])).toEqual([[0, 'settled', first?.id.toString()]]);
    expect((await concessionsOf(free.student.id)).map((c) => c.status)).toEqual(['approved']);

    // Partial 6,000 at admission, partial 4,000 at readmission: the old one ends, a new one carries it.
    const partial = await admit('Bushra Noor', '2015-07-01', { decision: 'partial', amount: 6000 });
    await leave(partial.student.id);
    const replaced = (await readmit(partial.student.id, { decision: 'partial', amount: 4000 })).body as { charges: Charge[] };
    const rows = await concessionsOf(partial.student.id);
    expect(rows.map((c) => [c.status, c.value])).toEqual([
      ['ended', 4000],
      ['approved', 6000],
    ]);
    expect(replaced.charges.map((c) => [c.amount, c.concessionAmount, c.concessionId])).toEqual([[4000, 6000, rows[1]?.id.toString()]]);
    expect((await audit(w.school, 'concession.ended')).map((r) => r.subjectId)).toEqual([rows[0]?.id]);
  });
});
