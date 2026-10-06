// Platform billing end to end (phase-3-financial.md slice 26, contracts/slice-26.md; R219-R224)
// over the real AppModule, the real platform guard and the real database, with fake messaging
// drivers. The billing tables are global and tests never truncate, so every plan here lives in a
// 100-student block no active plan holds (freeBlock), and every assertion is about this run's
// schools and invoices.
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { InvoiceStatus } from '@asms/shared';
import { todayIn } from '../../src/common/school-clock';
import { ENV, loadEnv } from '../../src/config/env';
import { BillingNotices, invoiceNoticeSubjectId } from '../../src/jobs/billing-notices';
import { SchoolMetricsRollup } from '../../src/jobs/school-metrics-rollup';
import { BillingRunService } from '../../src/modules/platform/billing/billing-run.service';
import { asSchool, FakeDrivers, messagingApp, messagingSchool } from '../messaging/support';
import { signedInPlatformAdmin, type TestPlatformSession } from '../support/platform';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createStudent } from '../support/students';

const BASE = '/api/v1/platform';
const ALERT_TO = 'billing-ops@example.test';
const TZ = 'Asia/Karachi';
const DAY_MS = 86_400_000;

interface Plan {
  id: string;
  name: string;
  minStudents: number;
  maxStudents: number | null;
  monthlyPrice: number;
  smsAllowance: number;
  status: 'active' | 'archived';
}
interface Subscription {
  id: string;
  planId: string;
  planName: string;
  startedOn: string;
  endedOn: string | null;
  pinned: boolean;
  assignedByPlatform: boolean;
}
interface Invoice {
  id: string;
  invoiceNo: string;
  schoolId: string;
  schoolName: string;
  yearMonth: string;
  planName: string;
  studentCount: number;
  amount: number;
  dueOn: string;
  status: InvoiceStatus;
  overdueAt: string | null;
  suspensionEligibleAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
}
interface Billing {
  subscription: Subscription | null;
  metrics: { day: string; activeStudents: number } | null;
  invoices: Invoice[];
  smsCap: { value: number; overridden: boolean };
  terminatedAt: string | null;
  retentionEndsOn: string | null;
}
interface IssueResult {
  issued: number;
  existing: number;
  skipped: { schoolId: string; reason: string }[];
  failed: number;
}
interface ErrorBody {
  error: { code: string; details: { planId?: string; fields?: { path: string; code: string }[] } | null };
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
/** Noon in Karachi on a calendar day: an instant whose Karachi date is that day. */
const noonOn = (day: Date): Date => new Date(day.getTime() + 7 * 3_600_000);

describe('platform billing (slice 26)', () => {
  let app: NestExpressApplication;
  let drivers: FakeDrivers;
  let admin: TestPlatformSession & { id: bigint };
  const origin = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
  const today = todayIn(TZ);
  const thisMonth = iso(today).slice(0, 7);
  const prevMonth = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))).slice(0, 7);
  const db = () => testDb();

  beforeAll(async () => {
    ({ app, drivers } = await messagingApp(undefined, [
      { provide: ENV, useValue: Object.freeze({ ...loadEnv(), PLATFORM_ALERT_EMAIL: ALERT_TO }) },
    ]));
    admin = await signedInPlatformAdmin();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(`${BASE}${path}`).set('Cookie', admin.cookie);
  const post = (path: string, body: object = {}) =>
    http().post(`${BASE}${path}`).set('Cookie', admin.cookie).set('Origin', origin).send(body);
  const patch = (path: string, body: object) =>
    http().patch(`${BASE}${path}`).set('Cookie', admin.cookie).set('Origin', origin).send(body);
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details?.fields ?? []).map((f) => `${f.path}:${f.code}`);
  const run = () => app.get(BillingRunService, { strict: false });

  /** The start of a 100-student block no active plan touches. */
  async function freeBlock(): Promise<number> {
    for (;;) {
      const base = 100_000 + randomInt(0, 8_900) * 100;
      const clash = await db().platformPlan.findFirst({
        where: {
          status: 'active',
          minStudents: { lte: base + 99 },
          OR: [{ maxStudents: null }, { maxStudents: { gte: base } }],
        },
      });
      if (!clash) return base;
    }
  }

  async function createPlan(min: number, max: number | null, price: number, allowance: number): Promise<Plan> {
    const res = await post('/plans', {
      name: `Tier ${min}`,
      minStudents: min,
      ...(max === null ? {} : { maxStudents: max }),
      monthlyPrice: price,
      smsAllowance: allowance,
    });
    expect(res.status).toBe(201);
    return res.body as Plan;
  }

  /** A school with a student count `daysAgo` days old (the rollup's row, written directly). */
  async function schoolWithCount(
    count: number | null,
    options: { status?: 'active' | 'suspended' | 'trial'; daysAgo?: number; name?: string } = {},
  ): Promise<TestSchool> {
    const school = await createSchool({ status: options.status ?? 'active', name: options.name ?? 'Billing School' });
    if (count !== null) {
      await db().platformSchoolMetric.create({
        data: { schoolId: school.id, day: addDays(today, -(options.daysAgo ?? 0)), activeStudents: count, computedAt: new Date() },
      });
    }
    return school;
  }

  const issue = async (yearMonth = thisMonth): Promise<IssueResult> => {
    const res = await post('/invoices/issue-month', { yearMonth });
    expect(res.status).toBe(200);
    return res.body as IssueResult;
  };
  const invoicesOf = (school: TestSchool, yearMonth = thisMonth) =>
    db().platformInvoice.findMany({ where: { schoolId: school.id, yearMonth }, orderBy: { id: 'asc' } });
  const liveSub = (school: TestSchool) =>
    db().platformSubscription.findFirst({ where: { schoolId: school.id, endedOn: null } });
  const schoolRow = (school: TestSchool) => db().school.findFirstOrThrow({ where: { id: school.id } });
  const billing = async (school: TestSchool): Promise<Billing> => {
    const res = await get(`/schools/${school.id}/billing`);
    expect(res.status).toBe(200);
    return res.body as Billing;
  };
  const audit = (action: string, subjectId: bigint | string) =>
    db().platformAuditLog.findMany({ where: { action, subjectId: BigInt(subjectId) }, orderBy: { id: 'asc' } });
  const dueDay = async () => (await db().platformSettings.findFirstOrThrow({ where: { id: 1n } })).invoiceDueDay;

  // ------------------------------------------------------------------------------------- R219

  describe('plans (R219)', () => {
    it('creates a plan, refuses an overlapping band, edits name, price and allowance but never the band', async () => {
      const base = await freeBlock();
      const small = await createPlan(base, base + 9, 5000, 300);
      expect(small).toMatchObject({ minStudents: base, maxStudents: base + 9, monthlyPrice: 5000, smsAllowance: 300, status: 'active' });
      expect(await audit('platform_plan.created', small.id)).toHaveLength(1);

      const overlap = await post('/plans', { name: 'Clash', minStudents: base + 9, maxStudents: base + 20, monthlyPrice: 1, smsAllowance: 1 });
      expect(overlap.status).toBe(409);
      expect(errorOf(overlap)).toMatchObject({ code: 'PLAN_BAND_OVERLAPS', details: { planId: small.id } });
      // An unbounded band starting inside it overlaps too.
      const open = await post('/plans', { name: 'Open', minStudents: base + 5, monthlyPrice: 1, smsAllowance: 1 });
      expect(errorOf(open).code).toBe('PLAN_BAND_OVERLAPS');
      const inverted = await post('/plans', { name: 'Inverted', minStudents: base + 50, maxStudents: base + 40, monthlyPrice: 1, smsAllowance: 1 });
      expect(inverted.status).toBe(422);
      expect(fieldsOf(inverted)).toEqual(['maxStudents:INVALID_VALUE']);
      // The adjacent band is free.
      await createPlan(base + 10, base + 19, 7000, 500);

      const edited = await patch(`/plans/${small.id}`, { name: 'Small school', monthlyPrice: 6000, smsAllowance: 350 });
      expect(edited.status).toBe(200);
      expect(edited.body as Plan).toMatchObject({ name: 'Small school', monthlyPrice: 6000, smsAllowance: 350, minStudents: base });
      const [updated] = await audit('platform_plan.updated', small.id);
      expect(updated?.metadata).toMatchObject({ changes: { monthlyPrice: { from: 5000, to: 6000 } } });
      // No change: no row.
      expect((await patch(`/plans/${small.id}`, { monthlyPrice: 6000 })).status).toBe(200);
      expect(await audit('platform_plan.updated', small.id)).toHaveLength(1);
      // Bands are frozen: the fields are not accepted at all.
      expect((await patch(`/plans/${small.id}`, { minStudents: 1 })).status).toBe(422);
      expect((await patch(`/plans/${small.id}`, { maxStudents: base + 50 })).status).toBe(422);

      expect((await get(`/plans/${small.id}`)).body as Plan).toMatchObject({ name: 'Small school' });
      expect((await get('/plans/999999999999')).status).toBe(404);
      const list = await get('/plans?status=active&limit=50');
      expect(list.status).toBe(200);
    });

    it('archives a plan nobody is on (final, repeatable), refuses one in use, and an archived band no longer blocks', async () => {
      const base = await freeBlock();
      const unused = await createPlan(base, base + 9, 1000, 100);
      const archived = await post(`/plans/${unused.id}/archive`, { reason: 'Price list replaced' });
      expect(archived.status).toBe(200);
      expect(archived.body as Plan).toMatchObject({ status: 'archived' });
      expect(await audit('platform_plan.archived', unused.id)).toHaveLength(1);
      expect((await post(`/plans/${unused.id}/archive`, { reason: 'Again' })).status).toBe(200);
      expect(await audit('platform_plan.archived', unused.id)).toHaveLength(1);
      const frozen = await patch(`/plans/${unused.id}`, { monthlyPrice: 1 });
      expect(errorOf(frozen).code).toBe('PLAN_ARCHIVED');
      // The archived band is free again.
      const replacement = await createPlan(base, base + 9, 1200, 120);

      const school = await schoolWithCount(base + 1);
      expect((await post(`/schools/${school.id}/assign-plan`, { planId: replacement.id, startedOn: iso(today), reason: 'Agreed price' })).status).toBe(200);
      const inUse = await post(`/plans/${replacement.id}/archive`, { reason: 'Try' });
      expect(inUse.status).toBe(409);
      expect(errorOf(inUse).code).toBe('PLAN_IN_USE');
    });

    it('two concurrent creates of overlapping bands: one is created, the other is PLAN_BAND_OVERLAPS', async () => {
      const base = await freeBlock();
      const body = (name: string, min: number) => ({ name, minStudents: min, maxStudents: min + 20, monthlyPrice: 1, smsAllowance: 1 });
      const results = await Promise.all([post('/plans', body('Race A', base)), post('/plans', body('Race B', base + 10))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(errorOf(results.find((r) => r.status === 409) ?? results[0]).code).toBe('PLAN_BAND_OVERLAPS');
      // Leave no active band behind that a later run could trip over.
      const winner = results.find((r) => r.status === 201)?.body as Plan;
      expect((await post(`/plans/${winner.id}/archive`, { reason: 'Test cleanup' })).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------- R220, A12

  describe('the monthly run (R220, A12)', () => {
    it('prices each school by the band holding its count, at the band edges, and skips with a reason', async () => {
      const base = await freeBlock();
      const a = await createPlan(base, base + 9, 1000, 100);
      const b = await createPlan(base + 10, base + 19, 2000, 200);
      const atTopOfA = await schoolWithCount(base + 9);
      const atBottomOfB = await schoolWithCount(base + 10);
      const atTopOfB = await schoolWithCount(base + 19);
      const noBand = await schoolWithCount(base + 20);
      const stale = await schoolWithCount(base + 1, { daysAgo: 8 });
      const sevenDaysOld = await schoolWithCount(base + 2, { daysAgo: 7 });
      const noCount = await schoolWithCount(null);
      const suspended = await schoolWithCount(base, { status: 'suspended' });
      const trial = await schoolWithCount(base + 3, { status: 'trial' });

      const counterBefore = (await db().platformSettings.findFirstOrThrow({ where: { id: 1n } })).invoiceCounter;
      const first = await issue();
      const counterAfter = (await db().platformSettings.findFirstOrThrow({ where: { id: 1n } })).invoiceCounter;
      // Gapless: the counter moved exactly once per invoice written.
      expect(counterAfter - counterBefore).toBe(first.issued);
      expect(first.failed).toBe(0);
      const skipped = (school: TestSchool) => first.skipped.filter((s) => s.schoolId === school.id.toString()).map((s) => s.reason);
      expect(skipped(noBand)).toEqual(['no_band']);
      expect(skipped(stale)).toEqual(['no_metrics']);
      expect(skipped(noCount)).toEqual(['no_metrics']);
      // Trial schools are not billable at all: neither invoiced nor listed.
      expect(skipped(trial)).toEqual([]);
      expect(await invoicesOf(trial)).toHaveLength(0);

      const due = `${thisMonth}-${String(await dueDay()).padStart(2, '0')}`;
      const expectInvoice = async (school: TestSchool, plan: Plan, count: number) => {
        const rows = await invoicesOf(school);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ planId: BigInt(plan.id), amount: plan.monthlyPrice, studentCount: count, status: 'issued' });
        expect(rows[0]?.invoiceNo).toMatch(/^INV-\d{4}-\d{5}$/);
        expect(iso(rows[0]!.dueOn)).toBe(due);
        // The derived tier is the school's live subscription, from the 1st, written by the run.
        expect(await liveSub(school)).toMatchObject({ planId: BigInt(plan.id), pinned: false, assignedBy: null });
        // A12: the plan's allowance is the cap (not overridden).
        expect(await schoolRow(school)).toMatchObject({ smsMonthlyCap: plan.smsAllowance, smsCapOverridden: false });
        return rows[0]!;
      };
      const invoiceA = await expectInvoice(atTopOfA, a, base + 9);
      await expectInvoice(atBottomOfB, b, base + 10);
      await expectInvoice(atTopOfB, b, base + 19);
      await expectInvoice(sevenDaysOld, a, base + 2);
      // Rule 23: a suspended school is invoiced.
      await expectInvoice(suspended, a, base);
      expect((await liveSub(atTopOfA))?.startedOn).toEqual(new Date(`${thisMonth}-01T00:00:00.000Z`));
      // A hand run audits each invoice it writes, with its actor.
      expect(await audit('platform_invoice.issued', invoiceA.id)).toMatchObject([{ actorPlatformUserId: admin.id }]);

      // Idempotent per school and month.
      const second = await issue();
      expect(second.existing).toBeGreaterThanOrEqual(5);
      expect(await invoicesOf(atTopOfA)).toHaveLength(1);
      expect(await audit('platform_invoice.issued', invoiceA.id)).toHaveLength(1);

      // The invoice list and one invoice, as the console reads them.
      const listed = await get(`/invoices?schoolId=${atTopOfA.id}&yearMonth=${thisMonth}`);
      expect((listed.body as { data: Invoice[] }).data).toMatchObject([
        { id: invoiceA.id.toString(), planName: a.name, amount: 1000, studentCount: base + 9, status: 'issued', dueOn: due },
      ]);
      expect((await get(`/invoices/${invoiceA.id}`)).body as Invoice).toMatchObject({ invoiceNo: invoiceA.invoiceNo });
      expect((await get('/invoices/999999999999')).status).toBe(404);
      expect((await post('/invoices/issue-month', { yearMonth: '2999-01' })).status).toBe(422);
    });

    it('a count that moves band changes the tier: the old subscription ends, the new one starts on the 1st', async () => {
      const base = await freeBlock();
      const a = await createPlan(base, base + 9, 1000, 100);
      const b = await createPlan(base + 10, base + 19, 2000, 200);
      const school = await schoolWithCount(base + 5);
      await issue(prevMonth);
      expect(await liveSub(school)).toMatchObject({ planId: BigInt(a.id), startedOn: new Date(`${prevMonth}-01T00:00:00.000Z`) });
      await db().platformSchoolMetric.updateMany({ where: { schoolId: school.id }, data: { activeStudents: base + 15 } });
      await issue();
      const subs = await db().platformSubscription.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
      expect(subs).toMatchObject([
        { planId: BigInt(a.id), endedOn: new Date(new Date(`${thisMonth}-01T00:00:00.000Z`).getTime() - DAY_MS) },
        { planId: BigInt(b.id), startedOn: new Date(`${thisMonth}-01T00:00:00.000Z`), endedOn: null },
      ]);
      expect((await invoicesOf(school))[0]).toMatchObject({ amount: 2000 });
      expect((await invoicesOf(school, prevMonth))[0]).toMatchObject({ amount: 1000 });
      // The same tier next time continues the live row.
      await issue();
      expect(await db().platformSubscription.count({ where: { schoolId: school.id } })).toBe(2);
    });

    it('a school turning active mid-month is free until the next 1st; one created active is billed', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 1000, 100);
      const created = await post('/schools', { name: 'Mid Month School', shortCode: `mm${randomInt(100_000, 999_999)}` });
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      expect((await post(`/schools/${id}/change-status`, { status: 'active', reason: 'Contract signed' })).status).toBe(200);
      const school = { id: BigInt(id) } as TestSchool;
      await db().platformSchoolMetric.create({ data: { schoolId: BigInt(id), day: today, activeStudents: base + 1, computedAt: new Date() } });
      const result = await issue();
      expect(result.skipped.filter((s) => s.schoolId === id)).toEqual([{ schoolId: id, reason: 'trial' }]);
      expect(await invoicesOf(school)).toHaveLength(0);
      const always = await schoolWithCount(base + 1);
      await issue();
      expect(await invoicesOf(always)).toHaveLength(1);
    });

    it('a free plan issues its invoice already paid', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 0, 50);
      const school = await schoolWithCount(base);
      await issue();
      expect((await invoicesOf(school))[0]).toMatchObject({ amount: 0, status: 'paid' });
      expect((await invoicesOf(school))[0]?.paidAt).not.toBeNull();
    });

    it('the scheduled run alerts the platform mailbox about schools it skipped, and audits nothing', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 1000, 100);
      const billed = await schoolWithCount(base + 4);
      await schoolWithCount(base + 50, { name: 'Unbanded Academy' });
      drivers.calls.length = 0;
      const result = await run().issueMonth(thisMonth, null);
      expect(result.issued).toBeGreaterThanOrEqual(1);
      const [invoice] = await invoicesOf(billed);
      expect(invoice).toBeDefined();
      expect(await audit('platform_invoice.issued', invoice!.id)).toHaveLength(0);
      const mails = drivers.of('email').filter((m) => m.to === ALERT_TO);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.template).toMatch(/schools? not invoiced for /);
      expect(mails[0]?.text).toContain('no plan band holds its student count');
    });

    it('the daily run issues the month only on the 1st', async () => {
      const spy = jest.spyOn(run(), 'issueMonth').mockResolvedValue({ issued: 0, existing: 0, skipped: [], failed: 0 });
      // The stamps of a November day would mark every October invoice of this database overdue.
      const stamps = jest.spyOn(run(), 'stamp').mockResolvedValue({ overdue: 0, eligible: 0 });
      try {
        await run().daily(new Date('2026-11-01T01:00:00+05:00'));
        expect(spy).toHaveBeenCalledWith('2026-11', null, expect.any(Date));
        spy.mockClear();
        await run().daily(new Date('2026-11-02T01:00:00+05:00'));
        expect(spy).not.toHaveBeenCalled();
        expect(stamps).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
        stamps.mockRestore();
      }
    });
  });

  // ------------------------------------------------------------------------------- R223, A12

  describe('pins and the SMS cap (R223, A12)', () => {
    it('a manual cap patch sets the override, the run leaves it, and "use the plan allowance" clears it', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 1000, 100);
      const school = await schoolWithCount(base + 2);
      const patched = await patch(`/schools/${school.id}`, { smsMonthlyCap: 777 });
      expect(patched.body).toMatchObject({ smsMonthlyCap: 777, smsCapOverridden: true });
      const [updated] = await db().platformAuditLog.findMany({ where: { schoolId: school.id, action: 'school.updated' } });
      expect(updated?.metadata).toMatchObject({ changes: { smsCapOverridden: { from: false, to: true } } });
      await issue();
      expect(await schoolRow(school)).toMatchObject({ smsMonthlyCap: 777, smsCapOverridden: true });
      expect((await billing(school)).smsCap).toEqual({ value: 777, overridden: true });

      const cleared = await post(`/schools/${school.id}/use-plan-allowance`);
      expect(cleared.status).toBe(200);
      expect((cleared.body as Billing).smsCap).toEqual({ value: 100, overridden: false });
      expect(await audit('school.sms_cap_override_cleared', school.id)).toHaveLength(1);
      // Not overridden: nothing to clear, no row.
      expect((await post(`/schools/${school.id}/use-plan-allowance`)).status).toBe(200);
      expect(await audit('school.sms_cap_override_cleared', school.id)).toHaveLength(1);
    });

    it('assign-plan pins the school, sets the cap and clears the override; the run bills the pin; unpin returns to the derived tier', async () => {
      const base = await freeBlock();
      const a = await createPlan(base, base + 9, 1000, 100);
      const b = await createPlan(base + 10, base + 19, 2000, 200);
      const school = await schoolWithCount(base + 3);
      await patch(`/schools/${school.id}`, { smsMonthlyCap: 900 });

      const assigned = await post(`/schools/${school.id}/assign-plan`, { planId: b.id, startedOn: `${thisMonth}-01`, reason: 'Negotiated rate' });
      expect(assigned.status).toBe(200);
      const pin = assigned.body as Subscription;
      expect(pin).toMatchObject({ planId: b.id, pinned: true, assignedByPlatform: true, startedOn: `${thisMonth}-01`, endedOn: null });
      expect(await schoolRow(school)).toMatchObject({ smsMonthlyCap: 200, smsCapOverridden: false });
      expect(await audit('platform_subscription.assigned', pin.id)).toMatchObject([
        { actorPlatformUserId: admin.id, reason: 'Negotiated rate' },
      ]);
      // Idempotent by state.
      const again = await post(`/schools/${school.id}/assign-plan`, { planId: b.id, startedOn: `${thisMonth}-01`, reason: 'Again' });
      expect((again.body as Subscription).id).toBe(pin.id);
      expect(await audit('platform_subscription.assigned', pin.id)).toHaveLength(1);

      // Billed on the pin whatever the count (it started on the month's 1st).
      await issue();
      expect((await invoicesOf(school))[0]).toMatchObject({ planId: BigInt(b.id), amount: 2000 });

      const early = await post(`/schools/${school.id}/assign-plan`, { planId: a.id, startedOn: iso(addDays(today, -400)), reason: 'Backdated' });
      expect(early.status).toBe(422);
      expect(fieldsOf(early)).toEqual(['startedOn:INVALID_VALUE']);
      const unknown = await post(`/schools/${school.id}/assign-plan`, { planId: '999999999999', startedOn: iso(today), reason: 'Nope' });
      expect(fieldsOf(unknown)).toEqual(['planId:REFERENCE_NOT_FOUND']);
      const noReason = await post(`/schools/${school.id}/assign-plan`, { planId: a.id, startedOn: iso(today) });
      expect(noReason.status).toBe(422);

      const unpinned = await post(`/schools/${school.id}/unpin-plan`, { reason: 'Back to the price list' });
      expect(unpinned.status).toBe(200);
      const view = unpinned.body as Billing;
      expect(view.subscription).toMatchObject({ planId: a.id, pinned: false, startedOn: iso(today) });
      expect(view.smsCap).toEqual({ value: 100, overridden: false });
      expect(await audit('platform_subscription.unpinned', pin.id)).toHaveLength(1);
      expect((await post(`/schools/${school.id}/unpin-plan`, { reason: 'Again' })).status).toBe(200);
      expect(await audit('platform_subscription.unpinned', pin.id)).toHaveLength(1);
      const history = await db().platformSubscription.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
      expect(history.map((s) => [s.planId.toString(), s.pinned, s.endedOn === null])).toEqual([
        [b.id, true, false],
        [a.id, false, true],
      ]);
    });

    it("a pin starting after the month's 1st does not price that month: the count does, and the pin stays", async () => {
      const base = await freeBlock();
      const a = await createPlan(base, base + 9, 1000, 100);
      const b = await createPlan(base + 10, base + 19, 2000, 200);
      const school = await schoolWithCount(base + 3);
      const nextFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      const pinned = await post(`/schools/${school.id}/assign-plan`, { planId: b.id, startedOn: iso(nextFirst), reason: 'From next month' });
      expect(pinned.status).toBe(200);
      await issue();
      expect((await invoicesOf(school))[0]).toMatchObject({ planId: BigInt(a.id), amount: 1000 });
      // The future pin is left as it is: it bills from its own month.
      expect(await liveSub(school)).toMatchObject({ planId: BigInt(b.id), pinned: true, startedOn: nextFirst, endedOn: null });
      // Nor does a pin starting later in the billed month itself.
      const midMonth = await schoolWithCount(base + 4);
      if (today.getUTCDate() > 1) {
        await post(`/schools/${midMonth.id}/assign-plan`, { planId: b.id, startedOn: iso(today), reason: 'From today' });
        await issue();
        expect((await invoicesOf(midMonth))[0]).toMatchObject({ planId: BigInt(a.id) });
      }
    });

    it('a trial school may hold a plan; an archived plan and a terminated school are refused', async () => {
      const base = await freeBlock();
      const plan = await createPlan(base, base + 9, 1000, 100);
      const old = await createPlan(base + 10, base + 19, 1000, 100);
      await post(`/plans/${old.id}/archive`, { reason: 'Retired' });
      const trial = await createSchool({ status: 'trial' });
      expect((await post(`/schools/${trial.id}/assign-plan`, { planId: plan.id, startedOn: iso(today), reason: 'Pilot price' })).status).toBe(200);
      const archived = await post(`/schools/${trial.id}/assign-plan`, { planId: old.id, startedOn: iso(today), reason: 'Old price' });
      expect(errorOf(archived).code).toBe('PLAN_ARCHIVED');
      const gone = await createSchool({ status: 'terminated' });
      const refused = await post(`/schools/${gone.id}/assign-plan`, { planId: plan.id, startedOn: iso(today), reason: 'Late' });
      expect(errorOf(refused).code).toBe('SCHOOL_TERMINATED');
      expect((await post('/schools/999999999999/assign-plan', { planId: plan.id, startedOn: iso(today), reason: 'x y z' })).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------- A11

  describe('payments and voids', () => {
    it('records the full amount once, voids an issued invoice, and the next run issues the month again', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 4500, 100);
      const paid = await schoolWithCount(base);
      const voided = await schoolWithCount(base + 1);
      await issue();
      const [invoice] = await invoicesOf(paid);
      const path = `/invoices/${invoice!.id}`;

      const partial = await post(`${path}/record-payment`, { amount: 4000, receivedOn: iso(today), reference: 'TRX-1001' });
      expect(fieldsOf(partial)).toEqual(['amount:INVALID_VALUE']);
      const future = await post(`${path}/record-payment`, { amount: 4500, receivedOn: iso(addDays(today, 2)), reference: 'TRX-1001' });
      expect(fieldsOf(future)).toEqual(['receivedOn:INVALID_VALUE']);
      const ok = await post(`${path}/record-payment`, { amount: 4500, receivedOn: iso(today), reference: 'TRX-1001' });
      expect(ok.status).toBe(200);
      expect(ok.body as Invoice).toMatchObject({ status: 'paid' });
      expect(await db().platformPayment.findMany({ where: { invoiceId: invoice!.id } })).toMatchObject([
        { amount: 4500, reference: 'TRX-1001', recordedBy: admin.id },
      ]);
      expect(await audit('platform_invoice.paid', invoice!.id)).toMatchObject([{ actorPlatformUserId: admin.id }]);
      const twice = await post(`${path}/record-payment`, { amount: 4500, receivedOn: iso(today), reference: 'TRX-1002' });
      expect(errorOf(twice).code).toBe('INVOICE_NOT_ISSUED');
      expect(errorOf(await post(`${path}/void`, { reason: 'Billed in error' })).code).toBe('INVOICE_NOT_ISSUED');

      const [toVoid] = await invoicesOf(voided);
      const v = await post(`/invoices/${toVoid!.id}/void`, { reason: 'Wrong month' });
      expect(v.status).toBe(200);
      expect(v.body as Invoice).toMatchObject({ status: 'void' });
      expect(await audit('platform_invoice.voided', toVoid!.id)).toMatchObject([{ reason: 'Wrong month' }]);
      expect(errorOf(await post(`/invoices/${toVoid!.id}/void`, { reason: 'Again' })).code).toBe('INVOICE_NOT_ISSUED');
      await issue();
      const reissued = await invoicesOf(voided);
      expect(reissued.map((r) => r.status)).toEqual(['void', 'issued']);
      expect(reissued[1]?.invoiceNo).not.toBe(reissued[0]?.invoiceNo);
    });
  });

  // ------------------------------------------------------------------------------------- R221

  describe('overdue and suspension eligibility (R221)', () => {
    it('stamps overdue the day after due, eligible after the grace days, lists eligible schools, and suspends nobody', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 3000, 100);
      const unpaid = await schoolWithCount(base);
      const settled = await schoolWithCount(base + 1);
      await issue();
      const [invoice] = await invoicesOf(unpaid);
      const [other] = await invoicesOf(settled);
      await post(`/invoices/${other!.id}/record-payment`, { amount: 3000, receivedOn: iso(today), reference: 'PAID-1' });
      const { graceDays } = await db().platformSettings.findFirstOrThrow({ where: { id: 1n } });

      await run().stamp(noonOn(invoice!.dueOn));
      expect(await db().platformInvoice.findFirstOrThrow({ where: { id: invoice!.id } })).toMatchObject({ overdueAt: null });
      await run().stamp(noonOn(addDays(invoice!.dueOn, 1)));
      const overdue = await db().platformInvoice.findFirstOrThrow({ where: { id: invoice!.id } });
      expect(overdue.overdueAt).not.toBeNull();
      expect(overdue.suspensionEligibleAt).toBeNull();
      await run().stamp(noonOn(addDays(invoice!.dueOn, graceDays + 1)));
      const eligible = await db().platformInvoice.findFirstOrThrow({ where: { id: invoice!.id } });
      expect(eligible.suspensionEligibleAt).not.toBeNull();
      // Stamped once: a later run does not move it.
      await run().stamp(noonOn(addDays(invoice!.dueOn, graceDays + 5)));
      expect((await db().platformInvoice.findFirstOrThrow({ where: { id: invoice!.id } })).suspensionEligibleAt).toEqual(eligible.suspensionEligibleAt);
      // A paid invoice is never stamped.
      expect(await db().platformInvoice.findFirstOrThrow({ where: { id: other!.id } })).toMatchObject({ overdueAt: null, suspensionEligibleAt: null });

      const listed = async (schoolId: bigint, flag: boolean) =>
        ((await get(`/invoices?schoolId=${schoolId}&suspensionEligible=${flag}`)).body as { data: Invoice[] }).data.map((i) => i.id);
      expect(await listed(unpaid.id, true)).toEqual([invoice!.id.toString()]);
      expect(await listed(unpaid.id, false)).toEqual([]);
      expect(await listed(settled.id, true)).toEqual([]);
      // Nothing suspends automatically.
      expect(await schoolRow(unpaid)).toMatchObject({ status: 'active' });
    });
  });

  // ------------------------------------------------------------------------------------- A18

  describe("the school's side (A18)", () => {
    it('GET /school/billing-status shows its own plan and invoice, and another school sees none of it', async () => {
      const base = await freeBlock();
      const plan = await createPlan(base, base + 9, 2500, 150);
      const school = await schoolWithCount(base + 4);
      await issue();
      const [invoice] = await invoicesOf(school);
      await run().stamp(noonOn(addDays(invoice!.dueOn, 1)));
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const session = await createSchoolSession(db(), school, principal);
      const res = await http().get('/api/v1/school/billing-status').set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        plan: { name: plan.name, smsAllowance: 150 },
        currentInvoice: { invoiceNo: invoice!.invoiceNo, yearMonth: thisMonth, amount: 2500, dueOn: iso(invoice!.dueOn), status: 'issued' },
        overdue: true,
        suspensionEligibleAt: null,
      });

      const stranger = await createSchool();
      const theirPrincipal = await createSchoolUser(db(), stranger, { systemRole: 'principal' });
      const theirs = await http()
        .get('/api/v1/school/billing-status')
        .set('Cookie', (await createSchoolSession(db(), stranger, theirPrincipal)).cookie);
      expect(theirs.body).toEqual({ plan: null, currentInvoice: null, overdue: false, suspensionEligibleAt: null });

      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const refused = await http().get('/api/v1/school/billing-status').set('Cookie', (await createSchoolSession(db(), school, teacher)).cookie);
      expect(refused.status).toBe(403);
    });

    it('billing-notices tells each principal once per stage: issued, overdue, then eligible', async () => {
      const base = await freeBlock();
      await createPlan(base, base + 9, 2500, 150);
      // NotificationService reads the school's settings row.
      const school = await messagingSchool();
      await db().platformSchoolMetric.create({ data: { schoolId: school.id, day: today, activeStudents: base + 6, computedAt: new Date() } });
      const p1 = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const p2 = await createSchoolUser(db(), school, { systemRole: 'principal' });
      await issue();
      const [invoice] = await invoicesOf(school);
      const notices = app.get(BillingNotices, { strict: false });
      const messages = () =>
        db().message.findMany({ where: { schoolId: school.id, subjectType: 'platform_invoice' }, orderBy: { id: 'asc' } });

      expect(await asSchool(app, school.id, () => notices.run(school.id))).toBe(2);
      expect(await asSchool(app, school.id, () => notices.run(school.id))).toBe(0);
      let rows = await messages();
      expect(rows.map((m) => [m.type, m.subjectId, m.staffId])).toEqual([
        ['platform_invoice_issued', invoiceNoticeSubjectId(invoice!.id, 'issued'), p1.staffId],
        ['platform_invoice_issued', invoiceNoticeSubjectId(invoice!.id, 'issued'), p2.staffId],
      ]);
      // R238: no amount travels in the body.
      expect(rows[0]?.body).not.toContain('2500');
      expect(rows[0]?.body).toContain(invoice!.invoiceNo);

      const { graceDays } = await db().platformSettings.findFirstOrThrow({ where: { id: 1n } });
      await run().stamp(noonOn(addDays(invoice!.dueOn, 1)));
      expect(await asSchool(app, school.id, () => notices.run(school.id))).toBe(2);
      await run().stamp(noonOn(addDays(invoice!.dueOn, graceDays + 1)));
      expect(await asSchool(app, school.id, () => notices.run(school.id))).toBe(2);
      rows = await messages();
      expect(rows.map((m) => m.type)).toEqual([
        'platform_invoice_issued',
        'platform_invoice_issued',
        'platform_invoice_overdue',
        'platform_invoice_overdue',
        'platform_invoice_overdue',
        'platform_invoice_overdue',
      ]);
      expect(rows[4]?.body).toContain('grace period has ended');
      // Paid: no further notice.
      await post(`/invoices/${invoice!.id}/record-payment`, { amount: 2500, receivedOn: iso(today), reference: 'PAID-2' });
      expect(await asSchool(app, school.id, () => notices.run(school.id))).toBe(0);
    });

    it('school-metrics-rollup writes the day count of students on the roll, rewritten by a re-run', async () => {
      const school = await createSchool();
      for (const status of ['active', 'active', 'suspended', 'withdrawn'] as const) await createStudent(db(), school, { status });
      const rollup = app.get(SchoolMetricsRollup, { strict: false });
      expect(await rollup.run(school.id)).toBe(3);
      await createStudent(db(), school);
      expect(await rollup.run(school.id)).toBe(4);
      expect(await db().platformSchoolMetric.findMany({ where: { schoolId: school.id } })).toMatchObject([
        { day: today, activeStudents: 4 },
      ]);
      expect((await billing(school)).metrics).toEqual({ day: iso(today), activeStudents: 4 });
    });
  });

  // ------------------------------------------------------------------------------------- R224

  describe('termination and settings (R224)', () => {
    it('terminating stamps terminated_at and the console shows the retention end, 12 months on', async () => {
      const school = await createSchool();
      expect((await post(`/schools/${school.id}/change-status`, { status: 'terminated', reason: 'Contract ended' })).status).toBe(200);
      const row = await schoolRow(school);
      expect(row.terminatedAt).not.toBeNull();
      const karachi = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(row.terminatedAt!);
      const expected = `${Number(karachi.slice(0, 4)) + 1}${karachi.slice(4)}`;
      const dto = (await get(`/schools/${school.id}`)).body as { terminatedAt: string; retentionEndsOn: string };
      expect(dto.retentionEndsOn).toBe(expected);
      expect(dto.terminatedAt).toBe(row.terminatedAt!.toISOString());
      expect(await billing(school)).toMatchObject({ terminatedAt: row.terminatedAt!.toISOString(), retentionEndsOn: expected });
    });

    it('invoice due day and grace days are platform settings', async () => {
      const before = (await get('/settings')).body as { invoiceDueDay: number; graceDays: number };
      try {
        const res = await patch('/settings', { invoiceDueDay: 12, graceDays: 20 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ invoiceDueDay: 12, graceDays: 20 });
        expect((await patch('/settings', { invoiceDueDay: 29 })).status).toBe(422);
        expect((await patch('/settings', { graceDays: 91 })).status).toBe(422);
      } finally {
        await patch('/settings', { invoiceDueDay: before.invoiceDueDay, graceDays: before.graceDays });
      }
    });
  });
});
