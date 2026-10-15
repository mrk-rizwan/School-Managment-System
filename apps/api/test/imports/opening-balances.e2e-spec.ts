// Slice 43 over HTTP: opening-balance imports (phase-5-extended.md rule 39, §1.1, R339, R341,
// R342, R355; contracts/slice-43.md). The slice-22 reports world (a year around today, tuition
// 3,000, three pupils owing a past month): a preview shows each row's advance; a commit raises one
// manual charge per row under the seeded "Opening balance" head, due on the file's date, which an
// advance pays at once, the counter can take, the late-fee sweep never touches, and which the
// defaulters list, the fee statement and the reminders see — with the Phase 3 identities intact.
// Principal only, rule-24 inert on a default password; isolation.
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode, newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { db, lateFees, karachi } from '../fees/charges-support';
import { reportsHttp, type ReportsWorld } from '../finance-reports/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createGuardian, isoDay } from '../support/students';
import { pupil } from '../fees/charges-support';
import { csv, errorOf, importsHttp, type ImportDetail } from './support';

describe('slice 43: opening-balance imports (e2e)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  const x = importsHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const admissionOf = async (w: ReportsWorld, studentId: bigint) =>
    (await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: studentId } })).admissionNo;

  const fields = (w: ReportsWorld, dueOn = isoDay(2)) => ({ academicYearId: w.year.id.toString(), dueOn });

  const openingHead = (w: ReportsWorld) =>
    db().feeHead.findFirstOrThrow({ where: { schoolId: w.school.id, category: 'other', createdBy: null } });

  it('R339, R342: preview shows each row and the advance that will pay it; commit raises one manual charge per row under the seeded head; the advance applies', async () => {
    const w = await h.world();
    // Zainab's family pays 3,000 for the past month and leaves 1,200 as her advance.
    await h.pay(w, w.office, { guardianId: w.g2, studentIds: [w.c.studentId], amount: 4200, advanceForStudentId: w.c.studentId });
    const file = csv(['admission_no', 'amount', 'note'], [await admissionOf(w, w.a.studentId), 12500, 'Arrears 2025-26'], [await admissionOf(w, w.c.studentId), 2000, '']);
    const res = await x.preview('opening-balances', fields(w), file, w.principal.cookie, { fileName: 'balances.csv' });
    expect(res.status).toBe(201);
    const preview = res.body as ImportDetail;
    expect(preview).toMatchObject({ kind: 'opening_balances', status: 'previewed', dueOn: isoDay(2), errorCount: 0, totalAmount: 14500, totalAdvance: 1200 });
    expect(preview.rows.map((r) => [r.studentName, r.amount, r.note, r.advance])).toEqual([
      ['Hamza Tariq', 12500, 'Arrears 2025-26', 0],
      ['Zainab Khan', 2000, null, 1200],
    ]);
    // A preview writes no charge.
    const before = await db().charge.count({ where: { schoolId: w.school.id } });
    const done = await x.commit(preview.id, w.principal.cookie);
    expect([done.status, (done.body as ImportDetail).status]).toEqual([200, 'committed']);
    const head = await openingHead(w);
    const charges = await db().charge.findMany({ where: { schoolId: w.school.id, importId: BigInt(preview.id) }, orderBy: { id: 'asc' } });
    expect(await db().charge.count({ where: { schoolId: w.school.id } })).toBe(before + 2);
    expect(charges.map((c) => [c.studentId, c.kind, c.feeHeadId, c.headFrequency, c.period, c.amount, c.description, c.dueOn.toISOString().slice(0, 10), c.allocatedAmount, c.status])).toEqual([
      [w.a.studentId, 'manual', head.id, 'once', null, 12500, 'Opening balance: Arrears 2025-26', isoDay(2), 0, 'open'],
      [w.c.studentId, 'manual', head.id, 'once', null, 2000, 'Opening balance', isoDay(2), 1200, 'open'],
    ]);
    expect((await h.audit(w.school, 'import.committed')).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ kind: 'opening_balances', rows: 2, charges: 2, amount: 14500, advanceApplied: 1200 }),
    ]);
  });

  it('R342: visible to defaulters, the fee statement and the reminders from its due date; payable at the counter; never late-fee charged; the Phase 3 identities hold', async () => {
    const w = await h.world();
    // A family with no other debt, so the opening balance alone makes them a defaulter.
    const g3 = await createGuardian(db(), w.school, { fullName: 'Sana Ali', contactCapability: 'keypad' });
    const d = await pupil(w.school, w.section, { startedOn: isoDay(0), fullName: 'Daniyal Ali', guardianId: g3.id });
    const file = csv(['admission_no', 'amount'], [await admissionOf(w, d.studentId), 5000], [await admissionOf(w, w.b.studentId), 700]);
    const preview = (await x.preview('opening-balances', fields(w, isoDay(2)), file, w.principal.cookie)).body as ImportDetail;
    await x.commit(preview.id, w.principal.cookie).expect(200);

    const defaulters = (await h.get('/finance-reports/defaulters?limit=50', w.principal).expect(200)).body as { data: { studentId: string; outstanding: number; overdue: number }[] };
    expect(defaulters.data.find((r) => r.studentId === d.studentId.toString())).toMatchObject({ outstanding: 5000, overdue: 0 });
    const statement = (await h.get(`/students/${d.studentId}/fee-statement?academicYearId=${w.year.id}`, w.principal).expect(200)).body as {
      charges: { data: { description: string; amount: number; dueOn: string }[] };
      totals: { outstanding: number };
    };
    expect(statement.charges.data.map((c) => [c.description, c.amount, c.dueOn])).toEqual([['Opening balance', 5000, isoDay(2)]]);
    expect(statement.totals.outstanding).toBe(5000);

    // The due reminder (three days before) names it.
    await h.reminders(w);
    const due = await db().message.findMany({ where: { schoolId: w.school.id, guardianId: g3.id, type: 'fee_due_reminder' } });
    expect(due).toHaveLength(1);
    expect(due[0]?.body).toContain('Rs 5,000 for Daniyal Ali');

    // Never late-fee'd: the sweep, run after the grace with late fees on, writes none on it.
    await db().schoolSettings.updateMany({ where: { schoolId: w.school.id }, data: { lateFeeEnabled: true, lateFeeEnabledAt: karachi(isoDay(-60)), lateFeeAmount: 500, lateFeeGraceDays: 0 } });
    await lateFees(app, w.school, karachi(isoDay(20)));
    const imported = await db().charge.findMany({ where: { schoolId: w.school.id, importId: BigInt(preview.id) } });
    expect(await db().charge.count({ where: { schoolId: w.school.id, kind: 'late_fee', lateFeeForChargeId: { in: imported.map((c) => c.id) } } })).toBe(0);

    // Payable at the counter: the family pays it in full.
    const paid = await h.pay(w, w.office, { guardianId: g3.id, studentIds: [d.studentId], amount: 5000 });
    expect(paid.amount).toBe(5000);
    const settled = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, importId: BigInt(preview.id), studentId: d.studentId } });
    expect([settled.allocatedAmount, settled.status]).toEqual([5000, 'settled']);

    // The §0.20 identities (R228) with the import in the ledger.
    const schoolId = w.school.id;
    for (const p of await db().payment.findMany({ where: { schoolId, status: 'verified' } })) {
      const live = await db().paymentAllocation.aggregate({ where: { schoolId, paymentId: p.id, reversedAt: null }, _sum: { amount: true } });
      expect((live._sum.amount ?? 0) + p.unallocatedAmount).toBe(p.amount);
    }
    const all = await db().charge.findMany({ where: { schoolId } });
    for (const c of all.filter((r) => r.kind !== 'adjustment')) {
      const owed = c.amount - c.allocatedAmount - c.creditedAmount;
      expect(owed).toBeGreaterThanOrEqual(0);
      if (c.status === 'open' || c.status === 'settled') expect(c.status === 'open').toBe(owed > 0);
    }
    const owedTotal = all.filter((c) => c.status === 'open').reduce((s, c) => s + c.amount - c.allocatedAmount - c.creditedAmount, 0);
    const outstanding = (await h.get(`/finance-reports/outstanding?academicYearId=${w.year.id}`, w.principal).expect(200)).body as { total: number };
    expect(outstanding.total).toBe(owedTotal);
    let statements = 0;
    for (const p of [w.a, w.b, w.c, d]) {
      const s = (await h.get(`/students/${p.studentId}/fee-statement?academicYearId=${w.year.id}`, w.principal).expect(200)).body as {
        totals: { charged: number; concession: number; adjustments: number; paid: number; outstanding: number };
      };
      expect(s.totals.charged - s.totals.concession - s.totals.adjustments - s.totals.paid).toBe(s.totals.outstanding);
      statements += s.totals.outstanding;
    }
    expect(statements).toBe(owedTotal);
    const all50 = (await h.get('/finance-reports/defaulters?limit=50', w.principal).expect(200)).body as { data: { outstanding: number }[] };
    expect(all50.data.reduce((s, r) => s + r.outstanding, 0)).toBe(owedTotal);
  });

  it('R339: row errors (unknown, not enrolled, duplicate, amount ≤ 0 or not whole, identity in a note); dueOn in the past and a closed year are refused', async () => {
    const w = await h.world();
    const left = await pupil(w.school, w.section, { startedOn: isoDay(-100), endedOn: isoDay(-10), fullName: 'Left Early' });
    const file = csv(
      ['admission_no', 'amount', 'note'],
      [await admissionOf(w, w.a.studentId), 0, ''],
      [await admissionOf(w, w.b.studentId), '1.50', ''],
      [await admissionOf(w, left.studentId), 100, ''],
      ['999999999999', 100, ''],
      [await admissionOf(w, w.a.studentId), 100, ''],
      [await admissionOf(w, w.c.studentId), 100, 'CNIC 42101-1234567-1'],
    );
    const res = await x.preview('opening-balances', fields(w), file, w.principal.cookie);
    expect(res.text).not.toMatch(/42101-1234567-1/);
    const body = res.body as ImportDetail;
    expect(body.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [2, 'amount', 'invalid_amount'],
      [3, 'amount', 'invalid_amount'],
      [4, 'admission_no', 'not_on_roster'],
      [5, 'admission_no', 'unknown_admission_no'],
      [6, 'admission_no', 'duplicate'],
      [7, 'note', 'identity_number'],
    ]);
    const refused = await x.commit(body.id, w.principal.cookie);
    expect([refused.status, errorOf(refused).code]).toEqual([422, ErrorCode.IMPORT_ROWS_INVALID]);
    expect(await db().charge.count({ where: { schoolId: w.school.id, importId: { not: null } } })).toBe(0);

    const past = await x.preview('opening-balances', fields(w, isoDay(-1)), csv(['admission_no', 'amount'], [await admissionOf(w, w.a.studentId), 10]), w.principal.cookie);
    expect([past.status, errorOf(past).details?.fields?.[0]?.path]).toEqual([422, 'dueOn']);
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: w.year.id }, data: { status: 'closed' } });
    const closed = await x.preview('opening-balances', fields(w), csv(['admission_no', 'amount'], [await admissionOf(w, w.a.studentId), 10]), w.principal.cookie);
    expect([closed.status, errorOf(closed).code]).toEqual([409, ErrorCode.IMPORT_YEAR_CLOSED]);
  });

  it('R355, §3.1: a principal only; inert on a default password (preview and commit); the office and another school are refused', async () => {
    const w = await h.world();
    const file = csv(['admission_no', 'amount'], [await admissionOf(w, w.a.studentId), 300]);
    const office = await x.preview('opening-balances', fields(w), file, w.office.cookie);
    expect([office.status, errorOf(office).details?.reason]).toEqual([403, 'principal_required']);
    expect((await x.preview('opening-balances', fields(w), file, w.teacher.cookie)).status).toBe(403);

    const user = await createSchoolUser(db(), w.school, { systemRole: 'principal', defaultPassword: true });
    const onDefault = await createSchoolSession(db(), w.school, user);
    const inert = await x.preview('opening-balances', fields(w), file, onDefault.cookie);
    expect([inert.status, errorOf(inert).code]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    const preview = (await x.preview('opening-balances', fields(w), file, w.principal.cookie)).body as ImportDetail;
    const commitInert = await x.commit(preview.id, onDefault.cookie);
    expect([commitInert.status, errorOf(commitInert).code]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);

    const other = await h.world({ name: 'Other School' });
    expect((await x.get(`/imports/${preview.id}`, other.principal.cookie)).status).toBe(404);
    expect((await x.commit(preview.id, other.principal.cookie)).status).toBe(404);
    expect((await x.get('/imports', other.principal.cookie)).body).toMatchObject({ total: 0 });
    // The other school's year is not this school's.
    const foreign = await x.preview('opening-balances', { academicYearId: w.year.id.toString(), dueOn: isoDay(2) }, file, other.principal.cookie, { key: newIdempotencyKey() });
    expect([foreign.status, errorOf(foreign).details?.fields?.[0]?.path]).toEqual([422, 'academicYearId']);
    // The office lists no opening-balances import either (not a principal).
    expect((await x.get('/imports', w.office.cookie)).body).toMatchObject({ total: 0 });
    expect((await x.commit(preview.id, w.principal.cookie)).status).toBe(200);
  });
});
