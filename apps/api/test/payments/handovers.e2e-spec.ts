// Slice 20's cash custody and handovers over HTTP (phase-3-financial.md §3.4, A13, R193, R194,
// R191's void in custody): custody, a handover of one's own cash, a void before and after it, the
// count by a third user with a shortfall that tells the principals, the principal's resolution
// (a cash_shortfall expense), and a handover opened on behalf of a suspended collector.
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { db } from '../fees/charges-support';
import { paymentsHttp, type Handover } from './payments-support';

interface Custody {
  cashInHand: number;
  paymentCount: number;
  since: string | null;
}

describe('slice 20: cash custody and handovers (e2e)', () => {
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

  it('R193, R194, R191: custody, a void in custody, a handover, the count by a third user, the shortfall and its resolution', async () => {
    const w = await h.world();
    const second = await h.signIn(w.school, 'principal');
    const right = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 5000 });
    const mistyped = await pay(w, w.office, { studentIds: [w.b.studentId], amount: 500 });
    await pay(w, w.office, { studentIds: [w.b.studentId], amount: 1000, method: 'jazzcash', reference: 'JC-77' });
    expect((await get('/me/staff/custody', w.office).expect(200)).body as Custody).toMatchObject({ cashInHand: 5500, paymentCount: 2 });

    // A mistyped cash payment in custody is voided by someone else and leaves custody (§3.4).
    await post(`/payments/${mistyped.id}/void`, { reason: 'Typed 500 for 5000' }, w.principal).expect(200);
    expect((await h.audit(w.school, 'payment.voided'))[0]?.metadata).toMatchObject({ custody: 'before_handover' });
    expect((await get('/me/staff/custody', w.office).expect(200)).body).toMatchObject({ cashInHand: 5000, paymentCount: 1 });

    // Hand over: the stored expected sum of the live custody payments.
    const opened = (await post('/me/staff/cash-handovers', { note: 'End of day' }, w.office).expect(201)).body as Handover;
    expect([opened.status, opened.onBehalf, opened.expectedAmount, opened.paymentCount]).toEqual(['open', false, 5000, 1]);
    expect((await get('/me/staff/custody', w.office).expect(200)).body).toMatchObject({ cashInHand: 0, paymentCount: 0 });
    const again = await post('/me/staff/cash-handovers', {}, w.office);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.HANDOVER_OPEN]);
    // Inside an open handover the cash cannot be voided: confirm first.
    const inside = await post(`/payments/${right.id}/void`, { reason: 'Wrong' }, w.principal);
    expect([inside.status, err(inside).error.code]).toEqual([409, ErrorCode.PAYMENT_IN_CUSTODY]);
    expect(((await get('/me/staff/cash-handovers', w.office).expect(200)).body as { total: number }).total).toBe(1);

    // The collector never confirms (and holds no confirm key); the principal counts 4,800.
    expect((await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 5000 }, w.office)).status).toBe(403);
    const counted = (await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 4800, note: 'Two notes short' }, w.principal).expect(200)).body as Handover;
    expect([counted.status, counted.countedAmount, counted.shortfallAmount, counted.surplusAmount]).toEqual(['confirmed', 4800, 200, 0]);
    const twice = await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 5000 }, w.principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.HANDOVER_NOT_OPEN]);
    // The shortfall tells every principal (push and email; no amount).
    const notices = await db().message.findMany({ where: { schoolId: w.school.id, type: 'handover_shortfall' } });
    expect(notices.map((m) => m.staffId).sort()).toEqual([w.principal.user.staffId, second.user.staffId].sort());
    expect(notices.every((m) => !/Rs /.test(m.body))).toBe(true);
    const banner = (await get('/cash-handovers?unresolvedShortfall=true', w.principal).expect(200)).body as { data: Handover[] };
    expect(banner.data.map((x) => x.id)).toEqual([opened.id]);

    // After confirmation the cash may be voided (voidedAfterHandover).
    await post(`/payments/${right.id}/void`, { reason: 'Wrong family' }, w.principal).expect(200);
    expect((await h.audit(w.school, 'payment.voided'))[1]?.metadata).toMatchObject({ custody: 'after_handover' });

    // Resolution: the principal only, once; written off as a cash_shortfall expense.
    // A void of a payment this handover did not gather explains nothing (fix 4).
    const outside = ((await get(`/payments/${mistyped.id}`, w.principal).expect(200)).body as { reversals: { id: string }[] }).reversals[0]?.id;
    const wrong = await post(`/cash-handovers/${opened.id}/resolve-shortfall`, { resolution: 'explained_by_void', reason: 'That void', reversalId: outside }, second);
    expect([wrong.status, err(wrong).error.details?.fields?.[0]]).toEqual([422, expect.objectContaining({ path: 'reversalId', code: ErrorCode.REFERENCE_NOT_FOUND })]);
    const clerk = await post(`/cash-handovers/${opened.id}/resolve-shortfall`, { resolution: 'written_off', reason: 'Lost' }, w.office);
    expect(clerk.status).toBe(403);
    const resolved = (await post(`/cash-handovers/${opened.id}/resolve-shortfall`, { resolution: 'written_off', reason: 'Cannot be traced' }, second).expect(200)).body as Handover;
    expect(resolved.shortfallResolution).toBe('written_off');
    const expense = await db().expense.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(resolved.shortfallExpenseId ?? '0') } });
    expect([expense.category, expense.amount, expense.status, expense.recordedBy]).toEqual(['cash_shortfall', 200, 'approved', second.user.userId]);
    const done = await post(`/cash-handovers/${opened.id}/resolve-shortfall`, { resolution: 'recovered', reason: 'Again' }, second);
    expect([done.status, err(done).error.code]).toEqual([409, ErrorCode.HANDOVER_NO_SHORTFALL]);
    for (const action of ['cash_handover.opened', 'cash_handover.confirmed', 'cash_handover.shortfall_resolved']) {
      expect((await h.audit(w.school, action)).length).toBe(1);
    }
  });

  it('R194, A13: on behalf of a suspended collector, a third user confirms; never for an active one; a confirmer is never the collector', async () => {
    const w = await h.world();
    const clerk = await h.signIn(w.school, 'office_staff');
    const third = await h.signIn(w.school, 'principal');
    await pay(w, clerk, { studentIds: [w.a.studentId], amount: 3000 });
    // An active collector hands over their own cash.
    const active = await post('/cash-handovers', { collectorUserId: clerk.user.userId.toString() }, w.principal);
    expect([active.status, err(active).error.details?.fields?.[0]?.path]).toEqual([422, 'collectorUserId']);
    await db().staff.updateMany({ where: { schoolId: w.school.id, id: clerk.user.staffId }, data: { status: 'suspended' } });
    const opened = (await post('/cash-handovers', { collectorUserId: clerk.user.userId.toString() }, w.principal).expect(201)).body as Handover;
    expect([opened.onBehalf, opened.expectedAmount]).toEqual([true, 3000]);
    // The opener does not confirm; a third user does (CHECK cash_handovers_not_self_check too).
    const opener = await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 3000 }, w.principal);
    expect([opener.status, err(opener).error.code, err(opener).error.details?.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'opener']);
    const ok = (await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 3100 }, third).expect(200)).body as Handover;
    expect([ok.shortfallAmount, ok.surplusAmount]).toEqual([0, 100]);
    const page = (await get(`/cash-handovers/${opened.id}/payments`, third).expect(200)).body as { total: number };
    expect(page.total).toBe(1);

    // A principal's own cash: they hand it over and cannot count it.
    await pay(w, third, { studentIds: [w.b.studentId], amount: 3000 });
    const own = (await post('/me/staff/cash-handovers', {}, third).expect(201)).body as Handover;
    const self = await post(`/cash-handovers/${own.id}/confirm`, { countedAmount: 3000 }, third);
    expect([self.status, err(self).error.details?.reason]).toEqual([409, 'collector']);
    // The database refuses it too.
    await expect(
      db().cashHandover.updateMany({
        where: { schoolId: w.school.id, id: BigInt(own.id) },
        data: { status: 'confirmed', confirmedBy: third.user.userId, confirmedAt: new Date(), countedAmount: 3000, shortfallAmount: 0, surplusAmount: 0 },
      }),
    ).rejects.toThrow(/cash_handovers_not_self_check/);
    const nothing = await post('/me/staff/cash-handovers', {}, w.office);
    expect([nothing.status, err(nothing).error.code]).toEqual([409, ErrorCode.HANDOVER_NOTHING_TO_HAND_OVER]);
  });

  it('§3.4: a shortfall explained by the void of a payment the handover gathered', async () => {
    const w = await h.world();
    const second = await h.signIn(w.school, 'principal');
    const p = await pay(w, w.office, { studentIds: [w.a.studentId], amount: 3000 });
    const opened = (await post('/me/staff/cash-handovers', {}, w.office).expect(201)).body as Handover;
    await post(`/cash-handovers/${opened.id}/confirm`, { countedAmount: 0 }, w.principal).expect(200);
    const voided = (await post(`/payments/${p.id}/void`, { reason: 'Never received' }, w.principal).expect(200)).body as { reversals: { id: string; kind: string }[] };
    const reversalId = voided.reversals.find((r) => r.kind === 'void')?.id;
    const resolved = (await post(`/cash-handovers/${opened.id}/resolve-shortfall`, { resolution: 'explained_by_void', reason: 'Mistyped payment', reversalId }, second).expect(200)).body as Handover & { shortfallReversalId: string };
    expect([resolved.shortfallResolution, resolved.shortfallReversalId]).toEqual(['explained_by_void', reversalId]);
  });
});
