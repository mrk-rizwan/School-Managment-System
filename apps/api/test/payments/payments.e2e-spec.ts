// Slice 20 over HTTP (phase-3-financial.md slice 20, contracts/slice-20.md): the counter's dues,
// preview and record (R187-R190), receipts and their print view (R190, R237), voids, refunds and
// refund reversals (R191, R192), the carry-forward (R251), advances applied to new charges and
// credits beyond what is owed (R186, R189, A6), the own-child refusal (R232), the principal gate
// (R233), teachers (R234), closed years (R242) and the money identities of §0.20 (R228). The real
// AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import { Capability, ErrorCode, newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createAcademicYear, enrol, isoDay } from '../support/students';
import { classWithSection, db, karachi, lateFees, pupil, runMonth, structure } from '../fees/charges-support';
import { paymentsHttp, type Payment, type Reversal, type World } from './payments-support';

interface Preview {
  allocations: { chargeId: string; studentId: string; amount: number; fromAdvance: boolean; period: string | null }[];
  remainder: number;
  outstanding: number;
  advanceUsed: number;
}
interface Dues {
  guardianId: string;
  children: { studentId: string; academicYearId: string; outstanding: number; advance: number; openCharges: { id: string }[] }[];
}

describe('slice 20: payments, receipts, reversals over HTTP (e2e)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);
  const { get, post, err, pay } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const intent = (w: World, studentIds: bigint[], amount: number) => ({
    academicYearId: w.year.id.toString(),
    payerGuardianId: w.guardianId.toString(),
    studentIds: studentIds.map(String),
    amount,
  });

  // ------------------------------------------------------------------------------ counter

  it('R187-R190: the family dues, the preview, a payment over siblings oldest first, its receipt and a replay', async () => {
    const w = await h.world();
    const dues = (await get(`/guardians/${w.guardianId}/dues`, w.office).expect(200)).body as Dues;
    expect(dues.children.map((c) => [c.studentId, c.outstanding, c.advance, c.openCharges.length])).toEqual([
      [w.a.studentId.toString(), 6000, 0, 2],
      [w.b.studentId.toString(), 6000, 0, 2],
    ]);

    // Oldest due first across exactly the named children; ties by charge id.
    const [aSep, aOct] = await h.charges(w, w.a.studentId);
    const [bSep, bOct] = await h.charges(w, w.b.studentId);
    const preview = (await post('/payments/preview', intent(w, [w.a.studentId, w.b.studentId], 7000), w.office).expect(200)).body as Preview;
    const byId = (x: bigint, y: bigint) => (x < y ? -1 : 1);
    const septembers = [aSep!.id, bSep!.id].sort(byId).map(String);
    const octobers = [aOct!.id, bOct!.id].sort(byId).map(String);
    expect(preview.allocations.map((a) => [a.chargeId, a.amount, a.fromAdvance])).toEqual([
      [septembers[0], 3000, false],
      [septembers[1], 3000, false],
      [octobers[0], 1000, false],
    ]);
    expect([preview.remainder, preview.outstanding, preview.advanceUsed]).toEqual([0, 12000, 0]);
    // Only the named child: B alone never pays A's charges.
    const onlyB = (await post('/payments/preview', intent(w, [w.b.studentId], 9000), w.office).expect(200)).body as Preview;
    expect(onlyB.allocations.every((a) => a.studentId === w.b.studentId.toString())).toBe(true);
    expect(onlyB.remainder).toBe(3000);

    const key = newIdempotencyKey();
    const first = await pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 7000 }, key);
    expect([first.amount, first.allocatedAmount, first.unallocatedAmount, first.status, first.method]).toEqual([7000, 7000, 0, 'verified', 'cash']);
    expect(first.receipt?.receiptNo).toBe(1);
    expect(first.receipt?.receiptLabel).toBe(`1/${w.yearName}`);
    expect(first.receipt?.lines.reduce((s, l) => s + l.amount, 0)).toBe(7000);
    expect(first.payerName).toBe('Tariq Mehmood');
    // A replay (double click) answers the same payment and receipt, and writes nothing.
    const replay = await post(
      '/payments',
      { ...intent(w, [w.a.studentId, w.b.studentId], 7000), method: 'cash', receivedOn: isoDay(0) },
      w.office,
      key,
    ).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as Payment).id).toBe(first.id);
    expect(await db().payment.count({ where: { schoolId: w.school.id } })).toBe(1);
    expect((await h.audit(w.school, 'payment.recorded')).map((r) => r.actorUserId)).toEqual([w.office.user.userId]);

    // receipt_issued to the keypad fee-payer, by SMS; the amounts in the body, never a link.
    const messages = await db().message.findMany({ where: { schoolId: w.school.id, type: 'receipt_issued' } });
    expect(messages.map((m) => [m.subjectType, m.subjectId.toString(), m.guardianId])).toEqual([
      ['receipt', first.receipt?.id, w.guardianId],
    ]);
    expect(messages[0]?.channelPlan).toContain('sms');
    expect(messages[0]?.body).toContain(`Receipt 1/${w.yearName}: Rs 7,000 received for`);
    expect(messages[0]?.body).toContain('Balance for');
    expect(messages[0]?.body).toContain('Rs 5,000');
    expect(messages[0]?.body).not.toMatch(/https?:/);

    // The rest and an advance: two children, so the advance names its child.
    const ambiguous = await post(
      '/payments',
      { ...intent(w, [w.a.studentId, w.b.studentId], 6000), method: 'cash', receivedOn: isoDay(0) },
      w.office,
      newIdempotencyKey(),
    );
    expect([ambiguous.status, err(ambiguous).error.details?.fields?.[0]?.path]).toEqual([422, 'advanceForStudentId']);
    const second = await pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 6000, advanceForStudentId: w.a.studentId });
    expect([second.allocatedAmount, second.unallocatedAmount, second.advanceForStudentId, second.receipt?.receiptNo]).toEqual([
      5000, 1000, w.a.studentId.toString(), 2,
    ]);
    expect(second.receipt?.lines.find((l) => l.chargeId === null)).toMatchObject({ studentId: w.a.studentId.toString(), amount: 1000, feeHeadName: null });
    expect((await h.charges(w, w.a.studentId)).every((c) => c.status === 'settled')).toBe(true);

    // Nothing owed: refused unless the child of the advance is named.
    const nothing = await post(
      '/payments',
      { ...intent(w, [w.b.studentId], 500), method: 'cash', receivedOn: isoDay(0) },
      w.office,
      newIdempotencyKey(),
    );
    expect([nothing.status, err(nothing).error.code]).toEqual([409, ErrorCode.PAYMENT_NOTHING_DUE]);

    // The dues screen and the statement show the advance; the statement lists both payments.
    const after = (await get(`/guardians/${w.guardianId}/dues`, w.office).expect(200)).body as Dues;
    expect(after.children.map((c) => [c.outstanding, c.advance])).toEqual([[0, 1000], [0, 0]]);
    const statement = (await get(`/students/${w.a.studentId}/fee-statement`, w.office).expect(200)).body as {
      payments: { paymentId: string; receiptLabel: string; allocated: number; amount: number }[];
      totals: { paid: number; outstanding: number; advance: number };
    };
    expect(statement.payments.map((p) => [p.paymentId, p.allocated])).toEqual([[first.id, 4000], [second.id, 2000]]);
    expect(statement.totals).toMatchObject({ paid: 6000, outstanding: 0, advance: 1000 });

    // A manual charge for A is paid from A's advance at once (R189).
    const manual = await post(
      '/charges',
      { enrolmentId: w.a.enrolmentId.toString(), feeHeadId: w.heads.fine.toString(), amount: 400, dueOn: isoDay(5), description: 'Library fine' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    expect((manual.body as { status: string; allocatedAmount: number }).status).toBe('settled');
    expect((await get(`/payments/${second.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 600 });
    expect((await h.audit(w.school, 'charge.created'))[0]?.metadata).toMatchObject({ advanceApplied: 400 });

    // Lists and the receipt.
    const page = (await get(`/payments?studentId=${w.a.studentId}`, w.office).expect(200)).body as { data: Payment[]; total: number };
    expect(page.total).toBe(2);
    const receipt = (await get(`/receipts/${first.receipt?.id}`, w.office).expect(200)).body as { receiptLabel: string };
    expect(receipt.receiptLabel).toBe(`1/${w.yearName}`);
  });

  it('R187: the payer, the links, the reference, the year and the walk-in rules; R249 a reused slip is flagged', async () => {
    const w = await h.world();
    const other = await pupil(w.school, w.section, { startedOn: '2026-04-01', fullName: 'Outsider' });
    const base = { method: 'cash', receivedOn: isoDay(0) };
    const refused = async (body: object) => {
      const res = await post('/payments', body, w.office, newIdempotencyKey());
      return [res.status, err(res).error.code, err(res).error.details?.fields?.[0]?.path ?? null];
    };
    // A child not linked to the paying guardian.
    expect(await refused({ ...intent(w, [w.a.studentId, other.studentId], 1000), ...base })).toEqual([422, ErrorCode.VALIDATION_FAILED, 'studentIds[1]']);
    // Both payers, or a walk-in naming two children.
    expect(await refused({ ...intent(w, [w.a.studentId], 1000), payerName: 'Uncle', ...base })).toEqual([422, ErrorCode.VALIDATION_FAILED, 'payerGuardianId']);
    expect(
      await refused({ academicYearId: w.year.id.toString(), payerName: 'Uncle', studentIds: [String(w.a.studentId), String(w.b.studentId)], amount: 1000, ...base }),
    ).toEqual([422, ErrorCode.VALIDATION_FAILED, 'studentIds']);
    // A bank payment without its slip's reference; a future day; carried_forward at the counter.
    expect(await refused({ ...intent(w, [w.a.studentId], 1000), method: 'bank_transfer', receivedOn: isoDay(0) })).toEqual([422, ErrorCode.VALIDATION_FAILED, 'reference']);
    expect(await refused({ ...intent(w, [w.a.studentId], 1000), method: 'cash', receivedOn: isoDay(2) })).toEqual([422, ErrorCode.VALIDATION_FAILED, 'receivedOn']);
    expect(await refused({ ...intent(w, [w.a.studentId], 1000), method: 'carried_forward', receivedOn: isoDay(0) })).toEqual([422, ErrorCode.VALIDATION_FAILED, 'method']);
    // A child with no enrolment in the payment's year: one academic year per payment.
    const later = await createAcademicYear(db(), w.school, { name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' });
    expect(await refused({ ...intent(w, [w.a.studentId], 1000), academicYearId: later.id.toString(), ...base })).toEqual([409, ErrorCode.PAYMENT_SPANS_YEARS, null]);

    // A walk-in pays for one child.
    const walkIn = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000, payerName: 'Uncle Bashir' });
    expect([walkIn.payerName, walkIn.allocatedAmount]).toEqual(['Uncle Bashir', 3000]);

    // R249: the same bank slip twice is recorded and flagged, never refused.
    const slip = await pay(w, w.office, { studentIds: [w.b.studentId], amount: 1000, method: 'bank_transfer', reference: 'MCB-778812' });
    const again = await pay(w, w.office, { studentIds: [w.b.studentId], amount: 1000, method: 'bank_transfer', reference: 'MCB-778812' });
    expect([slip.possibleDuplicate, again.possibleDuplicate, again.duplicateOfPaymentId]).toEqual([false, true, slip.id]);
    expect((await get(`/payments/${slip.id}`, w.office).expect(200)).body).toMatchObject({ possibleDuplicate: true, duplicateOfPaymentId: again.id });
  });

  it('R237: the receipt prints through sendPrintView, every value escaped', async () => {
    const w = await h.world();
    const head = await db().feeHead.create({
      data: { schoolId: w.school.id, name: '<script>alert(1)</script>', category: 'other', frequency: 'ad_hoc', concessionEligible: true, refundable: true },
    });
    await post(
      '/charges',
      { enrolmentId: w.a.enrolmentId.toString(), feeHeadId: head.id.toString(), amount: 250, dueOn: isoDay(0), description: 'Trip' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    const payment = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 6250 });
    const res = await get(`/receipts/${payment.receipt?.id}/print`, w.office).expect(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect([res.headers['x-content-type-options'], res.headers['cache-control'], res.headers['content-disposition']]).toEqual(['nosniff', 'no-store', 'inline']);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).toContain(`Fee receipt 1/${w.yearName}`);
    // Wave N review: a cross-site browser request is refused; the app's own tab and a typed address print.
    const path = `/receipts/${payment.receipt?.id}/print`;
    for (const site of ['cross-site', 'same-site']) {
      const refused = await get(path, w.office).set('Sec-Fetch-Site', site).expect(403);
      expect(refused.body).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    }
    for (const site of ['same-origin', 'none']) await get(path, w.office).set('Sec-Fetch-Site', site).expect(200);
  });

  // ------------------------------------------------------------------------- reversals

  it('R191: a void by a non-recorder reopens exactly the charges, voids the receipt and keeps its number', async () => {
    const w = await h.world();
    const before = await h.charges(w, w.a.studentId);
    const p1 = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 });
    const p2 = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 });
    // The office holds no payment.void; the recorder never voids their own.
    expect((await post(`/payments/${p1.id}/void`, { reason: 'Mistyped' }, w.office)).status).toBe(403);
    const own = await pay(w, w.principal, { studentIds: [w.b.studentId], amount: 3000 });
    const self = await post(`/payments/${own.id}/void`, { reason: 'Mistyped' }, w.principal);
    expect([self.status, err(self).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);

    const voided = (await post(`/payments/${p1.id}/void`, { reason: 'Wrong family' }, w.principal).expect(200)).body as Payment;
    expect([voided.status, voided.allocatedAmount, voided.receipt?.receiptNo, voided.receipt?.voidedAt !== null]).toEqual(['voided', 0, 1, true]);
    const charges = await h.charges(w, w.a.studentId);
    // p1 paid September; it reopens; October (p2) stays settled.
    expect(charges.map((c) => [c.id, c.status, c.allocatedAmount])).toEqual([
      [before[0]!.id, 'open', 0],
      [before[1]!.id, 'settled', 3000],
    ]);
    const again = await post(`/payments/${p1.id}/void`, { reason: 'Again' }, w.principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.PAYMENT_VOIDED]);
    expect((await h.audit(w.school, 'payment.voided')).map((r) => r.actorUserId)).toEqual([w.principal.user.userId]);
    // The next payment takes number 4: a voided receipt keeps its number, never reused.
    const next = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 });
    expect(next.receipt?.receiptNo).toBe(4);
    expect(p2.receipt?.receiptNo).toBe(2);
  });

  it('R192, R233: refunds of the advance only, by a principal; a refund reversal; a void waits for both', async () => {
    const w = await h.world();
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 8000 });
    expect(p.unallocatedAmount).toBe(2000);
    const key = () => newIdempotencyKey();
    // payment.void by grant reaches the route but never the principal gate.
    await h.grant(w.office.user, w.principal.user, Capability.PAYMENT_VOID);
    const clerk = await post(`/payments/${p.id}/refund`, { amount: 500, reason: 'Leaving', method: 'cash' }, w.office, key());
    expect([clerk.status, err(clerk).error.details?.reason]).toEqual([403, 'principal_required']);
    const tooMuch = await post(`/payments/${p.id}/refund`, { amount: 2500, reason: 'Leaving', method: 'cash' }, w.principal, key());
    expect([tooMuch.status, err(tooMuch).error.code]).toEqual([409, ErrorCode.REFUND_EXCEEDS_UNALLOCATED]);
    const refund = (await post(`/payments/${p.id}/refund`, { amount: 1500, reason: 'Leaving the school', method: 'cash' }, w.principal, key()).expect(201)).body as Reversal;
    expect([refund.kind, refund.amount]).toEqual(['refund', 1500]);
    expect((await get(`/payments/${p.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 500 });
    // A void waits while a refund stands.
    const blocked = await post(`/payments/${p.id}/void`, { reason: 'Wrong' }, w.principal);
    expect([blocked.status, err(blocked).error.code]).toEqual([409, ErrorCode.PAYMENT_HAS_REFUND]);
    const back = (await post(`/payments/${p.id}/reverse-refund`, { reversalId: refund.id, reason: 'Not leaving after all' }, w.principal, key()).expect(201)).body as Reversal;
    expect([back.kind, back.reversesId, back.amount]).toEqual(['refund_reversal', refund.id, 1500]);
    expect((await get(`/payments/${p.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 2000 });
    const twice = await post(`/payments/${p.id}/reverse-refund`, { reversalId: refund.id, reason: 'Again' }, w.principal, key());
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    // With the refund reversed, the void goes through.
    await post(`/payments/${p.id}/void`, { reason: 'Wrong family after all' }, w.principal).expect(200);
    for (const action of ['payment.refunded', 'payment.refund_reversed']) {
      expect((await h.audit(w.school, action)).map((r) => r.actorUserId)).toEqual([w.principal.user.userId]);
    }
  });

  it('R232: nobody records, voids or refunds money for their own child (no sole-principal exception for cash)', async () => {
    const w = await h.world();
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 7000 });
    await h.parentOf(w, w.office.user, w.a);
    const preview = await post('/payments/preview', intent(w, [w.a.studentId], 1000), w.office);
    expect([preview.status, err(preview).error.details?.reason]).toEqual([409, 'own_child']);
    const record = await post('/payments', { ...intent(w, [w.a.studentId], 1000), method: 'cash', receivedOn: isoDay(0) }, w.office, newIdempotencyKey());
    expect([record.status, err(record).error.code, err(record).error.details?.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'own_child']);
    // The school's only principal, for their own child: still refused.
    await db().user.updateMany({ where: { schoolId: w.school.id, id: w.office.user.userId }, data: { guardianId: null } });
    await h.parentOf(w, w.principal.user, w.a);
    for (const res of [
      await post(`/payments/${p.id}/void`, { reason: 'Mine' }, w.principal),
      await post(`/payments/${p.id}/refund`, { amount: 100, reason: 'Mine', method: 'cash' }, w.principal, newIdempotencyKey()),
    ]) {
      expect([res.status, err(res).error.details?.reason]).toEqual([409, 'own_child']);
    }
  });

  it('R234: a teacher reaches no payment, receipt, dues or handover route', async () => {
    const w = await h.world();
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 });
    for (const path of ['/payments', `/payments/${p.id}`, `/receipts/${p.receipt?.id}`, `/receipts/${p.receipt?.id}/print`, `/guardians/${w.guardianId}/dues`, '/cash-handovers']) {
      expect([path, (await get(path, w.teacher)).status]).toEqual([path, 403]);
    }
    expect((await post('/payments/preview', intent(w, [w.a.studentId], 100), w.teacher)).status).toBe(403);
    expect((await post('/payments', { ...intent(w, [w.a.studentId], 100), method: 'cash', receivedOn: isoDay(0) }, w.teacher, newIdempotencyKey())).status).toBe(403);
    // Another school's payment is 404.
    const other = await h.world();
    expect((await get(`/payments/${p.id}`, other.office)).status).toBe(404);
    expect((await get(`/guardians/${w.guardianId}/dues`, other.office)).status).toBe(404);
  });

  // ------------------------------------------------------------------- advances and credits

  it('R186, A6: a credit beyond what is owed de-allocates the newest allocations into an advance; Σcredit = Δoutstanding + Δunallocated', async () => {
    const w = await h.world();
    const [sep, oct] = await h.charges(w, w.a.studentId);
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 5000 });
    // September settled (3,000), October 2,000 of 3,000.
    const owedBefore = 1000;
    const credit = (chargeId: bigint, amount: number) =>
      post(`/charges/${chargeId}/adjust`, { amount, reason: 'Fee reduced' }, w.principal, newIdempotencyKey());
    await credit(oct!.id, 1500).expect(201);
    const octAfter = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: oct!.id } });
    const payAfter = await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(p.id) } });
    expect([octAfter.status, octAfter.allocatedAmount, octAfter.creditedAmount]).toEqual(['settled', 1500, 1500]);
    expect([payAfter.unallocatedAmount, payAfter.advanceForStudentId]).toEqual([500, w.a.studentId]);
    expect(1500).toBe(owedBefore + (payAfter.unallocatedAmount - 0));
    // A settled charge may be credited too: September, 1,000, all of it into the advance.
    await credit(sep!.id, 1000).expect(201);
    const sepAfter = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: sep!.id } });
    expect([sepAfter.status, sepAfter.allocatedAmount, sepAfter.creditedAmount]).toEqual(['settled', 2000, 1000]);
    expect((await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(p.id) } })).unallocatedAmount).toBe(1500);
    // Live allocations + unallocated = amount on the payment, after both credits.
    const live = await db().paymentAllocation.aggregate({ where: { schoolId: w.school.id, paymentId: BigInt(p.id), reversedAt: null }, _sum: { amount: true } });
    expect((live._sum.amount ?? 0) + 1500).toBe(5000);
    // More than the charge holds: refused, nothing changes.
    const tooMuch = await credit(sep!.id, 2500);
    expect([tooMuch.status, err(tooMuch).error.code, err(tooMuch).error.details?.reason]).toEqual([409, ErrorCode.CHARGE_NOT_OPEN, 'exceeds_outstanding']);
    expect((await h.audit(w.school, 'charge.adjusted')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ amount: 1500, outstandingBefore: 1000, deallocated: 500 }),
      expect.objectContaining({ amount: 1000, outstandingBefore: 0, deallocated: 1000 }),
    ]);
  });

  it('R186: an admission-head allocation is never turned into an advance', async () => {
    const w = await h.world();
    await structure(w.school, { academicYearId: w.year.id, classId: w.classId, feeHeadId: w.heads.admission, amount: 10000, effectiveFrom: '2026-04' }, w.principal.user.userId);
    const admission = await post(
      '/charges',
      { enrolmentId: w.a.enrolmentId.toString(), feeHeadId: w.heads.admission.toString(), amount: 10000, dueOn: isoDay(0), description: 'Admission' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    await pay(w, w.office, { studentIds: [w.a.studentId], amount: 16000 });
    const res = await post(`/charges/${(admission.body as { id: string }).id}/adjust`, { amount: 2000, reason: 'Discount' }, w.principal, newIdempotencyKey());
    expect([res.status, err(res).error.details?.reason]).toEqual([409, 'exceeds_outstanding']);
  });

  it('R189: an advance pays the next generated charge and a late fee, oldest first, audited as the system', async () => {
    const w = await h.world();
    // September and October paid, and 5,000 more as A's advance.
    await pay(w, w.office, { studentIds: [w.a.studentId], amount: 11000 });
    const advance = await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id } });
    expect(advance.unallocatedAmount).toBe(5000);
    // August is generated late (a requested run): the advance pays it.
    await runMonth(app, w.school, w.year, '2026-08', karachi('2026-10-02'));
    const aug = (await h.charges(w, w.a.studentId)).find((c) => c.period === '2026-08');
    expect([aug?.status, aug?.allocatedAmount]).toEqual(['settled', 3000]);
    expect((await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: advance.id } })).unallocatedAmount).toBe(2000);
    const system = await h.audit(w.school, 'charge.advance_applied');
    expect(system.map((r) => [r.actorUserId, (r.metadata as { amount: number }).amount])).toEqual([[null, 3000]]);

    // B owes August to October and holds a 1,000 advance (an advance-only payment). Late fees on:
    // the sweep charges B one for September, and B's advance then pays B's oldest charge.
    const bAdvance = await db().payment.create({
      data: {
        schoolId: w.school.id,
        academicYearId: w.year.id,
        payerGuardianId: w.guardianId,
        method: 'cash',
        amount: 1000,
        receivedOn: new Date('2026-09-20T00:00:00Z'),
        recordedBy: w.office.user.userId,
        verifiedBy: w.office.user.userId,
        advanceForStudentId: w.b.studentId,
      },
    });
    await db().schoolSettings.update({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: new Date('2026-08-01T00:00:00Z') },
    });
    expect(await lateFees(app, w.school, karachi('2026-10-06'))).toBe(1);
    const bCharges = await h.charges(w, w.b.studentId);
    const bSep = bCharges.find((c) => c.period === '2026-09' && c.kind === 'generated');
    expect([bSep?.allocatedAmount, bCharges.find((c) => c.kind === 'late_fee')?.status]).toEqual([1000, 'open']);
    expect((await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: bAdvance.id } })).unallocatedAmount).toBe(0);
    expect((await h.audit(w.school, 'charge.advance_applied')).map((r) => (r.metadata as { job: string; amount: number }))).toEqual([
      expect.objectContaining({ job: 'charge-generate', amount: 3000 }),
      expect.objectContaining({ job: 'late-fee-sweep', amount: 1000 }),
    ]);
  });

  // ---------------------------------------------------------------------- carry-forward

  it('R251, R242: a closed year accepts a payment and a void; its advance is carried forward into the next year', async () => {
    const w = await h.world();
    const last = await createAcademicYear(db(), w.school, { name: '2025-26', startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'active' });
    const old = await classWithSection(w.school, last, 'Class 4');
    await enrol(db(), w.school, { id: w.a.studentId }, old.section, { startedOn: '2025-04-01', status: 'left', endedOn: '2026-03-31' });
    await db().charge.create({
      data: {
        schoolId: w.school.id,
        enrolmentId: (await db().enrolment.findFirstOrThrow({ where: { schoolId: w.school.id, studentId: w.a.studentId, academicYearId: last.id } })).id,
        studentId: w.a.studentId,
        academicYearId: last.id,
        feeHeadId: w.heads.tuition,
        headFrequency: 'monthly',
        kind: 'manual',
        grossAmount: 2000,
        concessionAmount: 0,
        amount: 2000,
        description: 'March arrears',
        dueOn: new Date('2026-03-10T00:00:00Z'),
      },
    });
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: last.id }, data: { status: 'closed' } });
    // R242: the closed year takes the arrears and an advance, with its own counter.
    const arrears = (await post(
      '/payments',
      { ...intent(w, [w.a.studentId], 4500), academicYearId: last.id.toString(), method: 'cash', receivedOn: isoDay(0) },
      w.office,
      newIdempotencyKey(),
    ).expect(201)).body as Payment;
    expect([arrears.allocatedAmount, arrears.unallocatedAmount, arrears.receipt?.receiptNo, arrears.receipt?.receiptLabel]).toEqual([2000, 2500, 1, '1/2025-26']);

    // Carried into 2026-27: a reversal plus a carried_forward payment, which pays A's dues there.
    const key = newIdempotencyKey();
    const carried = await post(`/payments/${arrears.id}/carry-forward`, { academicYearId: w.year.id.toString(), reason: 'Year end' }, w.office, key).expect(201);
    const body = carried.body as { reversal: Reversal; payment: Payment };
    expect([body.reversal.kind, body.reversal.amount, body.reversal.carriedToPaymentId]).toEqual(['carried_forward', 2500, body.payment.id]);
    expect([body.payment.method, body.payment.academicYearId, body.payment.amount, body.payment.allocatedAmount, body.payment.receipt]).toEqual([
      'carried_forward', w.year.id.toString(), 2500, 2500, null,
    ]);
    expect((await get(`/payments/${arrears.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 0 });
    const replay = await post(`/payments/${arrears.id}/carry-forward`, { academicYearId: w.year.id.toString(), reason: 'Year end' }, w.office, key).expect(200);
    expect((replay.body as { payment: Payment }).payment.id).toBe(body.payment.id);
    const empty = await post(`/payments/${arrears.id}/carry-forward`, { academicYearId: w.year.id.toString(), reason: 'Again' }, w.office, newIdempotencyKey());
    expect([empty.status, err(empty).error.code]).toEqual([409, ErrorCode.NOTHING_TO_CARRY_FORWARD]);
    // A carry-forward stands: the source cannot be voided; the carried payment is never voided.
    const voidSource = await post(`/payments/${arrears.id}/void`, { reason: 'Wrong' }, w.principal);
    expect([voidSource.status, err(voidSource).error.code]).toEqual([409, ErrorCode.PAYMENT_HAS_REFUND]);
    const voidCarried = await post(`/payments/${body.payment.id}/void`, { reason: 'Wrong' }, w.principal);
    expect([voidCarried.status, err(voidCarried).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    expect((await h.audit(w.school, 'payment.carried_forward')).map((r) => r.actorUserId)).toEqual([w.office.user.userId]);

    // R242: a void in the closed year.
    const second = (await post(
      '/payments',
      { ...intent(w, [w.a.studentId], 100), academicYearId: last.id.toString(), method: 'cash', receivedOn: isoDay(0), advanceForStudentId: w.a.studentId.toString() },
      w.office,
      newIdempotencyKey(),
    ).expect(201)).body as Payment;
    expect(second.receipt?.receiptNo).toBe(2);
    await post(`/payments/${second.id}/void`, { reason: 'Mistyped' }, w.principal).expect(200);
  });

  it('G1: a carry-forward is undone while its carried payment is untouched; never once it has paid a charge', async () => {
    const w = await h.world();
    const last = await createAcademicYear(db(), w.school, { name: '2025-26', startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'active' });
    const old = await classWithSection(w.school, last, 'Class 4');
    await enrol(db(), w.school, { id: w.a.studentId }, old.section, { startedOn: '2025-04-01', status: 'left', endedOn: '2026-03-31' });
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: last.id }, data: { status: 'closed' } });
    const advance = (await post(
      '/payments',
      { ...intent(w, [w.a.studentId], 2500), academicYearId: last.id.toString(), method: 'cash', receivedOn: isoDay(0), advanceForStudentId: w.a.studentId.toString() },
      w.office,
      newIdempotencyKey(),
    ).expect(201)).body as Payment;
    expect(advance.unallocatedAmount).toBe(2500);
    // A owes nothing in 2026-27, so the carried payment stays wholly unallocated.
    await pay(w, w.office, { studentIds: [w.a.studentId], amount: 6000 });
    const carried = (await post(`/payments/${advance.id}/carry-forward`, { academicYearId: w.year.id.toString(), reason: 'Year end' }, w.office, newIdempotencyKey()).expect(201))
      .body as { reversal: Reversal; payment: Payment };
    expect([carried.payment.allocatedAmount, carried.payment.unallocatedAmount]).toEqual([0, 2500]);

    // A reversal id that is not a carry-forward of this payment.
    const wrong = await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: '999999999', reason: 'Mistake' }, w.office, newIdempotencyKey());
    expect([wrong.status, err(wrong).error.code]).toEqual([422, ErrorCode.VALIDATION_FAILED]);
    // payment.record, as the carry-forward: a teacher is refused.
    const teacher = await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: carried.reversal.id, reason: 'Mistake' }, w.teacher, newIdempotencyKey());
    expect(teacher.status).toBe(403);

    const key = newIdempotencyKey();
    const undone = (await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: carried.reversal.id, reason: 'Carried into the wrong year' }, w.office, key).expect(201))
      .body as Reversal;
    expect([undone.kind, undone.reversesId, undone.amount, undone.paymentId]).toEqual(['carry_forward_reversal', carried.reversal.id, 2500, advance.id]);
    // The advance is back in its year; the carried payment is voided; every row stays (rule 4).
    expect((await get(`/payments/${advance.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 2500, status: 'verified' });
    expect((await get(`/payments/${carried.payment.id}`, w.office).expect(200)).body).toMatchObject({ status: 'voided', unallocatedAmount: 2500 });
    const source = (await get(`/payments/${advance.id}`, w.office).expect(200)).body as Payment;
    expect(source.reversals.map((r) => [r.kind, r.reversed])).toEqual([
      ['carried_forward', true],
      ['carry_forward_reversal', false],
    ]);
    // A replay answers the same row; a second undo is refused.
    const replay = await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: carried.reversal.id, reason: 'Carried into the wrong year' }, w.office, key).expect(200);
    expect((replay.body as Reversal).id).toBe(undone.id);
    const again = await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: carried.reversal.id, reason: 'Again' }, w.office, newIdempotencyKey());
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    expect((await h.audit(w.school, 'payment.carry_forward_reversed')).map((r) => [r.actorUserId, (r.metadata as { carriedPaymentId: string }).carriedPaymentId])).toEqual([
      [w.office.user.userId, carried.payment.id],
    ]);

    // Carried again; November's tuition is generated and the carried advance pays it: no undo now.
    const second = (await post(`/payments/${advance.id}/carry-forward`, { academicYearId: w.year.id.toString(), reason: 'Year end' }, w.office, newIdempotencyKey()).expect(201))
      .body as { reversal: Reversal; payment: Payment };
    await runMonth(app, w.school, w.year, '2026-11', karachi('2026-11-01'));
    expect((await get(`/payments/${second.payment.id}`, w.office).expect(200)).body).toMatchObject({ unallocatedAmount: 0 });
    const spent = await post(`/payments/${advance.id}/carry-forward/undo`, { reversalId: second.reversal.id, reason: 'Too late' }, w.office, newIdempotencyKey());
    expect([spent.status, err(spent).error.code, (err(spent).error.details as { reason: string }).reason]).toEqual([
      409,
      ErrorCode.ILLEGAL_STATUS_TRANSITION,
      'carried_spent',
    ]);
    // The database refuses it too, whatever the service checks (payment_reversals_carried_spent).
    await expect(
      db().paymentReversal.create({
        data: {
          schoolId: w.school.id, paymentId: BigInt(advance.id), academicYearId: last.id, kind: 'carry_forward_reversal',
          reversesId: BigInt(second.reversal.id), amount: 2500, reason: 'Direct', requestedBy: w.office.user.userId,
        },
      }),
    ).rejects.toThrow(/payment_reversals_carried_spent/);
  });

  // ------------------------------------------------------------------------ identities

  it('R228 (§0.20): after a scripted day every payment balances and the cash reconciles', async () => {
    const w = await h.world();
    const p1 = await pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 9000, advanceForStudentId: w.b.studentId });
    const p2 = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 5000, advanceForStudentId: w.a.studentId });
    const p3 = await pay(w, w.office, { studentIds: [w.b.studentId], amount: 2000, method: 'jazzcash', reference: 'JC-1' });
    await post(`/payments/${p2.id}/refund`, { amount: 500, reason: 'Overpaid', method: 'cash' }, w.principal, newIdempotencyKey()).expect(201);
    await post(`/payments/${p3.id}/void`, { reason: 'Bounced' }, w.principal).expect(200);
    const [aSep] = await h.charges(w, w.a.studentId);
    await post(`/charges/${aSep!.id}/adjust`, { amount: 1000, reason: 'Sibling discount' }, w.principal, newIdempotencyKey()).expect(201);
    await post('/me/staff/cash-handovers', {}, w.office).expect(201);

    const payments = await db().payment.findMany({ where: { schoolId: w.school.id } });
    for (const p of payments.filter((x) => x.status === 'verified')) {
      const live = await db().paymentAllocation.aggregate({ where: { schoolId: w.school.id, paymentId: p.id, reversedAt: null }, _sum: { amount: true } });
      const rev = await db().paymentReversal.findMany({ where: { schoolId: w.school.id, paymentId: p.id } });
      const net = rev.reduce((s, r) => s + (r.kind === 'refund_reversal' || r.kind === 'carry_forward_reversal' ? -r.amount : r.kind === 'void' ? 0 : r.amount), 0);
      expect([p.id, (live._sum.amount ?? 0) + net + p.unallocatedAmount]).toEqual([p.id, p.amount]);
    }
    // Outstanding = Σ amount − allocated − credited over open charges, one function everywhere.
    const open = await db().charge.findMany({ where: { schoolId: w.school.id, status: 'open' } });
    const dues = (await get(`/guardians/${w.guardianId}/dues`, w.office).expect(200)).body as Dues;
    expect(dues.children.reduce((s, c) => s + c.outstanding, 0)).toBe(open.reduce((s, c) => s + c.amount - c.allocatedAmount - c.creditedAmount, 0));
    // Cash: payments − voids before handover = with collectors + handed over.
    const cash = payments.filter((p) => p.method === 'cash');
    const handedOver = await db().cashHandover.aggregate({ where: { schoolId: w.school.id }, _sum: { expectedAmount: true } });
    const inHand = cash.filter((p) => p.status === 'verified' && p.handoverId === null).reduce((s, p) => s + p.amount, 0);
    const voidedBefore = cash.filter((p) => p.status === 'voided' && p.handoverId === null).reduce((s, p) => s + p.amount, 0);
    expect(cash.reduce((s, p) => s + p.amount, 0) - voidedBefore).toBe(inHand + (handedOver._sum.expectedAmount ?? 0));
    expect([p1.unallocatedAmount, inHand]).toEqual([0, 0]);
  });

  // ---------------------------------------------------------------------- review fixes

  /** An advance-only payment of `amount` for `child`, recorded by `by` (no charge paid yet). */
  const advanceOnly = (w: World, by: bigint, child: bigint, amount: number) =>
    db().payment.create({
      data: {
        schoolId: w.school.id,
        academicYearId: w.year.id,
        payerGuardianId: w.guardianId,
        method: 'cash',
        amount,
        receivedOn: new Date('2026-09-20T00:00:00Z'),
        recordedBy: by,
        verifiedBy: by,
        advanceForStudentId: child,
      },
    });

  it('fix 1 (R232): a recorder later linked as the child\'s guardian stops nothing the system or a colleague does, but still cannot pay or void for that child', async () => {
    const w = await h.world();
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 11000 }); // 5,000 left as A's advance
    await advanceOnly(w, w.office.user.userId, w.b.studentId, 1000);
    await h.parentOf(w, w.office.user, w.a); // the family's guardian: both children
    // Generation (the system actor): A's advance pays August.
    await runMonth(app, w.school, w.year, '2026-08', karachi('2026-10-02'));
    expect((await h.charges(w, w.a.studentId)).find((c) => c.period === '2026-08')?.status).toBe('settled');
    // The late-fee sweep (the system actor): B's advance pays B's oldest charge.
    await db().schoolSettings.update({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: new Date('2026-08-01T00:00:00Z') },
    });
    expect(await lateFees(app, w.school, karachi('2026-10-06'))).toBe(1);
    expect((await h.charges(w, w.b.studentId)).find((c) => c.period === '2026-09' && c.kind === 'generated')?.allocatedAmount).toBe(1000);
    // A colleague's credit de-allocates from the clerk's payment into A's advance.
    const [aSep] = await h.charges(w, w.a.studentId);
    await post(`/charges/${aSep!.id}/adjust`, { amount: 500, reason: 'Fee reduced' }, w.principal, newIdempotencyKey()).expect(201);
    // The clerk still cannot pay for, nor void money of, their own child.
    const record = await post('/payments', { ...intent(w, [w.a.studentId], 100), method: 'cash', receivedOn: isoDay(0) }, w.office, newIdempotencyKey());
    expect([record.status, err(record).error.details?.reason]).toEqual([409, 'own_child']);
    await h.grant(w.office.user, w.principal.user, Capability.PAYMENT_VOID);
    const own = await pay(w, w.principal, { studentIds: [w.a.studentId], amount: 100, advanceForStudentId: w.a.studentId });
    const voided = await post(`/payments/${own.id}/void`, { reason: 'Mine' }, w.office);
    expect([voided.status, err(voided).error.details?.reason]).toEqual([409, 'own_child']);
    expect((await get(`/payments/${p.id}`, w.principal).expect(200)).body).toMatchObject({ status: 'verified' });
  });

  it('fix 7 (A5): a void and a credit re-apply the child\'s own advance to what is owed at once', async () => {
    const w = await h.world();
    const [aSep, aOct] = await h.charges(w, w.a.studentId);
    const p1 = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 }); // September
    const p2 = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 5000 }); // October and 2,000 advance
    expect(p2.unallocatedAmount).toBe(2000);
    await post(`/payments/${p1.id}/void`, { reason: 'Wrong family' }, w.principal).expect(200);
    const sep = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: aSep!.id } });
    expect([sep.status, sep.allocatedAmount]).toEqual(['open', 2000]);
    expect((await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(p2.id) } })).unallocatedAmount).toBe(0);
    expect((await h.audit(w.school, 'payment.voided'))[0]?.metadata).toMatchObject({ applied: 2000 });

    // A credit on October beyond what is owed frees money that pays September's remaining 1,000.
    await post(`/charges/${aOct!.id}/adjust`, { amount: 1500, reason: 'Fee reduced' }, w.principal, newIdempotencyKey()).expect(201);
    const after = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: aSep!.id } });
    expect([after.status, after.allocatedAmount]).toEqual(['settled', 3000]);
    expect((await h.audit(w.school, 'charge.adjusted'))[0]?.metadata).toMatchObject({ deallocated: 1500, applied: 1000 });
    // One live allocation per payment and charge: the top-up merged into p2's September row.
    const rows = await db().paymentAllocation.findMany({ where: { schoolId: w.school.id, paymentId: BigInt(p2.id), chargeId: aSep!.id, reversedAt: null } });
    expect(rows.map((r) => r.amount)).toEqual([3000]);
  });

  it('fix 10 (R190): the receipt message names every child money reached, an existing advance included', async () => {
    const w = await h.world();
    await advanceOnly(w, w.principal.user.userId, w.b.studentId, 3000);
    const p = await pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 3000 });
    expect(p.receipt?.lines.every((l) => l.studentId === w.a.studentId.toString())).toBe(true);
    const [message] = await db().message.findMany({ where: { schoolId: w.school.id, type: 'receipt_issued' } });
    expect(message?.body).toContain('Hamza Tariq, Hira Tariq');
  });

  it('fix 2, 5 (R251): a carried payment is never voided, even by a direct write; an advance moves only into a later year', async () => {
    const w = await h.world();
    const later = await createAcademicYear(db(), w.school, { name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' });
    const next = await classWithSection(w.school, later, 'Class 6');
    await enrol(db(), w.school, { id: w.a.studentId }, next.section, { startedOn: '2027-04-01', status: 'left', endedOn: '2028-03-31' });
    const earlier = await createAcademicYear(db(), w.school, { name: '2025-26', startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'closed' });
    const old = await classWithSection(w.school, earlier, 'Class 4');
    await enrol(db(), w.school, { id: w.a.studentId }, old.section, { startedOn: '2025-04-01', status: 'left', endedOn: '2026-03-31' });
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 7000 });
    const back = await post(`/payments/${p.id}/carry-forward`, { academicYearId: earlier.id.toString(), reason: 'Back' }, w.office, newIdempotencyKey());
    expect([back.status, err(back).error.details?.fields?.[0]?.path]).toEqual([422, 'academicYearId']);
    const carried = (await post(`/payments/${p.id}/carry-forward`, { academicYearId: later.id.toString(), reason: 'Year end' }, w.office, newIdempotencyKey()).expect(201))
      .body as { payment: Payment };
    await expect(
      db().paymentReversal.create({
        data: {
          schoolId: w.school.id,
          paymentId: BigInt(carried.payment.id),
          academicYearId: later.id,
          kind: 'void',
          amount: carried.payment.amount,
          reason: 'Direct write',
          requestedBy: w.principal.user.userId,
        },
      }),
    ).rejects.toThrow(/payment_reversals_carried_forward_void/);
  });
});
