// R222 / A18 (contracts/slice-26.md §1.4, §3): a school reads its own platform bill and nothing
// else. OwnInvoicesRepository's every predicate is the caller's SchoolId; the platform tables hold
// no tenant row (they are NON_TENANT_MODELS, held to that by test/guardrails/schema-checks.ts), and
// lint keeps every billing repository out of tenant code (test/guardrails/lint-boundaries.spec.ts).
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OwnInvoicesRepository } from '../../src/repositories/own-invoices.repository';
import { NON_TENANT_MODELS } from '../../src/repositories/query-guard';
import { createTestApp } from '../core/app';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';

describe('platform billing isolation (R222, A18)', () => {
  let app: NestExpressApplication;
  const db = () => testDb();

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it("OwnInvoicesRepository: school B reads none of school A's plan or invoices", async () => {
    const two = await createTwoSchools();
    const { a, b } = two;
    // An archived plan: a live subscription may name it in this probe (no overlap risk), and the
    // repository reads the plan by the subscription's id, never by status.
    const min = 2_000_000_000 + randomInt(0, 100_000_000);
    const plan = await db().platformPlan.create({
      data: { name: 'Probe tier', minStudents: min, maxStudents: min, monthlyPrice: 900, smsAllowance: 90 },
    });
    await db().platformSubscription.create({
      data: { schoolId: a.id, planId: plan.id, startedOn: new Date('2026-10-01T00:00:00.000Z') },
    });
    const invoice = await db().platformInvoice.create({
      data: {
        schoolId: a.id,
        invoiceNo: `INV-2099-${String(randomInt(0, 100_000)).padStart(5, '0')}`,
        yearMonth: '2099-01',
        planId: plan.id,
        studentCount: 10,
        amount: 900,
        dueOn: new Date('2099-01-10T00:00:00.000Z'),
      },
    });
    await db().platformPlan.update({ where: { id: plan.id }, data: { status: 'archived', archivedAt: new Date() } });

    const repo = app.get(OwnInvoicesRepository, { strict: false });
    expect(await repo.livePlan(a.id)).toEqual({ name: 'Probe tier', smsAllowance: 90 });
    expect((await repo.latest(a.id))?.id).toBe(invoice.id);
    expect((await repo.unpaid(a.id)).map((i) => i.id)).toEqual([invoice.id]);

    expect(await repo.livePlan(b.id)).toBeNull();
    expect(await repo.latest(b.id)).toBeNull();
    expect(await repo.unpaid(b.id)).toEqual([]);
  });

  it('the five billing tables are non-tenant tables (no tenant row, no tenant scoping)', () => {
    for (const model of ['PlatformPlan', 'PlatformSubscription', 'PlatformSchoolMetric', 'PlatformInvoice', 'PlatformPayment']) {
      expect(Object.hasOwn(NON_TENANT_MODELS, model)).toBe(true);
    }
  });
});
