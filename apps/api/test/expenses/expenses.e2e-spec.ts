// Slice 23 over HTTP (phase-3-financial.md slice 23, contracts/slice-23.md): record and the
// approval threshold (R206), the principal's self-approval, approve and reject (R244), void by
// status, the receipt set once and streamed (R208), idempotent capture (R207), the finance
// readers (R234) and another school's ids (404). The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { createTestApp } from '../core/app';
import { png, pdf } from '../documents/fixtures';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const db = () => testDb();

interface ErrorBody {
  error: { code: string; details: { reason?: string; expenseId?: string; fields?: { path: string; code: string }[] } | null };
}
interface Expense {
  id: string;
  expenseNo: number;
  category: string;
  amount: number;
  spentOn: string;
  description: string;
  payee: string | null;
  method: string;
  reference: string | null;
  hasReceipt: boolean;
  receiptMime: string | null;
  status: string;
  selfApproved: boolean;
  recordedByUserId: string;
  recordedByName: string;
  decidedByUserId: string | null;
  decisionReason: string | null;
  voidReason: string | null;
  updatedAt: string;
}
interface Page<T> {
  data: T[];
  total: number;
}

/** Today in Asia/Karachi, as the school's clock reads it. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
const tomorrow = () => new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe('slice 23: expenses (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  type Session = TestSchoolSession & { user: TestSchoolUser; school: TestSchool };
  const signIn = async (systemRole: SystemRole, school: TestSchool): Promise<Session> => {
    const user = await createSchoolUser(db(), school, { systemRole });
    return { ...(await createSchoolSession(db(), school, user)), user, school };
  };
  /** A school with its finance seeds (the expense_no counter) and its settings row. */
  const newSchool = async (): Promise<TestSchool> => {
    const school = await createSchool();
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    return school;
  };
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const send = (
    method: 'post' | 'patch',
    path: string,
    body: object,
    s: { cookie: string },
    headers: Record<string, string> = {},
  ) => {
    const req = http()[method](`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(body);
  };
  const post = (path: string, body: object, s: { cookie: string }) => send('post', path, body, s);
  const patch = (path: string, body: object, s: { cookie: string }) => send('patch', path, body, s);
  const err = (res: request.Response) => res.body as ErrorBody;
  /** A decision on the version the approver read (compare-and-set). */
  const seen = (e: Expense, extra: object = {}) => ({ expectedUpdatedAt: e.updatedAt, ...extra });
  const record = (s: Session, over: object = {}, key = newIdempotencyKey()) =>
    send(
      'post',
      '/expenses',
      { category: 'stationery', amount: 300, spentOn: today(), description: 'Chalk and dusters', method: 'cash', ...over },
      s,
      { 'Idempotency-Key': key },
    );
  const recorded = async (s: Session, over: object = {}): Promise<Expense> => {
    const res = await record(s, over);
    expect(res.status).toBe(201);
    return res.body as Expense;
  };
  const audits = (school: TestSchool, action: string, id?: string) =>
    db().auditLog.findMany({
      where: { schoolId: school.id, action, ...(id === undefined ? {} : { subjectId: BigInt(id) }) },
      orderBy: { id: 'asc' },
    });
  const messages = (school: TestSchool, id: string) =>
    db().message.findMany({ where: { schoolId: school.id, subjectType: 'expense', subjectId: BigInt(id) }, orderBy: { id: 'asc' } });
  const grant = (to: TestSchoolUser, by: TestSchoolUser, capability: Capability) =>
    db().userCapabilityGrant.create({
      data: { schoolId: to.schoolId, userId: to.userId, capabilityKey: capability, effect: 'grant', grantedBy: by.userId, reason: 'Test grant' },
    });
  const setThreshold = (school: TestSchool, value: number) =>
    db().schoolSettings.updateMany({ where: { schoolId: school.id }, data: { expenseApprovalThreshold: value } });
  const stage = async (body: Buffer, s: { cookie: string }): Promise<string> => {
    const res = await http().post(`${API}/uploads`).set('Cookie', s.cookie).set('Origin', ORIGIN).attach('file', body, 'file.bin');
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  // ------------------------------------------------------------------------------- record

  describe('record and the threshold (R206)', () => {
    it('at or below the threshold is recorded; above it a clerk waits and the approvers are told', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      await setThreshold(school, 5000);

      const atThreshold = await recorded(office, { amount: 5000 });
      expect([atThreshold.status, atThreshold.selfApproved, atThreshold.decidedByUserId]).toEqual(['recorded', false, null]);
      expect(await messages(school, atThreshold.id)).toEqual([]);

      const above = await recorded(office, { amount: 5001, payee: 'Ali Traders', reference: 'Bill 77' });
      expect([above.status, above.selfApproved, above.payee, above.reference]).toEqual(['pending_approval', false, 'Ali Traders', 'Bill 77']);
      expect(above.expenseNo).toBe(atThreshold.expenseNo + 1);
      expect(above.recordedByUserId).toBe(office.user.userId.toString());
      expect(above.recordedByName.length).toBeGreaterThan(0);
      // The principal (an expense.approve holder) is asked; the clerk is not.
      const asked = await messages(school, above.id);
      expect(asked.map((m) => [m.type, m.staffId])).toEqual([['expense_approval_requested', principal.user.staffId]]);
      expect(asked[0]!.body).not.toMatch(/5,001|5001/);

      const [audit] = await audits(school, 'expense.recorded', above.id);
      expect(audit).toMatchObject({ actorUserId: office.user.userId, subjectType: 'expense' });
      expect(audit!.metadata).toMatchObject({ amount: 5001, status: 'pending_approval', selfApproved: false, threshold: 5000 });
    });

    it("a principal's own above the threshold is approved on record, self-approved and audited", async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      await setThreshold(school, 1000);
      const own = await recorded(principal, { amount: 1001, category: 'repairs' });
      expect([own.status, own.selfApproved, own.decidedByUserId]).toEqual(['approved', true, principal.user.userId.toString()]);
      expect(await messages(school, own.id)).toEqual([]);
      const [audit] = await audits(school, 'expense.recorded', own.id);
      expect(audit!.metadata).toMatchObject({ selfApproved: true, status: 'approved', amount: 1001 });
      // At or below the threshold a principal's is simply recorded.
      expect((await recorded(principal, { amount: 1000 })).status).toBe('recorded');
    });

    it('an expense.approve holder who is not a principal also waits, and cannot approve their own', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      await grant(office.user, principal.user, Capability.EXPENSE_APPROVE);
      const own = await recorded(office, { amount: 9000 });
      expect([own.status, own.selfApproved]).toEqual(['pending_approval', false]);
      // The approval request reaches the principal, never the recorder.
      expect((await messages(school, own.id)).map((m) => m.staffId)).toEqual([principal.user.staffId]);

      const self = await post(`/expenses/${own.id}/approve`, seen(own), office);
      expect([self.status, err(self).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);
      const selfReject = await post(`/expenses/${own.id}/reject`, seen(own, { reason: 'Changed my mind' }), office);
      expect([selfReject.status, err(selfReject).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);
      // The trigger refuses it too, whatever the service says (R244).
      await expect(
        db().expense.updateMany({
          where: { schoolId: school.id, id: BigInt(own.id) },
          data: { status: 'approved', decidedBy: office.user.userId, decidedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it('refuses a future date, identity numbers, the system categories and carried_forward', async () => {
      const school = await newSchool();
      const office = await signIn('office_staff', school);
      const cases: [object, string][] = [
        [{ spentOn: tomorrow() }, 'spentOn'],
        [{ description: 'Paid to 35202-1234567-1' }, 'description'],
        [{ payee: '3520212345671' }, 'payee'],
        [{ category: 'cash_shortfall' }, 'category'],
        [{ category: 'salary_advance_cash' }, 'category'],
        [{ method: 'carried_forward' }, 'method'],
        [{ amount: 0 }, 'amount'],
        [{ amount: 12.5 }, 'amount'],
        [{ amount: 10_000_001 }, 'amount'],
      ];
      for (const [over, path] of cases) {
        const res = await record(office, over);
        expect([res.status, err(res).error.details?.fields?.[0]?.path]).toEqual([422, path]);
      }
      expect(await db().expense.count({ where: { schoolId: school.id } })).toBe(0);
    });

    it('R207: a replay of the same key answers 200 with the same expense; another body under it is refused', async () => {
      const school = await newSchool();
      const office = await signIn('office_staff', school);
      const key = newIdempotencyKey();
      const first = await record(office, { amount: 450 }, key);
      expect(first.status).toBe(201);
      const again = await record(office, { amount: 450 }, key);
      expect([again.status, again.headers['idempotency-replayed'], (again.body as Expense).id]).toEqual([
        200,
        'true',
        (first.body as Expense).id,
      ]);
      const other = await record(office, { amount: 451 }, key);
      expect([other.status, err(other).error.code]).toEqual([409, ErrorCode.IDEMPOTENCY_KEY_REUSED]);
      const missing = await send('post', '/expenses', { category: 'water', amount: 10, spentOn: today(), description: 'Can', method: 'cash' }, office);
      expect(missing.status).toBe(422);
      expect(await db().expense.count({ where: { schoolId: school.id } })).toBe(1);
      expect(await audits(school, 'expense.recorded')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------- decide

  describe('approve, reject (R244)', () => {
    it('the principal approves or rejects a pending expense; the recorder is told; a second decision is refused', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      const a = await recorded(office, { amount: 8000 });
      const b = await recorded(office, { amount: 7000 });

      const approved = await post(`/expenses/${a.id}/approve`, seen(a), principal).expect(200);
      expect([(approved.body as Expense).status, (approved.body as Expense).decidedByUserId]).toEqual(['approved', principal.user.userId.toString()]);
      const told = (await messages(school, a.id)).filter((m) => m.type === 'expense_decided');
      expect(told.map((m) => m.staffId)).toEqual([office.user.staffId]);
      const twice = await post(`/expenses/${a.id}/approve`, seen(a), principal);
      expect([twice.status, err(twice).error.code, err(twice).error.details?.expenseId]).toEqual([409, ErrorCode.EXPENSE_NOT_PENDING, a.id]);

      const noReason = await post(`/expenses/${b.id}/reject`, seen(b), principal);
      expect(noReason.status).toBe(422);
      const rejected = await post(`/expenses/${b.id}/reject`, seen(b, { reason: 'Not a school cost' }), principal).expect(200);
      expect([(rejected.body as Expense).status, (rejected.body as Expense).decisionReason]).toEqual(['rejected', 'Not a school cost']);
      const [audit] = await audits(school, 'expense.rejected', b.id);
      expect(audit).toMatchObject({ actorUserId: principal.user.userId, reason: 'Not a school cost' });
      expect(audit!.metadata).toMatchObject({ amount: 7000 });
      expect(await audits(school, 'expense.approved', a.id)).toHaveLength(1);

      // A recorded (below the threshold) expense is not pending.
      const small = await recorded(office, { amount: 10 });
      const notPending = await post(`/expenses/${small.id}/approve`, seen(small), principal);
      expect(err(notPending).error.code).toBe(ErrorCode.EXPENSE_NOT_PENDING);
      // The office holds no expense.approve by default.
      expect((await post(`/expenses/${small.id}/approve`, seen(small), office)).status).toBe(403);
    });
  });

  describe('the decision applies to the version the approver saw', () => {
    it('an edit between the approver reading and approving refuses the approval: 409 CONCURRENT_UPDATE', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      const pending = await recorded(office, { amount: 8000 });
      // The approver reads it at 8,000 ...
      const read = (await get(`/expenses/${pending.id}`, principal).expect(200)).body as Expense;
      // ... the recorder raises it ...
      const edited = (await patch(`/expenses/${pending.id}`, { amount: 80_000 }, office).expect(200)).body as Expense;
      expect(edited.updatedAt).not.toBe(read.updatedAt);
      // ... and the approval of the version read is refused, as is a rejection.
      const stale = await post(`/expenses/${pending.id}/approve`, seen(read), principal);
      expect([stale.status, err(stale).error.code]).toEqual([409, ErrorCode.CONCURRENT_UPDATE]);
      const staleReject = await post(`/expenses/${pending.id}/reject`, seen(read, { reason: 'Too much' }), principal);
      expect([staleReject.status, err(staleReject).error.code]).toEqual([409, ErrorCode.CONCURRENT_UPDATE]);
      expect((await get(`/expenses/${pending.id}`, principal).expect(200)).body).toMatchObject({ status: 'pending_approval', amount: 80_000 });
      expect(await audits(school, 'expense.approved', pending.id)).toEqual([]);
      // A version is required, and a well-formed one.
      expect((await post(`/expenses/${pending.id}/approve`, {}, principal)).status).toBe(422);
      expect((await post(`/expenses/${pending.id}/approve`, { expectedUpdatedAt: 'yesterday' }, principal)).status).toBe(422);
      // Approving the version now shown succeeds.
      const approved = (await post(`/expenses/${pending.id}/approve`, seen(edited), principal).expect(200)).body as Expense;
      expect([approved.status, approved.amount]).toEqual(['approved', 80_000]);
    });
  });

  // ---------------------------------------------------------------------------------- void

  describe('void by status (R206, R244)', () => {
    it('the recorder voids while open; once approved an approver who is not the recorder; a voided one is final', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      const other = await signIn('office_staff', school);
      await grant(office.user, principal.user, Capability.EXPENSE_APPROVE);

      const open = await recorded(office, { amount: 200 });
      const notMine = await post(`/expenses/${open.id}/void`, { reason: 'Duplicate' }, other);
      expect([notMine.status, err(notMine).error.details?.reason]).toEqual([403, 'not_recorder']);
      const byPrincipal = await post(`/expenses/${open.id}/void`, { reason: 'Duplicate' }, principal);
      expect([byPrincipal.status, err(byPrincipal).error.details?.reason]).toEqual([403, 'not_recorder']);
      const voided = await post(`/expenses/${open.id}/void`, { reason: 'Duplicate' }, office).expect(200);
      expect([(voided.body as Expense).status, (voided.body as Expense).voidReason]).toEqual(['voided', 'Duplicate']);
      const again = await post(`/expenses/${open.id}/void`, { reason: 'Duplicate' }, office);
      expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.EXPENSE_NOT_OPEN]);

      const pending = await recorded(office, { amount: 9000 });
      await post(`/expenses/${pending.id}/approve`, seen(pending), principal).expect(200);
      // Approved: the recorder (an approver) may not void their own; a clerk without the key may not.
      const own = await post(`/expenses/${pending.id}/void`, { reason: 'Mine' }, office);
      expect([own.status, err(own).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);
      const clerk = await post(`/expenses/${pending.id}/void`, { reason: 'Wrong' }, other);
      expect(clerk.status).toBe(403);
      await post(`/expenses/${pending.id}/void`, { reason: 'Paid twice' }, principal).expect(200);
      const [audit] = await audits(school, 'expense.voided', pending.id);
      expect(audit!.metadata).toMatchObject({ fromStatus: 'approved', amount: 9000 });

      // A principal voids their own self-approved expense.
      await setThreshold(school, 100);
      const self = await recorded(principal, { amount: 500 });
      expect(self.selfApproved).toBe(true);
      await post(`/expenses/${self.id}/void`, { reason: 'Entered twice' }, principal).expect(200);

      // A rejected expense is not open.
      const rejected = await recorded(office, { amount: 900 });
      await post(`/expenses/${rejected.id}/reject`, seen(rejected, { reason: 'No bill' }), principal).expect(200);
      expect(err(await post(`/expenses/${rejected.id}/void`, { reason: 'Gone' }, office)).error.code).toBe(ErrorCode.EXPENSE_NOT_OPEN);
    });
  });

  // ---------------------------------------------------------------------------------- edit

  describe('edit while open', () => {
    it('the recorder edits; nobody else; a recorded expense is never raised above the threshold; a decided one is frozen', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      await setThreshold(school, 5000);
      const row = await recorded(office, { amount: 300, payee: 'Shop' });

      const edited = await patch(`/expenses/${row.id}`, { amount: 350, payee: null, description: 'Chalk, dusters and pens' }, office).expect(200);
      expect([(edited.body as Expense).amount, (edited.body as Expense).payee]).toEqual([350, null]);
      const [audit] = await audits(school, 'expense.updated', row.id);
      expect(audit!.metadata).toMatchObject({ amount: 350, previousAmount: 300, changes: 'amount,description,payee' });
      // No change: no audit row.
      await patch(`/expenses/${row.id}`, { amount: 350 }, office).expect(200);
      expect(await audits(school, 'expense.updated', row.id)).toHaveLength(1);

      const other = await patch(`/expenses/${row.id}`, { amount: 10 }, principal);
      expect([other.status, err(other).error.details?.reason]).toEqual([403, 'not_recorder']);
      const raised = await patch(`/expenses/${row.id}`, { amount: 5001 }, office);
      expect([raised.status, err(raised).error.details?.fields?.[0]?.path]).toEqual([422, 'amount']);
      const future = await patch(`/expenses/${row.id}`, { spentOn: tomorrow() }, office);
      expect(future.status).toBe(422);

      const pending = await recorded(office, { amount: 6000 });
      const editedPending = (await patch(`/expenses/${pending.id}`, { amount: 6500 }, office).expect(200)).body as Expense;
      await post(`/expenses/${pending.id}/approve`, seen(editedPending), principal).expect(200);
      const frozen = await patch(`/expenses/${pending.id}`, { amount: 10 }, office);
      expect([frozen.status, err(frozen).error.code]).toEqual([409, ErrorCode.EXPENSE_NOT_OPEN]);
    });
  });

  // ------------------------------------------------------------------------------- receipt

  describe('the receipt (R208)', () => {
    it('is set once by the recorder; the same upload again is 200; another is refused; it streams with the private headers', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      const row = await recorded(office);

      const upload = await stage(await png(), office);
      const others = await stage(await png(), principal);
      const notOwn = await patch(`/expenses/${row.id}/receipt`, { stagedUploadId: others }, office);
      expect([notOwn.status, err(notOwn).error.details?.fields?.[0]?.code]).toEqual([422, ErrorCode.REFERENCE_NOT_FOUND]);
      const notRecorder = await patch(`/expenses/${row.id}/receipt`, { stagedUploadId: others }, principal);
      expect([notRecorder.status, err(notRecorder).error.details?.reason]).toEqual([403, 'not_recorder']);

      const set = await patch(`/expenses/${row.id}/receipt`, { stagedUploadId: upload }, office).expect(200);
      expect([(set.body as Expense).hasReceipt, (set.body as Expense).receiptMime]).toEqual([true, 'image/png']);
      await patch(`/expenses/${row.id}/receipt`, { stagedUploadId: upload }, office).expect(200);
      expect(await audits(school, 'expense.receipt_attached', row.id)).toHaveLength(1);
      const second = await patch(`/expenses/${row.id}/receipt`, { stagedUploadId: await stage(await png(), office) }, office);
      expect([second.status, err(second).error.code, err(second).error.details?.expenseId]).toEqual([409, ErrorCode.EXPENSE_RECEIPT_EXISTS, row.id]);

      const file = await get(`/expenses/${row.id}/receipt`, principal).buffer(true).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toBe('sandbox');
      expect(file.headers['cache-control']).toBe('no-store');
      expect(file.headers['content-disposition']).toContain(`expense-${row.expenseNo}.png`);
      const thumb = await get(`/expenses/${row.id}/receipt/thumbnail`, principal).buffer(true).expect(200);
      expect(thumb.headers['content-type']).toBe('image/jpeg');

      // On create; a PDF has no thumbnail; an expense without a receipt has none to stream.
      const withPdf = await recorded(office, { stagedUploadId: await stage(pdf(), office) });
      expect([withPdf.hasReceipt, withPdf.receiptMime]).toEqual([true, 'application/pdf']);
      await get(`/expenses/${withPdf.id}/receipt/thumbnail`, principal).expect(404);
      const bare = await recorded(office);
      await get(`/expenses/${bare.id}/receipt`, principal).expect(404);
    });
  });

  // ------------------------------------------------------------------------- reads, scope

  describe('readers (R234) and tenant isolation', () => {
    it('lists with filters for the finance keys; a teacher reaches nothing; another school gets 404', async () => {
      const school = await newSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      const teacher = await signIn('teacher', school);
      await recorded(office, { category: 'water', amount: 120 });
      const pending = await recorded(office, { category: 'repairs', amount: 9000 });
      await recorded(principal, { category: 'water', amount: 80 });

      const all = (await get('/expenses', office).expect(200)).body as Page<Expense>;
      expect(all.total).toBe(3);
      const water = (await get('/expenses?category=water', principal).expect(200)).body as Page<Expense>;
      expect(water.data.map((e) => e.amount).sort()).toEqual([120, 80].sort());
      const waiting = (await get('/expenses?status=pending_approval', principal).expect(200)).body as Page<Expense>;
      expect(waiting.data.map((e) => e.id)).toEqual([pending.id]);
      const mine = (await get(`/expenses?recordedByUserId=${principal.user.userId}`, principal).expect(200)).body as Page<Expense>;
      expect(mine.total).toBe(1);
      const dated = (await get(`/expenses?spentFrom=${tomorrow()}`, principal).expect(200)).body as Page<Expense>;
      expect(dated.total).toBe(0);

      for (const path of ['/expenses', `/expenses/${pending.id}`, `/expenses/${pending.id}/receipt`]) {
        expect((await get(path, teacher)).status).toBe(403);
      }
      expect((await record(teacher)).status).toBe(403);

      const elsewhere = await newSchool();
      const intruder = await signIn('principal', elsewhere);
      await get(`/expenses/${pending.id}`, intruder).expect(404);
      await get(`/expenses/${pending.id}/receipt`, intruder).expect(404);
      expect((await post(`/expenses/${pending.id}/approve`, seen(pending), intruder)).status).toBe(404);
      expect((await post(`/expenses/${pending.id}/void`, { reason: 'Not ours' }, intruder)).status).toBe(404);
      expect((await patch(`/expenses/${pending.id}`, { amount: 1 }, intruder)).status).toBe(404);
      expect(((await get('/expenses', intruder).expect(200)).body as Page<Expense>).total).toBe(0);
      // Each school numbers its own expenses from 1.
      expect((await recorded(intruder)).expenseNo).toBe(1);
    });
  });
});
