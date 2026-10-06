// Slice 21 over HTTP (phase-3-financial.md slice 21, contracts/slice-21.md): the guardian's dues and
// receipts (R198), deposit claims with their slip (R196, R199, R243), the office queue and its
// verify and reject (R196, R197, A15, the in-grace late-fee waiver), the duplicate flag (R249),
// the image-less expiry (R200), the void that reopens a claim, and payment_claims isolation (R62).
// The real AppModule and database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Capability, ErrorCode, newIdempotencyKey } from '@asms/shared';
import { ClaimsService } from '../../src/modules/payments/claims.service';
import { PaymentClaimRepository } from '../../src/repositories/payment-claim.repository';
import { PaymentRepository } from '../../src/repositories/payment.repository';
import { createTestApp } from '../core/app';
import { pdf, png } from '../documents/fixtures';
import { karachi, lateFees, db } from '../fees/charges-support';
import { asSchool, tx } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import {
  createSchoolSession,
  randomIdentityDigits,
  testIdentityHash,
  type TestSchoolSession,
} from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createGuardian, linkGuardian } from '../support/students';
import { API, ORIGIN, paymentsHttp, type Payment, type World } from './payments-support';

interface MyClaim {
  id: string;
  studentId: string;
  method: string;
  claimedAmount: number;
  paidOn: string;
  reference: string | null;
  note: string | null;
  hasImage: boolean;
  submittedByMe: boolean;
  status: string;
  decisionReason: string | null;
  verifiedAmount: number | null;
  verifiedPaidOn: string | null;
  receiptId: string | null;
}
interface Claim extends Omit<MyClaim, 'submittedByMe'> {
  studentName: string;
  className: string;
  guardianName: string;
  paymentId: string | null;
  reopenedAt: string | null;
  possibleDuplicate: boolean;
  duplicateOfClaimId: string | null;
  payment?: Payment & { claimId: string | null; receivedOn: string };
}
interface Dues {
  studentId: string;
  outstanding: number;
  advance: number;
  nextDueOn: string | null;
  charges: { id: string; feeHeadName: string; outstanding: number; status: string }[];
  claimsAccepted: boolean;
}
interface MyReceipt {
  id: string;
  receiptLabel: string;
  amount: number;
  lines: { studentId: string; amount: number }[];
  otherChildrenAmount: number;
}
interface Page<T> {
  data: T[];
  total: number;
}

const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g'; // pragma: allowlist secret

