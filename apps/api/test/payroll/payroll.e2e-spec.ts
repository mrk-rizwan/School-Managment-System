// Slice 25 over HTTP (phase-3-financial.md slice 25): salary structures (R213, R235, R253),
// advances (R215, R235), the monthly run with the R245 leave-and-attendance matrix, pro-rating
// (R246) and recoveries (R247), adjustments and finalise (R216), mark paid (R218), the staff
// member's own payslips (R217), print views (R237) and payslip_ready (R238). The real AppModule and
// database, with the school's clock fixed at 6 October 2026 (SchoolClock overridden).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { SchoolClock } from '../../src/common/school-clock';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import { day } from '../support/students';
import { approvedLeave, db, fixedClock, karachi, marks, payDay, payrollSchool, september } from './support';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

interface ErrorBody {
  error: { code: string; details: { reason?: string; fields?: { path: string; message: string }[]; runId?: string } | null };
}
interface Structure {
  id: string;
  basic: number;
  components: { kind: string; name: string; amount: number }[];
  effectiveFrom: string;
  endedOn: string | null;
  status: string;
  supersededBy: string | null;
  selfApproved: boolean;
}
interface Advance {
  id: string;
  amount: number;
  recoverFrom: string;
  recoveredAmount: number;
  outstanding: number;
  expenseId: string | null;
  status: string;
}
interface Run {
  id: string;
  yearMonth: string;
  workingDays: number;
  status: string;
  staffCount: number;
  skipped: { staffId: string; name: string; reason: string }[];
  totalNet: number;
  unmarkedDaysTotal: number;
  preparedByUserId: string | null;
}
interface Line {
  kind: string;
  name: string;
  amount: number;
  adjustsPayslipId: string | null;
}
interface Payslip {
  id: string;
  runId: string;
  runStatus: string;
  staffId: string;
  staffName: string;
  workingDays: number;
  employedWorkingDays: number;
  basic: number;
  lines: Line[];
  allowancesTotal: number;
  deductionsTotal: number;
  deductionsNotTaken: { name: string; amount: number }[];
  unpaidDays: number;
  unmarkedDays: number;
  absenceDeduction: number;
  advanceRecovery: number;
  adjustmentTotal: number;
  net: number;
  status: string;
  paidOn: string | null;
  days: { unpaid: string[]; unmarked: string[]; unapprovedLeave: string[] } | null;
}
interface PageOf<T> {
  data: T[];
  total: number;
}

