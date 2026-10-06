// Slice 27 over HTTP (phase-3-financial.md slice 27, contracts/slice-27.md): GET /me/approvals
// shows only the queues the caller may act on (R227), each section's count equal to what the
// queue's own endpoint reports as its total, its items the queue's first page of ten, never
// another school's rows. The real AppModule and database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Capability, ErrorCode, newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { png } from '../documents/fixtures';
import { db } from '../fees/charges-support';
import { API, ORIGIN, paymentsHttp, type World } from '../payments/payments-support';
import {
  createSchoolSession,
  randomIdentityDigits,
  testIdentityHash,
  type TestSchoolSession,
} from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createGuardian, isoDay, linkGuardian } from '../support/students';

interface Section {
  count: number;
  items: { id: string }[];
}
interface Approvals {
  claims?: Section;
  handovers?: Section;
  expenses?: Section;
  leave?: Section;
}
interface Page {
  data: { id: string }[];
  total: number;
}

const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g'; // pragma: allowlist secret

describe('slice 27: the Approvals read (e2e)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);
  const { get, post } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const approvals = async (s: { cookie: string }): Promise<Approvals> =>
    (await get('/me/approvals', s).expect(200)).body as Approvals;
  const page = async (path: string, s: { cookie: string }): Promise<Page> => (await get(path, s).expect(200)).body as Page;

  /** The father's login: his links to both children become login links. */
  async function fatherLogin(w: World): Promise<TestSchoolSession> {
    const user = await db().user.create({
      data: { schoolId: w.school.id, usernameHash: testIdentityHash(randomIdentityDigits()), passwordHash: PASSWORD_HASH, guardianId: w.guardianId },
    });
    await db().studentGuardian.updateMany({
      where: { schoolId: w.school.id, guardianId: w.guardianId, endedAt: null },
      data: { canLogin: true },
    });
    return createSchoolSession(db(), w.school, { userId: user.id });
  }

  /** A pending deposit claim with its slip (the queue lists only those by default, R243). */
  async function claim(w: World, father: TestSchoolSession, studentId: bigint): Promise<string> {
    const upload = await h.http().post(`${API}/me/uploads`).set('Cookie', father.cookie).set('Origin', ORIGIN).attach('file', await png(), 'slip.png');
    expect(upload.status).toBe(201);
    const res = await post(
      `/me/children/${studentId}/payment-claims`,
      {
        method: 'bank_transfer',
        claimedAmount: 3000,
        paidOn: isoDay(0),
        reference: `TRX-${Math.floor(Math.random() * 1e9)}`,
        stagedUploadId: (upload.body as { id: string }).id,
      },
      father,
      newIdempotencyKey(),
    );
    if (res.status !== 201) throw new Error(`claim refused ${res.status}: ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  /** An expense above the 5,000 threshold recorded by the office: pending approval (R206). */
  async function pendingExpense(w: World, description = 'Roof repair'): Promise<string> {
    const res = await post(
      '/expenses',
      { category: 'repairs', amount: 6000, spentOn: isoDay(0), description, method: 'cash' },
      w.office,
      newIdempotencyKey(),
    );
    if (res.status !== 201) throw new Error(`expense refused ${res.status}: ${JSON.stringify(res.body)}`);
    expect((res.body as { status: string }).status).toBe('pending_approval');
    return (res.body as { id: string }).id;
  }

  /** A school with one row waiting in each of the four queues. */
  async function busySchool() {
    const w = await h.world();
    await db().schoolPaymentAccount.create({
      data: { schoolId: w.school.id, kind: 'bank', title: 'Iqra Model School', accountNo: 'PK36MEZN0001', bankName: 'Meezan Bank', createdBy: w.principal.user.userId },
    });
    const father = await fatherLogin(w);
    const claimId = await claim(w, father, w.a.studentId);
    await h.pay(w, w.office, { studentIds: [w.b.studentId], amount: 3000 });
    const handover = (await post('/me/staff/cash-handovers', {}, w.office).expect(201)).body as { id: string };
    const expenseId = await pendingExpense(w);
    const types = await page('/leave-types', w.teacher);
    const unpaid = (types.data as { id: string; code?: string }[]).find((t) => t.code === 'unpaid')!;
    const leave = await post(
      '/me/staff/leave-requests',
      { leaveTypeId: unpaid.id, startsOn: isoDay(1), endsOn: isoDay(7), reason: 'Family wedding' },
      w.teacher,
      newIdempotencyKey(),
    );
    if (leave.status !== 201) throw new Error(`leave refused ${leave.status}: ${JSON.stringify(leave.body)}`);
    return { w, father, claimId, handoverId: handover.id, expenseId, leaveId: (leave.body as { id: string }).id };
  }

  const ids = (s: Section | undefined) => (s?.items ?? []).map((i) => i.id);

  it('R227: the principal sees all four sections; each count is its queue\'s total and each item list its first page', async () => {
    const { w, claimId, handoverId, expenseId, leaveId } = await busySchool();
    const mine = await approvals(w.principal);
    expect(Object.keys(mine).sort()).toEqual(['claims', 'expenses', 'handovers', 'leave']);
    expect([ids(mine.claims), ids(mine.handovers), ids(mine.expenses), ids(mine.leave)]).toEqual([
      [claimId],
      [handoverId],
      [expenseId],
      [leaveId],
    ]);

    const queues = {
      claims: await page('/payment-claims?limit=10', w.principal),
      handovers: await page('/cash-handovers?status=open&limit=10', w.principal),
      expenses: await page('/expenses?status=pending_approval&limit=10', w.principal),
      leave: await page('/leave-requests?status=pending&limit=10', w.principal),
    };
    for (const key of ['claims', 'handovers', 'expenses', 'leave'] as const) {
      expect([key, mine[key]?.count]).toEqual([key, queues[key].total]);
      expect([key, ids(mine[key])]).toEqual([key, queues[key].data.map((r) => r.id)]);
    }

    // A decided row leaves its section: the principal confirms the handover.
    await post(`/cash-handovers/${handoverId}/confirm`, { countedAmount: 3000 }, w.principal).expect(200);
    expect((await approvals(w.principal)).handovers).toEqual({ count: 0, items: [] });
  });

  it('R227: a clerk granted payment.verify only sees claims; a teacher with none of the keys gets {}; a parent is refused', async () => {
    const { w, father, claimId } = await busySchool();
    const clerk = await h.signIn(w.school, 'office_staff');
    await h.grant(clerk.user, w.principal.user, Capability.PAYMENT_VERIFY);
    const clerks = await approvals(clerk);
    expect(Object.keys(clerks)).toEqual(['claims']);
    expect([clerks.claims?.count, ids(clerks.claims)]).toEqual([(await page('/payment-claims', clerk)).total, [claimId]]);

    // The office default holds none of the four keys.
    expect(await approvals(w.office)).toEqual({});
    expect(await approvals(w.teacher)).toEqual({});
    // A guardian-only session holds no staff capacity (R78).
    expect((await get('/me/approvals', father)).status).toBe(403);
  });

  it('R227: the same separation of duties as the queue: an own-family claim and an own expense stay listed, as in the queues', async () => {
    const { w, claimId } = await busySchool();
    const clerk = await h.signIn(w.school, 'office_staff');
    await h.grant(clerk.user, w.principal.user, Capability.PAYMENT_VERIFY);
    await h.grant(clerk.user, w.principal.user, Capability.EXPENSE_APPROVE);
    // The clerk is the child's mother (a live guardian link): own family (R197).
    const mother = await createGuardian(db(), w.school, { fullName: 'Amina Tariq', contactCapability: 'smartphone_data' });
    await linkGuardian(db(), w.school, { id: w.a.studentId }, { id: mother.id }, { relationship: 'mother', isPrimaryContact: false, isFeePayer: false });
    await db().user.updateMany({ where: { schoolId: w.school.id, id: clerk.user.userId }, data: { guardianId: mother.id } });
    const own = (
      await post('/expenses', { category: 'repairs', amount: 7000, spentOn: isoDay(0), description: 'Own expense', method: 'cash' }, clerk, newIdempotencyKey()).expect(201)
    ).body as { id: string; status: string };
    expect(own.status).toBe('pending_approval');

    const clerks = await approvals(clerk);
    expect(ids(clerks.claims)).toEqual([claimId]);
    expect(ids(clerks.expenses)).toContain(own.id);
    expect(clerks.expenses?.count).toBe((await page('/expenses?status=pending_approval', clerk)).total);
    // Listed, never decidable: the queue's own refusals stand.
    const refused = await post(`/payment-claims/${claimId}/verify`, {}, clerk);
    expect([refused.status, h.err(refused).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);
  });

  it('R227: first page of ten; the count is the whole queue', async () => {
    const w = await h.world();
    for (let i = 0; i < 11; i++) await pendingExpense(w, `Repair ${i}`);
    const mine = await approvals(w.principal);
    expect([mine.expenses?.count, mine.expenses?.items.length]).toEqual([11, 10]);
    const queue = await page('/expenses?status=pending_approval&limit=10', w.principal);
    expect(ids(mine.expenses)).toEqual(queue.data.map((r) => r.id));
  });

  it('R62, R227: another school\'s rows never appear', async () => {
    const one = await busySchool();
    const two = await busySchool();
    const a = await approvals(one.w.principal);
    const b = await approvals(two.w.principal);
    expect([ids(a.claims), ids(a.handovers), ids(a.expenses), ids(a.leave)]).toEqual([
      [one.claimId],
      [one.handoverId],
      [one.expenseId],
      [one.leaveId],
    ]);
    expect([ids(b.claims), ids(b.handovers), ids(b.expenses), ids(b.leave)]).toEqual([
      [two.claimId],
      [two.handoverId],
      [two.expenseId],
      [two.leaveId],
    ]);
    expect([a.claims?.count, a.handovers?.count, a.expenses?.count, a.leave?.count]).toEqual([1, 1, 1, 1]);
  });

  it('the dashboard tile: GET /expenses?selfApproved=true lists only self-approved expenses', async () => {
    const w = await h.world();
    const self = (
      await post('/expenses', { category: 'repairs', amount: 9000, spentOn: isoDay(0), description: 'Principal repair', method: 'cash' }, w.principal, newIdempotencyKey()).expect(201)
    ).body as { id: string; selfApproved: boolean; status: string };
    expect([self.status, self.selfApproved]).toEqual(['approved', true]);
    const other = await pendingExpense(w);
    expect((await page('/expenses?selfApproved=true', w.principal)).data.map((r) => r.id)).toEqual([self.id]);
    expect((await page('/expenses?selfApproved=false', w.principal)).data.map((r) => r.id)).toEqual([other]);
    expect((await page('/expenses', w.principal)).total).toBe(2);
  });

  it('the dashboard tile: selfApproved=true&decidedFrom=<first of month> counts by the decision day, voided ones too', async () => {
    const w = await h.world();
    const today = isoDay(0);
    const firstOfMonth = `${today.slice(0, 8)}01`;
    const lastMonth = new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const record = async (spentOn: string, amount: number): Promise<{ id: string; status: string; selfApproved: boolean }> =>
      (
        await post('/expenses', { category: 'repairs', amount, spentOn, description: `Principal ${amount}`, method: 'cash' }, w.principal, newIdempotencyKey()).expect(201)
      ).body as { id: string; status: string; selfApproved: boolean };
    // Recorded (and so self-approved) today, though spent last month: it counts this month.
    const backdated = await record(lastMonth, 9000);
    expect([backdated.status, backdated.selfApproved]).toEqual(['approved', true]);
    // Self-approved today, then voided: it still counts (the tile has no status filter).
    const voided = await record(today, 7000);
    await post(`/expenses/${voided.id}/void`, { reason: 'Entered twice' }, w.principal).expect(200);
    // Below the threshold: never decided, so never in a decided-day filter.
    await record(today, 1000);
    const tile = await page(`/expenses?selfApproved=true&decidedFrom=${firstOfMonth}&limit=1`, w.principal);
    expect(tile.total).toBe(2);
    const listed = await page(`/expenses?selfApproved=true&decidedFrom=${firstOfMonth}`, w.principal);
    expect(listed.data.map((r) => r.id).sort()).toEqual([backdated.id, voided.id].sort());
    // The spent-day filter would have missed the backdated one.
    expect((await page(`/expenses?selfApproved=true&spentFrom=${firstOfMonth}`, w.principal)).total).toBe(1);
    // decidedTo is inclusive of its whole day in school time; a day before today excludes both.
    expect((await page(`/expenses?decidedFrom=${today}&decidedTo=${today}`, w.principal)).total).toBe(2);
    expect((await page(`/expenses?decidedTo=${isoDay(-1)}`, w.principal)).total).toBe(0);
    expect((await page(`/expenses?decidedFrom=${isoDay(1)}`, w.principal)).total).toBe(0);
    await get('/expenses?decidedFrom=2026-13-01', w.principal).expect(422);
  });

  it('writes nothing: no audit row', async () => {
    const { w } = await busySchool();
    const before = await db().auditLog.count({ where: { schoolId: w.school.id } });
    await approvals(w.principal);
    expect(await db().auditLog.count({ where: { schoolId: w.school.id } })).toBe(before);
  });
});