describe('slice 21: deposit claims and the guardian view over HTTP (e2e)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);
  const { get, post, err } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const patch = (path: string, body: object, s: { cookie: string }) =>
    h.http().patch(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);

  /** A login for an existing guardian record, its links to `children` turned into login links. */
  async function loginFor(school: TestSchool, guardianId: bigint, children: bigint[]): Promise<TestSchoolSession & { userId: bigint }> {
    const user = await db().user.create({
      data: { schoolId: school.id, usernameHash: testIdentityHash(randomIdentityDigits()), passwordHash: PASSWORD_HASH, guardianId },
    });
    await db().studentGuardian.updateMany({
      where: { schoolId: school.id, guardianId, studentId: { in: children }, endedAt: null },
      data: { canLogin: true },
    });
    return { ...(await createSchoolSession(db(), school, { userId: user.id })), userId: user.id };
  }

  interface ClaimWorld extends World {
    /** The father: fee payer of both children, a WhatsApp phone, a login. */
    father: TestSchoolSession & { userId: bigint };
    /** The mother: linked to the elder child only, with a login. */
    mother: TestSchoolSession & { userId: bigint };
    motherId: bigint;
    /** An office clerk the principal granted payment.verify (not an office default). */
    clerk: World['office'];
  }

  async function claimWorld(opts: { account?: boolean } = {}): Promise<ClaimWorld> {
    const w = await h.world({ contactCapability: 'whatsapp' });
    if (opts.account !== false) {
      await db().schoolPaymentAccount.create({
        data: { schoolId: w.school.id, kind: 'bank', title: 'Iqra Model School', accountNo: 'PK36MEZN0001', bankName: 'Meezan Bank', createdBy: w.principal.user.userId },
      });
    }
    const mother = await createGuardian(db(), w.school, { fullName: 'Amina Tariq', contactCapability: 'smartphone_data' });
    await linkGuardian(db(), w.school, { id: w.a.studentId }, { id: mother.id }, { relationship: 'mother', isPrimaryContact: false, isFeePayer: false });
    const clerk = await h.signIn(w.school, 'office_staff');
    await h.grant(clerk.user, w.principal.user, Capability.PAYMENT_VERIFY);
    return {
      ...w,
      father: await loginFor(w.school, w.guardianId, [w.a.studentId, w.b.studentId]),
      mother: await loginFor(w.school, mother.id, [w.a.studentId]),
      motherId: mother.id,
      clerk,
    };
  }

  const stage = async (s: { cookie: string }): Promise<string> => {
    const res = await h.http().post(`${API}/me/uploads`).set('Cookie', s.cookie).set('Origin', ORIGIN).attach('file', await png(), 'slip.png');
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const claimBody = (over: Record<string, unknown> = {}) => ({
    method: 'bank_transfer',
    claimedAmount: 3000,
    paidOn: '2026-10-02',
    reference: `TRX-${Math.floor(Math.random() * 1e9)}`,
    ...over,
  });

  async function submit(w: ClaimWorld, studentId: bigint, over: Record<string, unknown> = {}, s = w.father): Promise<MyClaim> {
    const res = await post(`/me/children/${studentId}/payment-claims`, claimBody(over), s, newIdempotencyKey());
    if (res.status !== 201) throw new Error(`claim refused ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as MyClaim;
  }

  const audits = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  // ------------------------------------------------------------------------- dues, receipts

  it('R198: dues per child for every live login link; receipts show only the caller\'s own children', async () => {
    const w = await claimWorld();
    const dues = (await get(`/me/children/${w.a.studentId}/dues`, w.mother).expect(200)).body as Dues;
    expect([dues.outstanding, dues.advance, dues.charges.length, dues.claimsAccepted]).toEqual([6000, 0, 2, true]);
    expect(dues.charges.map((c) => c.feeHeadName)).toEqual(['Tuition', 'Tuition']);
    expect(Object.keys(dues.charges[0] ?? {})).not.toContain('createdByUserId');
    // The mother is not linked to the younger child: 404, the same as an absent one.
    await get(`/me/children/${w.b.studentId}/dues`, w.mother).expect(404);
    await get(`/me/children/999999999/dues`, w.father).expect(404);
    // A staff session without the guardian capacity is refused the route.
    expect((await get(`/me/children/${w.a.studentId}/dues`, w.office)).status).toBe(403);

    // The counter pays both children: the father sees both lines, the mother only hers.
    const paid = await h.pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 6000 });
    const fathers = (await get('/me/receipts', w.father).expect(200)).body as Page<MyReceipt>;
    expect(fathers.data.map((r) => [r.receiptLabel, r.amount, r.lines.length, r.otherChildrenAmount])).toEqual([
      [paid.receipt?.receiptLabel, 6000, 2, 0],
    ]);
    const mothers = (await get('/me/receipts', w.mother).expect(200)).body as Page<MyReceipt>;
    expect(mothers.data.map((r) => [r.amount, r.lines.map((l) => l.studentId), r.otherChildrenAmount])).toEqual([
      [6000, [w.a.studentId.toString()], 3000],
    ]);
    const one = (await get(`/me/receipts/${paid.receipt?.id}`, w.mother).expect(200)).body as MyReceipt & Record<string, unknown>;
    expect(one).not.toHaveProperty('issuedByName');
    await get(`/me/receipts?studentId=${w.b.studentId}`, w.mother).expect(404);
    // A link that ends removes the child on the next request.
    await db().studentGuardian.updateMany({ where: { schoolId: w.school.id, guardianId: w.motherId }, data: { endedAt: new Date() } });
    await get(`/me/children/${w.a.studentId}/dues`, w.mother).expect(404);
    expect(((await get('/me/receipts', w.mother).expect(200)).body as Page<MyReceipt>).total).toBe(0);
  });

  // ------------------------------------------------------------------------ claim and verify

  it('R196, R197, R198: a claim with its slip, the queue, the image to the submitter only, and verify as the counter', async () => {
    const w = await claimWorld();
    const upload = await stage(w.father);
    const key = newIdempotencyKey();
    const body = claimBody({ stagedUploadId: upload, claimedAmount: 4000, reference: 'MZN-778812', note: 'Paid from my brother Imran account' });
    const first = await post(`/me/children/${w.a.studentId}/payment-claims`, body, w.father, key).expect(201);
    const claim = first.body as MyClaim;
    expect([claim.status, claim.hasImage, claim.submittedByMe, claim.claimedAmount]).toEqual(['pending', true, true, 4000]);
    const replay = await post(`/me/children/${w.a.studentId}/payment-claims`, body, w.father, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as MyClaim).id]).toEqual(['true', claim.id]);
    expect(await audits(w.school, 'payment_claim.submitted')).toHaveLength(1);

    // A claim is never a payment (rule 10): nothing in payments, receipts or collections.
    expect(await db().payment.count({ where: { schoolId: w.school.id } })).toBe(0);
    // R200: the verifiers hear of it once (the principal, and the clerk granted payment.verify).
    const told = await db().message.findMany({ where: { schoolId: w.school.id, type: 'payment_claim_submitted' } });
    const byStaff = (x: bigint | null, y: bigint | null) => ((x ?? 0n) < (y ?? 0n) ? -1 : 1);
    expect(told.map((m) => m.staffId).sort(byStaff)).toEqual([w.principal.user.staffId, w.clerk.user.staffId].sort(byStaff));
    expect(told.every((m) => m.subjectId.toString() === claim.id)).toBe(true);
    expect(told[0]?.body).not.toContain('4,000');

    // The mother sees status and amounts; only the submitter's user streams the slip (R198).
    const seen = (await get(`/me/children/${w.a.studentId}/payment-claims`, w.mother).expect(200)).body as Page<MyClaim>;
    expect(seen.data.map((c) => [c.id, c.claimedAmount, c.submittedByMe])).toEqual([[claim.id, 4000, false]]);
    // The submitter's free text is theirs: the co-guardian gets the reference, never the note.
    expect(seen.data.map((c) => [c.reference, c.note])).toEqual([['MZN-778812', null]]);
    const fathers = (await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}`, w.father).expect(200)).body as MyClaim;
    expect([fathers.reference, fathers.note]).toEqual(['MZN-778812', 'Paid from my brother Imran account']);
    await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}/image`, w.mother).expect(404);
    const slip = await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}/image`, w.father).buffer(true).expect(200);
    expect([slip.headers['content-type'], slip.headers['content-security-policy'], slip.headers['x-content-type-options'], slip.headers['cache-control']]).toEqual(
      ['image/png', 'sandbox', 'nosniff', 'no-store'],
    );
    // A slip image opens in the browser instead of downloading.
    expect(slip.headers['content-disposition']).toBe(`inline; filename="deposit-slip-${claim.id}.png"`);
    await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}/thumbnail`, w.father).expect(200);
    // A stranger's family: 404.
    const stranger = await createGuardian(db(), w.school);
    const outsider = await loginFor(w.school, stranger.id, []);
    await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}`, outsider).expect(404);

    // The office queue: payment.verify only (a teacher and a plain clerk are refused).
    expect((await get('/payment-claims', w.teacher)).status).toBe(403);
    expect((await get('/payment-claims', w.office)).status).toBe(403);
    const queue = (await get('/payment-claims', w.clerk).expect(200)).body as Page<Claim>;
    expect(queue.data.map((c) => [c.id, c.studentName, c.guardianName, c.hasImage, c.possibleDuplicate])).toEqual([
      [claim.id, 'Hamza Tariq', 'Tariq Mehmood', true, false],
    ]);
    expect(queue.data[0]).not.toHaveProperty('imageObjectKey');
    const office = await get(`/payment-claims/${claim.id}/image`, w.clerk).buffer(true).expect(200);
    expect([office.headers['content-disposition'], office.headers['content-security-policy'], office.headers['x-content-type-options'], office.headers['cache-control']]).toEqual(
      [`inline; filename="deposit-slip-${claim.id}.png"`, 'sandbox', 'nosniff', 'no-store'],
    );

    // R197: a verifier who is a guardian of the child (or the submitter) is refused (service and trigger).
    const kin = await h.signIn(w.school, 'office_staff');
    await h.grant(kin.user, w.principal.user, Capability.PAYMENT_VERIFY);
    // The clerk is also the child's uncle: a live guardian of the student.
    const uncle = await createGuardian(db(), w.school, { fullName: 'Bilal Mehmood' });
    await linkGuardian(db(), w.school, { id: w.a.studentId }, { id: uncle.id }, { relationship: 'other', isPrimaryContact: false, isFeePayer: false });
    await db().user.updateMany({ where: { schoolId: w.school.id, id: kin.user.userId }, data: { guardianId: uncle.id } });
    const own = await post(`/payment-claims/${claim.id}/verify`, {}, kin);
    expect([own.status, err(own).error.code, err(own).error.details?.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'own_child']);
    // Nor does a verifier of the family read the slip.
    await get(`/payment-claims/${claim.id}/image`, kin).expect(404);
    await get(`/payment-claims/${claim.id}/thumbnail`, kin).expect(404);
    await expect(
      db().paymentClaim.updateMany({
        where: { schoolId: w.school.id, id: BigInt(claim.id) },
        data: { status: 'rejected', decidedBy: kin.user.userId, decidedAt: new Date(), decisionReason: 'Not ours' },
      }),
    ).rejects.toThrow(/payment_claims_not_self|nobody decides a claim of their own family/);

    // A15: never more than claimed; a lower amount or another date needs a reason.
    const over = await post(`/payment-claims/${claim.id}/verify`, { verifiedAmount: 4001 }, w.clerk);
    expect([over.status, err(over).error.details?.fields?.[0]?.path]).toEqual([422, 'verifiedAmount']);
    const noReason = await post(`/payment-claims/${claim.id}/verify`, { verifiedAmount: 3500 }, w.clerk);
    expect([noReason.status, err(noReason).error.details?.fields?.[0]?.path]).toEqual([422, 'reason']);
    const future = await post(`/payment-claims/${claim.id}/verify`, { paidOn: '2099-01-01', reason: 'Slip date' }, w.clerk);
    expect([future.status, err(future).error.details?.fields?.[0]?.path]).toEqual([422, 'paidOn']);

    // Verified with the slip's own date: the payment as the counter records it.
    const verified = (await post(
      `/payment-claims/${claim.id}/verify`,
      { verifiedAmount: 3500, paidOn: '2026-10-01', reason: 'The slip shows Rs 3,500 on 1 October' },
      w.clerk,
    ).expect(200)).body as Claim;
    expect([verified.status, verified.verifiedAmount, verified.verifiedPaidOn, verified.paidOn]).toEqual(['verified', 3500, '2026-10-01', '2026-10-02']);
    const payment = verified.payment;
    expect([payment?.claimId, payment?.method, payment?.amount, payment?.receivedOn, payment?.status]).toEqual([
      claim.id, 'bank_transfer', 3500, '2026-10-01', 'verified',
    ]);
    expect(payment?.receipt?.receiptNo).toBe(1);
    expect(payment?.allocatedAmount).toBe(3500);
    expect(verified.paymentId).toBe(payment?.id);
    expect(verified.receiptId).toBe(payment?.receipt?.id);
    expect((await audits(w.school, 'payment_claim.verified')).map((r) => r.actorUserId)).toEqual([w.clerk.user.userId]);
    expect((await audits(w.school, 'payment.recorded')).map((r) => r.actorUserId)).toEqual([w.clerk.user.userId]);
    // receipt_issued to the fee payer, as at the counter.
    const receiptMessages = await db().message.findMany({ where: { schoolId: w.school.id, type: 'receipt_issued' } });
    expect(receiptMessages.map((m) => m.guardianId)).toEqual([w.guardianId]);
    // Not replayable: a second verify is 409.
    const twice = await post(`/payment-claims/${claim.id}/verify`, {}, w.clerk);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.CLAIM_NOT_PENDING]);
    // The mother now sees the decision, the amount and the receipt, never who decided.
    const hers = (await get(`/me/children/${w.a.studentId}/payment-claims/${claim.id}`, w.mother).expect(200)).body as MyClaim & Record<string, unknown>;
    expect([hers.status, hers.verifiedAmount, hers.decisionReason, hers.receiptId]).toEqual(['verified', 3500, 'The slip shows Rs 3,500 on 1 October', payment?.receipt?.id]);
    expect(hers).not.toHaveProperty('decidedByName');
    const dues = (await get(`/me/children/${w.a.studentId}/dues`, w.mother).expect(200)).body as Dues;
    expect(dues.outstanding).toBe(2500);

    // R191, wave K hook: a void of the payment returns the claim to the queue; the payment keeps claimId.
    const voided = (await post(`/payments/${payment?.id}/void`, { reason: 'Slip was a forgery' }, w.principal).expect(200)).body as Payment & { claimId: string };
    expect([voided.status, voided.claimId]).toEqual(['voided', claim.id]);
    const reopened = (await get(`/payment-claims/${claim.id}`, w.clerk).expect(200)).body as Claim;
    expect([reopened.status, reopened.paymentId, reopened.verifiedAmount, reopened.reopenedAt === null]).toEqual(['pending', null, null, false]);
  });

  it('a PDF slip stays an attachment (a browser PDF viewer does not run under the sandbox CSP)', async () => {
    const w = await claimWorld();
    const res = await h.http().post(`${API}/me/uploads`).set('Cookie', w.father.cookie).set('Origin', ORIGIN).attach('file', pdf(), 'slip.pdf');
    expect(res.status).toBe(201);
    const claim = await submit(w, w.a.studentId, { stagedUploadId: (res.body as { id: string }).id });
    const file = await get(`/payment-claims/${claim.id}/image`, w.clerk).buffer(true).expect(200);
    expect([file.headers['content-type'], file.headers['content-disposition'], file.headers['content-security-policy']]).toEqual([
      'application/pdf',
      `attachment; filename="deposit-slip-${claim.id}.pdf"`,
      'sandbox',
    ]);
  });

  it('R243, R200: the slip later through PATCH, once; the image-less claim is listed on request, never verified', async () => {
    const w = await claimWorld();
    const bare = await submit(w, w.a.studentId);
    expect(bare.hasImage).toBe(false);
    expect(await db().message.count({ where: { schoolId: w.school.id, type: 'payment_claim_submitted' } })).toBe(0);
    expect(((await get('/payment-claims', w.clerk).expect(200)).body as Page<Claim>).total).toBe(0);
    const imageless = (await get('/payment-claims?hasImage=false', w.clerk).expect(200)).body as Page<Claim>;
    expect(imageless.data.map((c) => c.id)).toEqual([bare.id]);
    const missing = await post(`/payment-claims/${bare.id}/verify`, {}, w.clerk);
    expect([missing.status, err(missing).error.code]).toEqual([409, ErrorCode.CLAIM_IMAGE_MISSING]);

    // Only the submitter attaches it; another's upload is unusable; the same upload replays 200.
    const mothers = await stage(w.mother);
    await patch(`/me/children/${w.a.studentId}/payment-claims/${bare.id}`, { stagedUploadId: mothers }, w.mother).expect(404);
    const notOwn = await patch(`/me/children/${w.a.studentId}/payment-claims/${bare.id}`, { stagedUploadId: mothers }, w.father);
    expect([notOwn.status, err(notOwn).error.details?.fields?.[0]?.code]).toEqual([422, ErrorCode.REFERENCE_NOT_FOUND]);
    const upload = await stage(w.father);
    const set = (await patch(`/me/children/${w.a.studentId}/payment-claims/${bare.id}`, { stagedUploadId: upload }, w.father).expect(200)).body as MyClaim;
    expect(set.hasImage).toBe(true);
    await patch(`/me/children/${w.a.studentId}/payment-claims/${bare.id}`, { stagedUploadId: upload }, w.father).expect(200);
    const other = await patch(`/me/children/${w.a.studentId}/payment-claims/${bare.id}`, { stagedUploadId: await stage(w.father) }, w.father);
    expect([other.status, err(other).error.code]).toEqual([409, ErrorCode.CLAIM_IMAGE_EXISTS]);
    expect(await audits(w.school, 'payment_claim.image_attached')).toHaveLength(1);
    // Verifiers are told once, when the slip lands.
    expect(await db().message.count({ where: { schoolId: w.school.id, type: 'payment_claim_submitted' } })).toBe(2);

    // Withdraw: the submitter, while pending; then nothing more lands.
    await post(`/me/children/${w.a.studentId}/payment-claims/${bare.id}/withdraw`, {}, w.mother).expect(404);
    const withdrawn = (await post(`/me/children/${w.a.studentId}/payment-claims/${bare.id}/withdraw`, { reason: 'Paid at the office instead' }, w.father).expect(200)).body as MyClaim;
    expect([withdrawn.status, withdrawn.decisionReason]).toEqual(['withdrawn', 'Paid at the office instead']);
    expect((await audits(w.school, 'payment_claim.withdrawn')).map((r) => r.actorUserId)).toEqual([w.father.userId]);
    const again = await post(`/me/children/${w.a.studentId}/payment-claims/${bare.id}/withdraw`, {}, w.father);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.CLAIM_NOT_PENDING]);
    const late = await submit(w, w.a.studentId);
    await post(`/me/children/${w.a.studentId}/payment-claims/${late.id}/withdraw`, {}, w.father).expect(200);
    const afterWithdraw = await patch(`/me/children/${w.a.studentId}/payment-claims/${late.id}`, { stagedUploadId: await stage(w.father) }, w.father);
    expect([afterWithdraw.status, err(afterWithdraw).error.code]).toEqual([409, ErrorCode.CLAIM_NOT_PENDING]);
  });

  it('R199, R200: ten claims a day per guardian, image-less included; image-less claims expire after 24 h and still count', async () => {
    const w = await claimWorld();
    for (let i = 0; i < 10; i++) await submit(w, w.b.studentId);
    const eleventh = await post(`/me/children/${w.b.studentId}/payment-claims`, claimBody(), w.father, newIdempotencyKey());
    expect([eleventh.status, err(eleventh).error.code]).toEqual([409, ErrorCode.CLAIM_LIMIT_REACHED]);
    // Another guardian has a cap of their own.
    await submit(w, w.a.studentId, {}, w.mother);

    const claims = app.get(ClaimsService, { strict: false });
    const early = await asSchool(app, w.school.id, () => claims.expireImageless(w.school.id, new Date(Date.now() + 23 * 3_600_000)));
    expect(early).toBe(0);
    const expired = await asSchool(app, w.school.id, () => claims.expireImageless(w.school.id, new Date(Date.now() + 25 * 3_600_000)));
    expect(expired).toBe(11);
    const rows = await db().paymentClaim.findMany({ where: { schoolId: w.school.id } });
    expect(rows.every((r) => r.status === 'expired' && r.decidedAt !== null && r.decidedBy === null)).toBe(true);
    expect((await audits(w.school, 'payment_claim.expired')).map((r) => [r.actorUserId, (r.metadata as { job: string }).job])).toEqual([[null, 'claim-image-sweep']]);
    const stillCounted = await post(`/me/children/${w.b.studentId}/payment-claims`, claimBody(), w.father, newIdempotencyKey());
    expect(stillCounted.status).toBe(409);
  });

  it('R196: no active payment account, no claims; a cash claim and a future date are refused', async () => {
    const w = await claimWorld({ account: false });
    const refused = await post(`/me/children/${w.a.studentId}/payment-claims`, claimBody(), w.father, newIdempotencyKey());
    expect([refused.status, err(refused).error.code]).toEqual([409, ErrorCode.CLAIMS_NOT_ACCEPTED]);
    expect(((await get(`/me/children/${w.a.studentId}/dues`, w.father).expect(200)).body as Dues).claimsAccepted).toBe(false);
    await db().schoolPaymentAccount.create({
      data: { schoolId: w.school.id, kind: 'jazzcash', title: 'Iqra Model School', accountNo: '03001234', createdBy: w.principal.user.userId },
    });
    const cash = await post(`/me/children/${w.a.studentId}/payment-claims`, claimBody({ method: 'cash' }), w.father, newIdempotencyKey());
    expect([cash.status, err(cash).error.details?.fields?.[0]?.path]).toEqual([422, 'method']);
    const future = await post(`/me/children/${w.a.studentId}/payment-claims`, claimBody({ paidOn: '2099-01-01' }), w.father, newIdempotencyKey());
    expect([future.status, err(future).error.details?.fields?.[0]?.path]).toEqual([422, 'paidOn']);
    const identity = await post(`/me/children/${w.a.studentId}/payment-claims`, claimBody({ note: 'CNIC 3520212345671' }), w.father, newIdempotencyKey());
    expect([identity.status, err(identity).error.details?.fields?.[0]?.path]).toEqual([422, 'note']);
    // The guardian's upload is under /me; a staff session is refused it.
    expect((await h.http().post(`${API}/me/uploads`).set('Cookie', w.office.cookie).set('Origin', ORIGIN).attach('file', await png(), 'x.png')).status).toBe(403);
  });

  it('reject tells the submitter why; R249 flags a slip claimed twice, never refusing it', async () => {
    const w = await claimWorld();
    const first = await submit(w, w.a.studentId, { stagedUploadId: await stage(w.father), reference: 'JC-4411', method: 'jazzcash', paidOn: '2026-10-01' });
    const second = await submit(w, w.a.studentId, { stagedUploadId: await stage(w.mother), reference: 'JC-4411', method: 'jazzcash', paidOn: '2026-10-01' }, w.mother);
    const queue = (await get('/payment-claims', w.clerk).expect(200)).body as Page<Claim>;
    expect(queue.data.map((c) => [c.id, c.possibleDuplicate, c.duplicateOfClaimId])).toEqual([
      [first.id, true, second.id],
      [second.id, true, first.id],
    ]);

    const phone = await post(`/payment-claims/${second.id}/reject`, { reason: 'Call me on 03001234567' }, w.clerk);
    expect([phone.status, err(phone).error.details?.fields?.[0]?.path]).toEqual([422, 'reason']);
    const rejected = (await post(`/payment-claims/${second.id}/reject`, { reason: 'This slip was already claimed' }, w.clerk).expect(200)).body as Claim;
    expect([rejected.status, rejected.decisionReason]).toEqual(['rejected', 'This slip was already claimed']);
    const told = await db().message.findMany({ where: { schoolId: w.school.id, type: 'payment_claim_rejected' } });
    expect(told.map((m) => [m.guardianId, m.subjectId.toString()])).toEqual([[w.motherId, second.id]]);
    expect(told[0]?.body).toContain('This slip was already claimed');
    expect((await audits(w.school, 'payment_claim.rejected')).map((r) => r.reason)).toEqual(['This slip was already claimed']);
    const twice = await post(`/payment-claims/${second.id}/reject`, { reason: 'Again' }, w.clerk);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.CLAIM_NOT_PENDING]);
    // A rejected duplicate no longer flags the first.
    const now = (await get(`/payment-claims/${first.id}`, w.clerk).expect(200)).body as Claim;
    expect(now.possibleDuplicate).toBe(false);
  });

  it('slice 19 rule: a claim verified with a paid date inside the grace waives the open late fee', async () => {
    const w = await claimWorld();
    await db().schoolSettings.updateMany({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi('2026-09-01') },
    });
    // September is due on the 10th; by the 20th both children carry a late fee.
    expect(await lateFees(app, w.school, karachi('2026-09-20'))).toBe(2);
    const claim = await submit(w, w.a.studentId, { stagedUploadId: await stage(w.father), paidOn: '2026-09-15', claimedAmount: 3000 });
    const verified = (await post(`/payment-claims/${claim.id}/verify`, {}, w.clerk).expect(200)).body as Claim;
    expect(verified.payment?.allocatedAmount).toBe(3000);
    const fees = await db().charge.findMany({ where: { schoolId: w.school.id, kind: 'late_fee' }, orderBy: { id: 'asc' } });
    const aFee = fees.find((f) => f.studentId === w.a.studentId);
    const bFee = fees.find((f) => f.studentId === w.b.studentId);
    expect([aFee?.status, aFee?.waiveReason, aFee?.waivedBy]).toEqual(['waived', 'paid_on_time_verified_late', w.clerk.user.userId]);
    expect(bFee?.status).toBe('open');
    const waived = await audits(w.school, 'charge.waived');
    expect(waived.map((r) => [r.subjectId, r.reason, (r.metadata as { claimId: string }).claimId])).toEqual([[aFee?.id, 'paid_on_time_verified_late', claim.id]]);
  });

  it('slice 19 rule: a token deposit inside the grace that does not settle the charge waives nothing', async () => {
    const w = await claimWorld();
    await db().schoolSettings.updateMany({
      where: { schoolId: w.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 300, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi('2026-09-01') },
    });
    expect(await lateFees(app, w.school, karachi('2026-09-20'))).toBe(2);
    const claim = await submit(w, w.a.studentId, { stagedUploadId: await stage(w.father), paidOn: '2026-09-15', claimedAmount: 500 });
    const verified = (await post(`/payment-claims/${claim.id}/verify`, {}, w.clerk).expect(200)).body as Claim;
    expect(verified.payment?.allocatedAmount).toBe(500);
    const aFee = await db().charge.findFirst({ where: { schoolId: w.school.id, kind: 'late_fee', studentId: w.a.studentId } });
    expect([aFee?.status, aFee?.waiveReason]).toEqual(['open', null]);
    expect(await audits(w.school, 'charge.waived')).toEqual([]);
    const target = await db().charge.findFirst({ where: { schoolId: w.school.id, id: aFee?.lateFeeForChargeId ?? 0n } });
    expect(target?.amount).toBe(3000);
    const meta = (await audits(w.school, 'payment_claim.verified'))[0]?.metadata as { lateFeesWaived: string };
    expect(meta.lateFeesWaived).toBe('');
  });

  it('payment_claims: reads, lists, the lock and the decision see only their own school', async () => {
    const a = await claimWorld();
    const b = await claimWorld();
    const repo = app.get(PaymentClaimRepository, { strict: false });
    const payments = app.get(PaymentRepository, { strict: false });
    const as = <T>(schoolId: TestSchool['id'], fn: () => Promise<T>) => asSchool(app, schoolId, () => tx.run(fn));
    const claim = await submit(a, a.a.studentId, { reference: 'ISO-1' });
    await expectIsolated({ a: a.school, b: b.school }, {
      create: () => Promise.resolve(BigInt(claim.id)),
      read: (schoolId, id) => as(schoolId, () => repo.findById(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => repo.list(schoolId, { status: 'pending', sort: 'createdAt', skip: 0, take: 50 }))).rows,
      write: (schoolId, id) =>
        as(schoolId, () => repo.decide(schoolId, id, { status: 'withdrawn', decidedBy: b.principal.user.userId, decisionReason: null }, new Date())),
      snapshot: (row) => (row as { status: string }).status,
    });
    const B = b.school.id;
    const id = BigInt(claim.id);
    const row = await as(a.school.id, () => repo.findById(a.school.id, id));
    expect(await as(B, () => repo.lockIfUnchanged(B, { id, updatedAt: row!.updatedAt }))).toBe(false);
    expect(await as(B, () => repo.findOfStudent(B, a.a.studentId, id))).toBeNull();
    expect((await as(B, () => repo.listOfStudent(B, a.a.studentId, { skip: 0, take: 50 }))).rows).toEqual([]);
    expect(await as(B, () => repo.countSince(B, a.guardianId, new Date(0)))).toBe(0);
    expect(await as(B, () => repo.sameSlip(B, { method: 'bank_transfer', reference: 'ISO-1', paidOn: row!.paidOn, excludeId: 0n }))).toBeNull();
    expect(await as(B, () => repo.defaultYearOf(B, a.a.studentId))).toBeNull();
    // The claim cap's lock on the guardian (payment.repository.ts, a RAW_SQL_FILES statement).
    expect(await as(B, () => payments.lockGuardian(B, a.guardianId))).toBe(false);
    expect(await as(a.school.id, () => payments.lockGuardian(a.school.id, a.guardianId))).toBe(true);
    expect(await as(B, () => repo.expireImageless(B, new Date(Date.now() + 86_400_000 * 2), new Date()))).toBe(0);
    expect((await db().paymentClaim.findFirstOrThrow({ where: { schoolId: a.school.id, id } })).status).toBe('pending');
    // A's office cannot reach B's claim over HTTP either.
    await get(`/payment-claims/${claim.id}`, b.clerk).expect(404);
  });
});
