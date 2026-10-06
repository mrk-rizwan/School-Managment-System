// Control 4 / R62 for slice 20's repositories over the payment tables, and every raw statement of
// the two RAW_SQL_FILES slice 20 added (payment.repository.ts: the payment, advance and custody
// locks; receipt.repository.ts: the counter's upsert): run as school B against school A's ids, each
// reads nothing, locks nothing and writes nothing of school A.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { receiptCounterName } from '@asms/shared';
import { CashHandoverRepository } from '../../src/repositories/cash-handover.repository';
import { PaymentAllocationRepository } from '../../src/repositories/payment-allocation.repository';
import { PaymentReversalRepository } from '../../src/repositories/payment-reversal.repository';
import { PaymentRepository } from '../../src/repositories/payment.repository';
import { ReceiptRepository } from '../../src/repositories/receipt.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool, tx } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { closeTestDb } from '../support/schools';
import { db } from '../fees/charges-support';
import { paymentsHttp, type World } from './payments-support';

describe('slice 20 tenant isolation (repositories and raw statements)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);
  let payments: PaymentRepository;
  let allocations: PaymentAllocationRepository;
  let receipts: ReceiptRepository;
  let reversals: PaymentReversalRepository;
  let handovers: CashHandoverRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, () => tx.run(fn));

  beforeAll(async () => {
    app = await createTestApp();
    payments = app.get(PaymentRepository, { strict: false });
    allocations = app.get(PaymentAllocationRepository, { strict: false });
    receipts = app.get(ReceiptRepository, { strict: false });
    reversals = app.get(PaymentReversalRepository, { strict: false });
    handovers = app.get(CashHandoverRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** School A with a family, a payment leaving A an advance; school B with a family of its own. */
  async function twoSchools(): Promise<{ a: World; b: World; paymentId: bigint }> {
    const a = await h.world();
    const b = await h.world();
    const p = await h.pay(a, a.office, { studentIds: [a.a.studentId], amount: 7000 });
    return { a, b, paymentId: BigInt(p.id) };
  }

  it('payments: read, list, the payment, advance and custody locks and the counter reads see only their own school', async () => {
    const { a, b, paymentId } = await twoSchools();
    const B = b.school.id;
    await expectIsolated({ a: a.school, b: b.school }, {
      create: () => Promise.resolve(paymentId),
      read: (schoolId, id) => as(schoolId, () => payments.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => payments.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => payments.bindAdvance(schoolId, id, a.b.studentId)),
      snapshot: (row) => (row as { advanceForStudentId: bigint | null }).advanceForStudentId,
    });
    expect(await as(B, () => payments.lockForUpdate(B, [paymentId]))).toEqual([]);
    expect(await as(B, () => payments.lockAdvances(B, [a.a.studentId], a.year.id))).toEqual([]);
    expect(await as(B, () => payments.lockCustody(B, a.office.user.userId))).toEqual([]);
    expect(await as(B, () => payments.custody(B, a.office.user.userId))).toEqual({ cashInHand: 0, paymentCount: 0, since: null });
    expect(await as(B, () => payments.advances(B, [a.a.studentId]))).toEqual([]);
    expect(await as(B, () => payments.joinHandover(B, [paymentId], 1n))).toBe(0);
    expect(await as(B, () => payments.findGuardian(B, a.guardianId))).toBeNull();
    expect(await as(B, () => payments.linkedTo(B, a.guardianId, [a.a.studentId]))).toEqual(new Set());
    expect(await as(B, () => payments.receiptRecipients(B, [a.a.studentId]))).toEqual([]);
    // The merge-aware payer check (asms_user_is_guardian) reads only the caller's school.
    await db().user.updateMany({ where: { schoolId: a.school.id, id: a.office.user.userId }, data: { guardianId: a.guardianId } });
    expect(await as(a.school.id, () => payments.userIsGuardian(a.school.id, a.office.user.userId, a.guardianId))).toBe(true);
    expect(await as(B, () => payments.userIsGuardian(B, a.office.user.userId, a.guardianId))).toBe(false);
    expect((await as(B, () => payments.enrolmentsOf(B, [a.a.studentId]))).length).toBe(0);
    // School A's own locks still work.
    expect(await as(a.school.id, () => payments.lockForUpdate(a.school.id, [paymentId]))).toEqual([paymentId]);
    expect((await as(a.school.id, () => payments.lockAdvances(a.school.id, [a.a.studentId], a.year.id))).map((r) => r.paymentId)).toEqual([paymentId]);
  });

  it('payment_allocations: the live and per-payment reads and the reversal see only their own school', async () => {
    const { a, b, paymentId } = await twoSchools();
    const B = b.school.id;
    const live = await as(a.school.id, () => allocations.ofPayments(a.school.id, [paymentId]));
    expect(live.length).toBeGreaterThan(0);
    expect(await as(B, () => allocations.ofPayments(B, [paymentId]))).toEqual([]);
    expect(await as(B, () => allocations.liveOfCharges(B, live.map((l) => l.chargeId)))).toEqual([]);
    expect(await as(B, () => allocations.liveOfStudentYear(B, a.a.studentId, a.year.id))).toEqual([]);
    expect(await as(B, () => allocations.reverse(B, live.map((l) => l.id), new Date()))).toBe(0);
    expect(await db().paymentAllocation.count({ where: { schoolId: a.school.id, reversedAt: { not: null } } })).toBe(0);
  });

  it('receipts and receipt_lines: reads see only their own school; the counter upsert advances only the caller\'s', async () => {
    const { a, b, paymentId } = await twoSchools();
    const B = b.school.id;
    const [receipt] = await as(a.school.id, () => receipts.ofPayments(a.school.id, [paymentId]));
    expect(receipt?.lines.length).toBeGreaterThan(0);
    expect(await as(B, () => receipts.findById(B, receipt!.id))).toBeNull();
    expect(await as(B, () => receipts.ofPayments(B, [paymentId]))).toEqual([]);
    // B advancing a counter named for A's year writes B's own row, never A's.
    const before = await db().schoolCounter.findFirstOrThrow({ where: { schoolId: a.school.id, name: receiptCounterName(a.year.id) } });
    expect(await as(B, () => receipts.nextNumber(B, a.year.id))).toBe(1);
    const after = await db().schoolCounter.findFirstOrThrow({ where: { schoolId: a.school.id, name: receiptCounterName(a.year.id) } });
    expect(after.value).toBe(before.value);
  });

  it('payment_reversals: reads and the carry-forward link see only their own school', async () => {
    const { a, b, paymentId } = await twoSchools();
    const B = b.school.id;
    await h.post(`/payments/${paymentId}/refund`, { amount: 100, reason: 'Overpaid', method: 'cash' }, a.principal, 'refund-key-isolation-0001').expect(201);
    const [refund] = await as(a.school.id, () => reversals.ofPayments(a.school.id, [paymentId]));
    expect(await as(B, () => reversals.findById(B, refund!.id))).toBeNull();
    expect(await as(B, () => reversals.ofPayments(B, [paymentId]))).toEqual([]);
    expect(await as(B, () => reversals.linkCarriedTo(B, refund!.id, paymentId))).toBe(0);
  });

  it('cash_handovers: read, list, confirm and resolve see only their own school', async () => {
    const { a, b } = await twoSchools();
    await expectIsolated({ a: a.school, b: b.school }, {
      create: async () => BigInt(((await h.post('/me/staff/cash-handovers', {}, a.office).expect(201)).body as { id: string }).id),
      read: (schoolId, id) => as(schoolId, () => handovers.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => handovers.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) =>
        as(schoolId, () =>
          handovers.confirm(schoolId, id, { by: a.principal.user.userId, countedAmount: 0, shortfallAmount: 7000, surplusAmount: 0, note: null }, new Date()),
        ),
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(b.school.id, () => handovers.findOpenFor(b.school.id, a.office.user.userId))).toBeNull();
  });
});