describe('slice 25: salary, advances, payroll runs and payslips (e2e)', () => {
  let app: NestExpressApplication;
  const clock = fixedClock('2026-10-06');
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: SchoolClock, useValue: clock.value }] });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(() => {
    clock.state.today = '2026-10-06';
  });

  type Session = TestSchoolSession & { user: TestSchoolUser; school: TestSchool };
  const signIn = async (systemRole: SystemRole, school: TestSchool, fullName?: string): Promise<Session> => {
    const user = await createSchoolUser(db(), school, { systemRole, ...(fullName ? { fullName } : {}) });
    return { ...(await createSchoolSession(db(), school, user)), user, school };
  };
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const post = (path: string, body: object, s: { cookie: string }, headers: Record<string, string> = {}) => {
    const req = http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(body);
  };
  const keyed = (path: string, body: object, s: { cookie: string }, key = newIdempotencyKey()) =>
    post(path, body, s, { 'Idempotency-Key': key });
  const err = (res: request.Response) => res.body as ErrorBody;
  const auditRows = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });
  const grant = (to: TestSchoolUser, by: TestSchoolUser, capability: Capability) =>
    db().userCapabilityGrant.create({
      data: { schoolId: to.schoolId, userId: to.userId, capabilityKey: capability, effect: 'grant', grantedBy: by.userId, reason: 'Test grant' },
    });
  const structure = (
    s: Session,
    staffId: bigint,
    basic: number,
    components: { kind: 'allowance' | 'deduction'; name: string; amount: number }[] = [],
    effectiveFrom = '2026-01-01',
  ) => keyed(`/staff/${staffId}/salary-structure`, { basic, components, effectiveFrom, reason: 'Appointment terms' }, s);
  const advance = (s: Session, staffId: bigint, body: object) =>
    keyed('/salary-advances', { staffId: staffId.toString(), paidMethod: 'cash', recordAsExpense: false, ...body }, s);
  const setStaff = (school: TestSchool, id: bigint, data: { joinedOn?: Date; status?: 'suspended' | 'left'; leftOn?: Date }) =>
    db().staff.updateMany({ where: { schoolId: school.id, id }, data });
  const slipOf = async (runId: string, staffId: bigint, s: Session): Promise<Payslip> => {
    const page = (await get(`/payroll-runs/${runId}/payslips?limit=50`, s).expect(200)).body as PageOf<Payslip>;
    const slip = page.data.find((p) => p.staffId === staffId.toString());
    if (!slip) throw new Error(`no payslip for staff ${staffId}`);
    return slip;
  };

  // ------------------------------------------------------------------------- salary structures

  it('R213: create, replay, same-day supersede, later close, never earlier; history and /me current and upcoming', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Rabia Teacher');
    const staffId = teacher.user.staffId;
    const key = newIdempotencyKey();
    const body = {
      basic: 52_000,
      components: [
        { kind: 'allowance', name: 'House rent', amount: 10_400 },
        { kind: 'deduction', name: 'Provident fund', amount: 2_600 },
      ],
      effectiveFrom: '2026-01-01',
      reason: 'Appointment terms',
    };
    const first = (await keyed(`/staff/${staffId}/salary-structure`, body, principal, key).expect(201)).body as Structure;
    expect([first.basic, first.status, first.endedOn, first.selfApproved, first.components.length]).toEqual([52_000, 'active', null, false, 2]);
    const replay = await keyed(`/staff/${staffId}/salary-structure`, body, principal, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as Structure).id]).toEqual(['true', first.id]);

    // A teacher holds neither key (R234).
    await structure(teacher, staffId, 1).expect(403);
    await get(`/staff/${staffId}/salary-structure`, teacher).expect(403);

    // Same day: supersedes.
    const same = (await structure(principal, staffId, 55_000).expect(201)).body as Structure;
    // A later start closes the current one the day before.
    const later = (await structure(principal, staffId, 60_000, [], '2026-11-01').expect(201)).body as Structure;
    const history = (await get(`/staff/${staffId}/salary-structure`, principal).expect(200)).body as PageOf<Structure>;
    expect(history.data.map((r) => [r.id, r.basic, r.effectiveFrom, r.endedOn, r.status, r.supersededBy])).toEqual([
      [later.id, 60_000, '2026-11-01', null, 'active', null],
      [same.id, 55_000, '2026-01-01', '2026-10-31', 'active', null],
      [first.id, 52_000, '2026-01-01', null, 'superseded', same.id],
    ]);
    // Never before the latest start.
    const earlier = await structure(principal, staffId, 1, [], '2026-06-01');
    expect([earlier.status, err(earlier).error.details?.fields?.[0]?.path]).toEqual([422, 'effectiveFrom']);
    // Duplicate component names of one kind.
    const twice = await structure(principal, staffId, 1, [
      { kind: 'allowance', name: 'Fuel', amount: 1 },
      { kind: 'allowance', name: 'fuel', amount: 2 },
    ], '2026-12-01');
    expect([twice.status, err(twice).error.details?.fields?.[0]?.path]).toEqual([422, 'components.1.name']);

    // R217: the staff member's own, from the session.
    const mine = (await get('/me/staff/salary-structure', teacher).expect(200)).body as { current: Structure; upcoming: Structure };
    expect([mine.current.id, mine.upcoming.id]).toEqual([same.id, later.id]);
    expect(((await get('/me/staff/salary-structure', principal).expect(200)).body as { current: null }).current).toBeNull();
    expect((await auditRows(school, 'salary_structure.created')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ staffId: staffId.toString(), basic: 52_000, allowancesTotal: 10_400, deductionsTotal: 2_600, selfApproved: false }),
      expect.objectContaining({ basic: 55_000, supersededId: first.id }),
      expect.objectContaining({ basic: 60_000, closedId: same.id }),
    ]);
    // Another school's staff member is 404.
    const other = await payrollSchool();
    const stranger = await createSchoolUser(db(), other.school, { systemRole: 'teacher' });
    await structure(principal, stranger.staffId, 1).expect(404);
  });

  it('R235, R253: one\'s own structure only as the sole principal (self_approved); refused with two principals; the trigger agrees', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const own = (await structure(principal, principal.user.staffId, 90_000).expect(201)).body as Structure;
    expect(own.selfApproved).toBe(true);
    const second = await signIn('principal', school);
    const refused = await structure(principal, principal.user.staffId, 95_000, [], '2026-11-01');
    expect([refused.status, err(refused).error.code, err(refused).error.details?.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'own_salary']);
    // A colleague may.
    await structure(second, principal.user.staffId, 95_000, [], '2026-11-01').expect(201);
    // The trigger: an office clerk writing their own row directly.
    const office = await signIn('office_staff', school);
    await expect(
      db().salaryStructure.create({
        data: { schoolId: school.id, staffId: office.user.staffId, basic: 1, effectiveFrom: day('2026-01-01'), reason: 'Direct', createdBy: office.user.userId },
      }),
    ).rejects.toThrow(/salary_structures_not_self/);
  });

  // ------------------------------------------------------------------------------- advances

  it('R215, R233, R235: the principal grants with the expense in the same transaction; write-off; never own; a payroll.run grant is not enough', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Rabia Teacher');
    const office = await signIn('office_staff', school);
    await grant(office.user, principal.user, Capability.PAYROLL_RUN);
    await grant(office.user, principal.user, Capability.PAYROLL_VIEW);

    const key = newIdempotencyKey();
    const body = { staffId: teacher.user.staffId.toString(), amount: 12_000, grantedOn: '2026-09-10', instalmentAmount: 5_000, paidMethod: 'cash', recordAsExpense: true };
    const created = (await keyed('/salary-advances', body, principal, key).expect(201)).body as Advance;
    expect([created.amount, created.recoverFrom, created.outstanding, created.status]).toEqual([12_000, '2026-10', 12_000, 'open']);
    await keyed('/salary-advances', body, principal, key).expect(200);
    const expense = await db().expense.findFirst({ where: { schoolId: school.id, id: BigInt(created.expenseId ?? '0') } });
    // Above the 5,000 threshold: approved on record by the principal who granted it (R206).
    expect([expense?.category, expense?.amount, expense?.status, expense?.selfApproved, expense?.recordedBy]).toEqual([
      'salary_advance_cash', 12_000, 'approved', true, principal.user.userId,
    ]);
    expect((await auditRows(school, 'salary_advance.granted')).length).toBe(1);
    expect((await auditRows(school, 'expense.recorded')).map((r) => r.metadata)).toEqual([expect.objectContaining({ source: 'salary_advance', amount: 12_000 })]);

    // R233: the key alone is not the principal.
    const clerk = await advance(office, teacher.user.staffId, { amount: 1_000, grantedOn: '2026-10-01', instalmentAmount: 500 });
    expect([clerk.status, err(clerk).error.details?.reason]).toEqual([403, 'principal_required']);
    // R235: never one's own (no sole-principal exception for cash).
    const own = await advance(principal, principal.user.staffId, { amount: 1_000, grantedOn: '2026-10-01', instalmentAmount: 500 });
    expect([own.status, err(own).error.details?.reason]).toEqual([409, 'own_advance']);
    // Instalment above the amount; a future grant date; recoverFrom before the grant's month.
    const field = async (extra: object) =>
      err(await advance(principal, teacher.user.staffId, { amount: 1_000, grantedOn: '2026-10-01', instalmentAmount: 500, ...extra })).error.details?.fields?.[0]?.path;
    expect(await field({ instalmentAmount: 1_001 })).toBe('instalmentAmount');
    expect(await field({ grantedOn: '2026-10-07' })).toBe('grantedOn');
    expect(await field({ recoverFrom: '2026-09' })).toBe('recoverFrom');

    const list = (await get('/salary-advances?status=open', office).expect(200)).body as PageOf<Advance>;
    expect(list.data.map((a) => a.id)).toEqual([created.id]);
    await get('/salary-advances', teacher).expect(403);

    // Write-off: the principal, once.
    const refusedOff = await post(`/salary-advances/${created.id}/write-off`, { reason: 'Left the school' }, office);
    expect(err(refusedOff).error.details?.reason).toBe('principal_required');
    const off = (await post(`/salary-advances/${created.id}/write-off`, { reason: 'Hardship relief' }, principal).expect(200)).body as Advance;
    expect(off.status).toBe('written_off');
    const again = await post(`/salary-advances/${created.id}/write-off`, { reason: 'Hardship relief' }, principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.ADVANCE_NOT_OPEN]);
    expect((await auditRows(school, 'salary_advance.written_off')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ amount: 12_000, recoveredAmount: 0, writtenOff: 12_000 }),
    ]);
    // The trigger: a direct grant of one's own advance.
    await expect(
      db().salaryAdvance.create({
        data: {
          schoolId: school.id, staffId: principal.user.staffId, amount: 100, grantedOn: day('2026-10-01'), recoverFrom: '2026-11',
          instalmentAmount: 100, approvedBy: principal.user.userId, paidMethod: 'cash',
        },
      }),
    ).rejects.toThrow(/nobody grants or writes off their own salary advance/);
  });

  // --------------------------------------------------------------------------- the monthly run

  it('R214, R245-R247: September prepared; the leave matrix, mid-month join, skipped staff, recoveries stopping before negative', async () => {
    const { school, types } = await payrollSchool();
    const principal = await signIn('principal', school);
    const p = principal.user.userId;
    const a = await signIn('teacher', school, 'Amina Teacher');
    const b = await signIn('teacher', school, 'Bilal Teacher');
    const c = await signIn('teacher', school, 'Chand Suspended');
    await signIn('teacher', school, 'Dawood Unpriced');
    const e = await signIn('teacher', school, 'Erum Left');
    const f = await signIn('teacher', school, 'Farah Borrower');

    await structure(principal, a.user.staffId, 52_000, [
      { kind: 'allowance', name: 'House rent', amount: 5_200 },
      { kind: 'deduction', name: 'Provident fund', amount: 2_600 },
    ]).expect(201);
    await structure(principal, b.user.staffId, 26_000, [{ kind: 'allowance', name: 'Conveyance', amount: 2_600 }]).expect(201);
    await structure(principal, c.user.staffId, 30_000).expect(201);
    await structure(principal, e.user.staffId, 30_000).expect(201);
    await structure(principal, f.user.staffId, 10_000, [
      { kind: 'deduction', name: 'Loan', amount: 9_000 },
      { kind: 'deduction', name: 'Welfare', amount: 2_000 },
    ]).expect(201);
    await setStaff(school, b.user.staffId, { joinedOn: day('2026-09-16') });
    await setStaff(school, c.user.staffId, { status: 'suspended' });
    await setStaff(school, e.user.staffId, { status: 'left', leftOn: day('2026-08-31') });

    // A: the R245 matrix, one row per case.
    await marks(school, a.user.staffId, p, {
      ...september('present', ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-29', '2026-09-30']),
      '2026-09-02': 'absent', //        no leave            → unpaid
      '2026-09-03': 'on_leave', //      no leave            → unpaid, listed
      '2026-09-04': 'absent', //        approved paid leave → paid
      '2026-09-05': 'present', //       approved unpaid     → paid (attendance wins)
      '2026-09-08': 'on_leave', //      approved paid leave → paid
      '2026-09-09': 'absent', //        approved unpaid     → unpaid
      // 07: unmarked under approved unpaid leave → unpaid; 10: unmarked, no leave → paid, counted;
      // 29, 30: unmarked under unpaid leave that runs into October → unpaid (September's days only).
    });
    await approvedLeave(school, a.user.staffId, types.casual, '2026-09-04', '2026-09-04', p);
    await approvedLeave(school, a.user.staffId, types.unpaid, '2026-09-05', '2026-09-07', p);
    await approvedLeave(school, a.user.staffId, types.sick, '2026-09-08', '2026-09-08', p);
    await approvedLeave(school, a.user.staffId, types.unpaid, '2026-09-09', '2026-09-09', p);
    await approvedLeave(school, a.user.staffId, types.unpaid, '2026-09-29', '2026-10-02', p);
    await marks(school, f.user.staffId, p, september('present'));

    // F's two advances in grant order: the first takes what the pay leaves, the second nothing.
    const a1 = (await advance(principal, f.user.staffId, { amount: 3_000, grantedOn: '2026-08-05', recoverFrom: '2026-09', instalmentAmount: 2_000 }).expect(201)).body as Advance;
    const a2 = (await advance(principal, f.user.staffId, { amount: 5_000, grantedOn: '2026-08-20', recoverFrom: '2026-09', instalmentAmount: 5_000 }).expect(201)).body as Advance;

    const run = (await post('/payroll-runs', { yearMonth: '2026-09' }, principal).expect(201)).body as Run;
    // A, B and F; E left before the month; the principal has no structure.
    expect([run.yearMonth, run.workingDays, run.status, run.staffCount, run.preparedByUserId]).toEqual(['2026-09', 26, 'draft', 3, p.toString()]);
    expect(run.skipped.filter((s) => s.staffId !== principal.user.staffId.toString()).map((s) => [s.name, s.reason])).toEqual([
      ['Chand Suspended', 'suspended'],
      ['Dawood Unpriced', 'no_salary_structure'],
    ]);
    const exists = await post('/payroll-runs', { yearMonth: '2026-09' }, principal);
    expect([exists.status, err(exists).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_EXISTS]);

    const slipA = await slipOf(run.id, a.user.staffId, principal);
    // Unpaid: 02, 03, 07, 09, 29, 30 → 6 × floor(52,000 / 26) = 12,000. Unmarked: 10.
    expect([slipA.employedWorkingDays, slipA.basic, slipA.allowancesTotal, slipA.deductionsTotal, slipA.unpaidDays, slipA.unmarkedDays, slipA.absenceDeduction, slipA.net]).toEqual([
      26, 52_000, 5_200, 2_600, 6, 1, 12_000, 42_600,
    ]);
    expect(slipA.days).toEqual({
      unpaid: ['2026-09-02', '2026-09-03', '2026-09-07', '2026-09-09', '2026-09-29', '2026-09-30'],
      unmarked: ['2026-09-10'],
      unapprovedLeave: ['2026-09-03'],
    });
    expect(slipA.lines.map((l) => [l.kind, l.name, l.amount])).toEqual([
      ['allowance', 'House rent', 5_200],
      ['deduction', 'Provident fund', 2_600],
      ['absence', 'Unpaid absence, 6 days', 12_000],
    ]);

    // R246: B joined on the 16th: 13 of 26 working days.
    const slipB = await slipOf(run.id, b.user.staffId, principal);
    expect([slipB.employedWorkingDays, slipB.basic, slipB.allowancesTotal, slipB.unmarkedDays, slipB.net]).toEqual([13, 13_000, 1_300, 13, 14_300]);

    // R247: 10,000 − Loan 9,000 − Welfare 1,000 (of 2,000: not carried) − A1's 2,000 instalment
    // stops at what is left (0) → no recovery; net never below 0.
    const slipF = await slipOf(run.id, f.user.staffId, principal);
    expect([slipF.deductionsTotal, slipF.advanceRecovery, slipF.net]).toEqual([10_000, 0, 0]);
    expect(slipF.deductionsNotTaken).toEqual([{ name: 'Welfare', amount: 1_000 }]);
    expect(run.totalNet).toBe(42_600 + 14_300 + 0);

    // A lower loan from September (the structure closes on 31 August): the advances now recover in
    // grant order from what the pay leaves.
    await structure(principal, f.user.staffId, 10_000, [{ kind: 'deduction', name: 'Loan', amount: 6_500 }], '2026-09-01')
      .expect(201);
    const recomputed = (await post(`/payroll-runs/${run.id}/recompute`, {}, principal).expect(200)).body as Run;
    const slipF2 = await slipOf(run.id, f.user.staffId, principal);
    // 10,000 − 6,500 = 3,500: A1 takes its 2,000, A2 the 1,500 left of its 5,000.
    expect([slipF2.deductionsTotal, slipF2.advanceRecovery, slipF2.net]).toEqual([6_500, 3_500, 0]);
    expect(slipF2.lines.filter((l) => l.kind === 'advance_recovery').map((l) => [l.name, l.amount])).toEqual([
      ['Advance of 5 Aug 2026', 2_000],
      ['Advance of 20 Aug 2026', 1_500],
    ]);
    expect(recomputed.totalNet).toBe(42_600 + 14_300);
    expect((await auditRows(school, 'payroll_run.prepared')).length).toBe(1);
    expect((await auditRows(school, 'payroll_run.recomputed')).map((r) => r.metadata)).toEqual([expect.objectContaining({ yearMonth: '2026-09' })]);

    // Finalise: recoveries written, the advances' counters raised, payslip_ready sent.
    const done = (await post(`/payroll-runs/${run.id}/finalise`, { reason: 'September salaries' }, principal).expect(200)).body as Run;
    expect(done.status).toBe('finalised');
    const after1 = (await get(`/salary-advances/${a1.id}`, principal).expect(200)).body as Advance;
    const after2 = (await get(`/salary-advances/${a2.id}`, principal).expect(200)).body as Advance;
    expect([after1.recoveredAmount, after1.status, after2.recoveredAmount, after2.status]).toEqual([2_000, 'open', 1_500, 'open']);
    expect(await db().salaryAdvanceRecovery.count({ where: { schoolId: school.id } })).toBe(2);
    const ready = await db().message.findMany({ where: { schoolId: school.id, type: 'payslip_ready' } });
    expect(ready.map((m) => m.staffId).sort()).toEqual([a.user.staffId, b.user.staffId, f.user.staffId].sort());
    expect(ready[0]?.body).toBe('Test School: Your payslip for Sept 2026 is ready. Open ASMS to see it.');
    expect((await auditRows(school, 'payroll_run.finalised')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ yearMonth: '2026-09', staffCount: 3, recoveries: 2, recoveredTotal: 3_500 }),
    ]);

    // R216: frozen. An amended mark changes nothing; recompute, finalise and adjust are refused.
    await marks(school, b.user.staffId, p, { '2026-09-16': 'absent' });
    const frozen = await post(`/payroll-runs/${run.id}/recompute`, {}, principal);
    expect([frozen.status, err(frozen).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_FINALISED]);
    const twice = await post(`/payroll-runs/${run.id}/finalise`, {}, principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_NOT_DRAFT]);
    expect((await slipOf(run.id, b.user.staffId, principal)).net).toBe(14_300);
    const late = await keyed(`/payslips/${slipB.id}/adjust`, { amount: 100, name: 'Bonus', reason: 'Late bonus' }, principal);
    expect([late.status, err(late).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_FINALISED]);
    // The payslip rows refuse a direct edit once the run is finalised.
    await expect(
      db().payslip.updateMany({ where: { schoolId: school.id, id: BigInt(slipB.id) }, data: { unmarkedDays: 0 } }),
    ).rejects.toThrow(/payslips_run_finalised/);

    // R213: a structure change into the paid month is refused; from the next month it is fine.
    const inUse = await structure(principal, a.user.staffId, 60_000, [], '2026-09-15');
    expect([inUse.status, err(inUse).error.code]).toEqual([409, ErrorCode.SALARY_STRUCTURE_IN_USE]);
    await structure(principal, a.user.staffId, 60_000, [], '2026-10-01').expect(201);
  });

  it('R216, R235, R218: adjustments (never own, never past the pay), the finaliser rule, mark paid once; a correction next month', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const office = await signIn('office_staff', school, 'Omar Office');
    const teacher = await signIn('teacher', school, 'Tahira Teacher');
    for (const key of [Capability.PAYROLL_RUN, Capability.PAYROLL_VIEW]) await grant(office.user, principal.user, key);
    await structure(principal, office.user.staffId, 26_000).expect(201);
    await structure(principal, teacher.user.staffId, 26_000).expect(201);

    // Not a future month; the current one only from its last working day (Saturday 31 October).
    expect(err(await post('/payroll-runs', { yearMonth: '2026-11' }, office)).error.details?.fields?.[0]?.path).toBe('yearMonth');
    const early = await post('/payroll-runs', { yearMonth: '2026-10' }, office);
    expect([early.status, err(early).error.details?.fields?.[0]?.message]).toEqual([422, 'This month can be prepared from its last working day, 2026-10-31']);

    const run = (await post('/payroll-runs', { yearMonth: '2026-09' }, office).expect(201)).body as Run;
    const slipT = await slipOf(run.id, teacher.user.staffId, office);
    const slipO = await slipOf(run.id, office.user.staffId, office);

    // Mark paid needs a finalised run.
    const notYet = await post(`/payslips/${slipT.id}/mark-paid`, { paidOn: '2026-10-01', paidMethod: 'cash' }, office);
    expect([notYet.status, err(notYet).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    // R217: nothing of a draft reaches the staff member.
    expect(((await get('/me/staff/payslips', teacher).expect(200)).body as PageOf<Payslip>).total).toBe(0);
    await get(`/me/staff/payslips/${slipT.id}`, teacher).expect(404);

    const key = newIdempotencyKey();
    const adjust = { amount: 1_500, name: 'Exam duty', reason: 'Invigilation in September' };
    const adjusted = (await keyed(`/payslips/${slipT.id}/adjust`, adjust, office, key).expect(200)).body as Payslip;
    expect([adjusted.adjustmentTotal, adjusted.net]).toEqual([1_500, 27_500]);
    const replay = await keyed(`/payslips/${slipT.id}/adjust`, adjust, office, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as Payslip).lines.filter((l) => l.kind === 'adjustment').length]).toEqual(['true', 1]);
    expect(((await get(`/payroll-runs/${run.id}`, office).expect(200)).body as Run).totalNet).toBe(26_000 + 27_500);

    // payslipNet refuses an adjustment beyond the pay, with the field.
    const beyond = await keyed(`/payslips/${slipT.id}/adjust`, { amount: -30_000, name: 'Recovery', reason: 'Overpaid in August' }, office);
    expect([beyond.status, err(beyond).error.details?.fields?.[0]?.path]).toEqual([422, 'amount']);
    // Own slip: refused, service and trigger.
    const own = await keyed(`/payslips/${slipO.id}/adjust`, { amount: 500, name: 'Bonus', reason: 'Self bonus' }, office);
    expect([own.status, err(own).error.details?.reason]).toEqual([409, 'own_payslip']);
    await expect(
      db().payslipLine.create({
        data: { schoolId: school.id, payslipId: BigInt(slipO.id), staffId: office.user.staffId, kind: 'adjustment', name: 'Bonus', amount: 500, reason: 'Direct', createdBy: office.user.userId },
      }),
    ).rejects.toThrow(/nobody adjusts their own payslip/);
    // Only a finalised payslip is corrected.
    const draftTarget = await keyed(`/payslips/${slipT.id}/adjust`, { amount: 10, name: 'Fix', reason: 'Fix it', adjustsPayslipId: slipO.id }, office);
    expect([draftTarget.status, err(draftTarget).error.details?.fields?.[0]?.path]).toEqual([422, 'adjustsPayslipId']);

    // A finaliser whose own slip carries an adjustment needs the principal role.
    await keyed(`/payslips/${slipO.id}/adjust`, { amount: 700, name: 'Overtime', reason: 'Admissions week' }, principal).expect(200);
    const blocked = await post(`/payroll-runs/${run.id}/finalise`, {}, office);
    expect([blocked.status, err(blocked).error.details?.reason]).toEqual([403, 'principal_required']);
    await post(`/payroll-runs/${run.id}/finalise`, {}, principal).expect(200);
    expect((await slipOf(run.id, teacher.user.staffId, office)).adjustmentTotal).toBe(1_500);

    // R218: once, with date, method and reference; never in the future.
    expect(err(await post(`/payslips/${slipT.id}/mark-paid`, { paidOn: '2026-10-07', paidMethod: 'cash' }, office)).error.details?.fields?.[0]?.path).toBe('paidOn');
    const paid = (await post(`/payslips/${slipT.id}/mark-paid`, { paidOn: '2026-10-01', paidMethod: 'bank_transfer', paidReference: 'TRX-1001' }, office).expect(200)).body as Payslip;
    expect([paid.status, paid.paidOn]).toEqual(['paid', '2026-10-01']);
    const again = await post(`/payslips/${slipT.id}/mark-paid`, { paidOn: '2026-10-01', paidMethod: 'cash' }, office);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.PAYSLIP_PAID]);
    expect((await auditRows(school, 'payslip.paid')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ amount: 27_500, paidMethod: 'bank_transfer', staffId: teacher.user.staffId.toString() }),
    ]);
    expect((await auditRows(school, 'payslip.adjusted')).length).toBe(2);

    // R217: the staff member reads their own finalised payslips, nobody else's.
    const mine = (await get('/me/staff/payslips', teacher).expect(200)).body as PageOf<Payslip>;
    expect([mine.total, mine.data[0]?.id, mine.data[0]?.days]).toEqual([1, slipT.id, null]);
    await get(`/me/staff/payslips/${slipO.id}`, teacher).expect(404);
    await get(`/payslips/${slipT.id}`, teacher).expect(403);

    // A correction in October's run (from its last working day), referencing September's slip.
    clock.state.today = '2026-10-31';
    const october = (await post('/payroll-runs', { yearMonth: '2026-10' }, office).expect(201)).body as Run;
    const octT = await slipOf(october.id, teacher.user.staffId, office);
    const corrected = (await keyed(`/payslips/${octT.id}/adjust`, { amount: -500, name: 'September overpaid', reason: 'Exam duty was 1,000', adjustsPayslipId: slipT.id }, office).expect(200)).body as Payslip;
    expect(corrected.lines.filter((l) => l.kind === 'adjustment').map((l) => [l.amount, l.adjustsPayslipId])).toEqual([[-500, slipT.id]]);
    // Another staff member's payslip is not a correction target.
    const wrong = await keyed(`/payslips/${octT.id}/adjust`, { amount: -1, name: 'Fix', reason: 'Wrong person', adjustsPayslipId: slipO.id }, office);
    expect([wrong.status, err(wrong).error.details?.fields?.[0]?.path]).toEqual([422, 'adjustsPayslipId']);
  });

  it('R237: print views carry the fixed headers and print a <script> component as text', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Tahira <b>Teacher</b>');
    await structure(principal, teacher.user.staffId, 26_000, [{ kind: 'allowance', name: '<script>alert(1)</script>', amount: 100 }]).expect(201);
    const run = (await post('/payroll-runs', { yearMonth: '2026-09' }, principal).expect(201)).body as Run;
    await post(`/payroll-runs/${run.id}/finalise`, {}, principal).expect(200);
    const slip = await slipOf(run.id, teacher.user.staffId, principal);
    for (const [path, s] of [[`/payslips/${slip.id}/print`, principal], [`/me/staff/payslips/${slip.id}/print`, teacher]] as const) {
      const res = await get(path, s).expect(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      expect([res.headers['x-content-type-options'], res.headers['cache-control'], res.headers['content-disposition']]).toEqual(['nosniff', 'no-store', 'inline']);
      expect(res.text).not.toContain('<script>');
      expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(res.text).toContain('Tahira &lt;b&gt;Teacher&lt;/b&gt;');
      expect(res.text).toContain('Payslip, September 2026');
    }
    // Another staff member's own print route is 404.
    const other = await signIn('teacher', school);
    await get(`/me/staff/payslips/${slip.id}/print`, other).expect(404);
  });

  it('R214: a month with no working day is full pay with no deduction; the pay-day job prepares the previous month once', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    // Closed for staff all September (a published holiday that applies to staff).
    await db().holiday.create({
      data: {
        schoolId: school.id, startsOn: day('2026-09-01'), endsOn: day('2026-09-30'), name: 'Rebuilding', kind: 'school',
        appliesToStaff: true, status: 'published', publishedAt: new Date(), publishedBy: principal.user.userId,
      },
    });
    const teacher = await signIn('teacher', school);
    await structure(principal, teacher.user.staffId, 30_000, [{ kind: 'allowance', name: 'Fuel', amount: 1_000 }]).expect(201);
    await marks(school, teacher.user.staffId, principal.user.userId, { '2026-09-01': 'absent', '2026-09-02': 'absent' });

    // The pay day (the 1st by default) prepares September; later days find the run (idempotent).
    const runId = await payDay(app, school.id, karachi('2026-10-01', 3));
    expect(runId).not.toBeNull();
    expect(await payDay(app, school.id, karachi('2026-10-01', 4))).toBeNull();
    expect(await payDay(app, school.id, karachi('2026-10-02', 3))).toBeNull();
    const run = (await get(`/payroll-runs/${runId}`, principal).expect(200)).body as Run;
    expect([run.yearMonth, run.workingDays, run.status, run.preparedByUserId]).toEqual(['2026-09', 0, 'draft', null]);
    const slip = await slipOf(run.id, teacher.user.staffId, principal);
    expect([slip.basic, slip.allowancesTotal, slip.unpaidDays, slip.absenceDeduction, slip.net]).toEqual([30_000, 1_000, 0, 0, 31_000]);
    const audit = await auditRows(school, 'payroll_run.auto_prepared');
    expect(audit.map((r) => [r.actorUserId, r.metadata])).toEqual([[null, expect.objectContaining({ job: 'payroll-prepare', yearMonth: '2026-09' })]]);
    // A school paying on the 28th: nothing on the 1st.
    const other = await payrollSchool();
    await db().schoolSettings.updateMany({ where: { schoolId: other.school.id }, data: { payDay: 28 } });
    expect(await payDay(app, other.school.id, karachi('2026-10-01', 3))).toBeNull();
    expect(await payDay(app, other.school.id, karachi('2026-10-27', 3))).toBeNull();
    // The 28th was missed (the worker was down): the 29th catches up, once.
    const caughtUp = await payDay(app, other.school.id, karachi('2026-10-29', 3));
    expect(caughtUp).not.toBeNull();
    expect((await db().payrollRun.findFirst({ where: { schoolId: other.school.id, id: caughtUp ?? 0n } }))?.yearMonth).toBe('2026-09');
    expect(await payDay(app, other.school.id, karachi('2026-10-30', 3))).toBeNull();
  });

  it('R214: recompute after an attendance amendment changes the draft; a staff member suspended after preparing keeps an empty payslip', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const a = await signIn('teacher', school, 'Amina Teacher');
    const b = await signIn('teacher', school, 'Bilal Teacher');
    await structure(principal, a.user.staffId, 26_000).expect(201);
    await structure(principal, b.user.staffId, 26_000).expect(201);
    const run = (await post('/payroll-runs', { yearMonth: '2026-09' }, principal).expect(201)).body as Run;
    expect([(await slipOf(run.id, a.user.staffId, principal)).net, run.unmarkedDaysTotal]).toEqual([26_000, 52]);

    await marks(school, a.user.staffId, principal.user.userId, { '2026-09-01': 'absent', '2026-09-02': 'present' });
    await setStaff(school, b.user.staffId, { status: 'suspended' });
    const again = (await post(`/payroll-runs/${run.id}/recompute`, {}, principal).expect(200)).body as Run;
    const slipA = await slipOf(run.id, a.user.staffId, principal);
    const slipB = await slipOf(run.id, b.user.staffId, principal);
    expect([slipA.unpaidDays, slipA.unmarkedDays, slipA.absenceDeduction, slipA.net]).toEqual([1, 24, 1_000, 25_000]);
    expect([slipB.employedWorkingDays, slipB.basic, slipB.net]).toEqual([0, 0, 0]);
    expect(again.skipped.filter((s) => s.staffId === b.user.staffId.toString()).map((s) => s.reason)).toEqual(['suspended']);
    expect([again.staffCount, again.totalNet, again.unmarkedDaysTotal]).toEqual([2, 25_000, 24]);
  });

  it('R216: a correction for someone who left in September, on an added payslip in the October draft; only an earlier month is corrected', async () => {
    const { school } = await payrollSchool();
    const principal = await signIn('principal', school);
    const leaver = await signIn('teacher', school, 'Laila Leaver');
    const stayer = await signIn('teacher', school, 'Sana Stayer');
    const unpriced = await signIn('teacher', school, 'Umar Unpriced');
    await structure(principal, leaver.user.staffId, 26_000).expect(201);
    await structure(principal, stayer.user.staffId, 26_000).expect(201);
    await setStaff(school, leaver.user.staffId, { status: 'left', leftOn: day('2026-09-15') });
    const sept = (await post('/payroll-runs', { yearMonth: '2026-09' }, principal).expect(201)).body as Run;
    const septLeaver = await slipOf(sept.id, leaver.user.staffId, principal);
    expect(septLeaver.employedWorkingDays).toBe(13);
    await post(`/payroll-runs/${sept.id}/finalise`, {}, principal).expect(200);

    clock.state.today = '2026-10-31';
    const october = (await post('/payroll-runs', { yearMonth: '2026-10' }, principal).expect(201)).body as Run;
    expect(october.staffCount).toBe(1);
    const add = { staffId: leaver.user.staffId.toString(), reason: 'September exam duty unpaid' };
    const added = (await post(`/payroll-runs/${october.id}/payslips`, add, principal).expect(201)).body as Payslip;
    expect([added.staffId, added.basic, added.net, added.lines]).toEqual([leaver.user.staffId.toString(), 0, 0, []]);
    const again = await post(`/payroll-runs/${october.id}/payslips`, add, principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_EXISTS]);
    const never = await post(`/payroll-runs/${october.id}/payslips`, { staffId: unpriced.user.staffId.toString(), reason: 'No salary ever' }, principal);
    expect([never.status, err(never).error.code]).toEqual([422, ErrorCode.SALARY_STRUCTURE_MISSING]);
    const other = await payrollSchool();
    const stranger = await createSchoolUser(db(), other.school, { systemRole: 'teacher' });
    await post(`/payroll-runs/${october.id}/payslips`, { staffId: stranger.staffId.toString(), reason: 'Not ours' }, principal).expect(404);
    const listed = (await get(`/payroll-runs/${october.id}`, principal).expect(200)).body as Run;
    expect(listed.skipped.filter((s) => s.staffId === leaver.user.staffId.toString()).map((s) => s.reason)).toEqual(['not_employed']);
    expect((await auditRows(school, 'payslip.added')).map((r) => r.metadata)).toEqual([expect.objectContaining({ skipReason: 'not_employed' })]);

    const corrected = (
      await keyed(`/payslips/${added.id}/adjust`, { amount: 2_000, name: 'Exam duty, September', reason: 'Unpaid duty', adjustsPayslipId: septLeaver.id }, principal).expect(200)
    ).body as Payslip;
    expect(corrected.net).toBe(2_000);
    // Recompute keeps it (nothing computed, the adjustment stays); finalise freezes it.
    await post(`/payroll-runs/${october.id}/recompute`, {}, principal).expect(200);
    expect((await slipOf(october.id, leaver.user.staffId, principal)).net).toBe(2_000);
    await post(`/payroll-runs/${october.id}/finalise`, {}, principal).expect(200);
    // No payslip_ready for a payslip with nothing computed.
    const ready = await db().message.findMany({ where: { schoolId: school.id, type: 'payslip_ready', subjectId: BigInt(october.id) } });
    expect(ready.map((m) => m.staffId)).toEqual([stayer.user.staffId]);
    // A finalised run takes no slip.
    const late = await post(`/payroll-runs/${october.id}/payslips`, { staffId: unpriced.user.staffId.toString(), reason: 'Too late' }, principal);
    expect([late.status, err(late).error.code]).toEqual([409, ErrorCode.PAYROLL_RUN_FINALISED]);
    // The kept-empty October slip is not a use of the structure: a change from October is fine.
    await structure(principal, leaver.user.staffId, 30_000, [], '2026-10-01').expect(201);

    // Only an earlier month's payslip is corrected: August's draft cannot correct September.
    const august = (await post('/payroll-runs', { yearMonth: '2026-08' }, principal).expect(201)).body as Run;
    const augStayer = await slipOf(august.id, stayer.user.staffId, principal);
    const septStayer = await slipOf(sept.id, stayer.user.staffId, principal);
    const forward = await keyed(`/payslips/${augStayer.id}/adjust`, { amount: 10, name: 'Fix', reason: 'Wrong way', adjustsPayslipId: septStayer.id }, principal);
    expect([forward.status, err(forward).error.details?.fields?.[0]?.path]).toEqual([422, 'adjustsPayslipId']);
  });
});
