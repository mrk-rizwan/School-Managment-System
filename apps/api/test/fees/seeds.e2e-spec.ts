// R176 and §3.5: a school's finance seeds. A school created by the platform gets the five fee heads
// (created_by null) and the expense_no counter in the creating transaction; an existing school
// gets them from the migration's backfill, which calls the same function; every academic year gets
// its receipt counter when it is created (and existing years from the backfill).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { receiptCounterName, SEEDED_FEE_HEADS, SEEDED_LEAVE_TYPES } from '@asms/shared';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, uniqueShortCode } from '../support/schools';
import { ORIGIN } from '../school-auth/support';

const db = () => testDb();

const seededHeads = (schoolId: bigint) =>
  db().feeHead.findMany({
    where: { schoolId, createdBy: null },
    select: { name: true, category: true, frequency: true, concessionEligible: true, refundable: true },
    orderBy: { id: 'asc' },
  });

// Slice 24: the three leave types, seeded by the same function (SEEDED_LEAVE_TYPES says what it writes).
const seededLeaveTypes = (schoolId: bigint) =>
  db().leaveType.findMany({
    where: { schoolId, createdBy: null },
    select: { name: true, code: true, daysPerYear: true, paid: true },
    orderBy: { id: 'asc' },
  });

describe('finance seeds (R176, §3.5)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R176: a school created by the platform has the five seeded heads and the expense_no counter', async () => {
    const admin = await signedInPlatformAdmin();
    const res = await http()
      .post('/api/v1/platform/schools')
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .send({ name: 'Seeded School', shortCode: uniqueShortCode() })
      .expect(201);
    const schoolId = BigInt((res.body as { id: string }).id);
    expect(await seededHeads(schoolId)).toEqual(SEEDED_FEE_HEADS.map((h) => ({ ...h })));
    expect(await seededLeaveTypes(schoolId)).toEqual(SEEDED_LEAVE_TYPES.map((t) => ({ ...t })));
    const counters = await db().schoolCounter.findMany({ where: { schoolId }, select: { name: true, value: true }, orderBy: { name: 'asc' } });
    expect(counters).toEqual([
      { name: 'admission_no', value: 0n },
      { name: 'expense_no', value: 0n },
    ]);
  });

  it('R176: the backfill (asms_seed_school_finance) seeds an existing school once, the same rows as SEEDED_FEE_HEADS', async () => {
    const school = await createSchool();
    expect(await seededHeads(school.id)).toEqual([]);
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    expect(await seededHeads(school.id)).toEqual(SEEDED_FEE_HEADS.map((h) => ({ ...h })));
    expect(await seededLeaveTypes(school.id)).toEqual(SEEDED_LEAVE_TYPES.map((t) => ({ ...t })));
    expect(await db().schoolCounter.count({ where: { schoolId: school.id, name: 'expense_no' } })).toBe(1);
    // Another school is untouched.
    const other = await createSchool();
    expect(await seededHeads(other.id)).toEqual([]);
  });

  it('§3.5: creating an academic year creates its receipt counter in the same transaction', async () => {
    const school = await createSchool();
    const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const session = await createSchoolSession(db(), school, user);
    const res = await http()
      .post('/api/v1/academic-years')
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .send({ name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31' })
      .expect(201);
    const yearId = (res.body as { id: string }).id;
    const counter = await db().schoolCounter.findFirst({ where: { schoolId: school.id, name: receiptCounterName(yearId) } });
    expect(counter?.value).toBe(0n);
  });

  it('§3.5: every academic year in the database has its receipt counter (backfill and creation)', async () => {
    const missing = await db().$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM academic_years y
      WHERE y.created_at < (SELECT max(finished_at) FROM _prisma_migrations WHERE migration_name LIKE '%slice18_fee_setup')
        AND NOT EXISTS (SELECT 1 FROM school_counters c WHERE c.school_id = y.school_id AND c.name = 'receipt_' || y.id)`;
    expect(missing[0]?.n).toBe(0n);
  });
});
