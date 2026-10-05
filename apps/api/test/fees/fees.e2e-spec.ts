// Slice 18 over HTTP (phase-3-financial.md slice 18): fee heads (R176), fee structures (R177),
// payment accounts and the principal gate (R233), the guardian's where-to-pay read, the Phase 3
// settings (R178) and the finance readers (R234). The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createGuardianUser } from '../school-auth/support';
import { createAcademicYear, createClass, createStudent, linkGuardian } from '../support/students';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const db = () => testDb();

interface ErrorBody {
  error: { code: string; details: { reason?: string; feeHeadId?: string; structureId?: string; latestEffectiveFrom?: string; fields?: { path: string; code: string; message?: string }[] } };
}
type Json = Record<string, unknown>;
interface Page<T> {
  data: T[];
  total: number;
}
interface FeeHead {
  id: string;
  name: string;
  category: string;
  frequency: string;
  concessionEligible: boolean;
  refundable: boolean;
  status: string;
  archiveReason: string | null;
  seeded: boolean;
}
interface Structure {
  id: string;
  amount: number;
  effectiveFrom: string;
  status: string;
  supersededBy: string | null;
  reason: string | null;
}
interface StructureClass {
  classId: string;
  className: string;
  heads: { feeHeadId: string; amount: number; effectiveFrom: string; structureId: string }[];
  history: Structure[];
}

describe('slice 18: fee setup, payment accounts and settings (e2e)', () => {
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
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const send = (method: 'post' | 'patch', path: string, body: object, s: { cookie: string }, headers: Record<string, string> = {}) => {
    const req = http()[method](`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(body);
  };
  const post = (path: string, body: object, s: { cookie: string }, headers?: Record<string, string>) =>
    send('post', path, body, s, headers);
  const patch = (path: string, body: object, s: { cookie: string }) => send('patch', path, body, s);
  const err = (res: request.Response) => res.body as ErrorBody;
  const auditRows = (schoolId: bigint, action: string) =>
    db().auditLog.findMany({ where: { schoolId, action }, orderBy: { id: 'asc' } });
  const seedHeads = async (school: TestSchool) => {
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
  };
  const grant = async (to: TestSchoolUser, by: TestSchoolUser, capability: Capability) =>
    db().userCapabilityGrant.create({
      data: { schoolId: to.schoolId, userId: to.userId, capabilityKey: capability, effect: 'grant', grantedBy: by.userId, reason: 'Test grant' },
    });

  // ------------------------------------------------------------------------------- fee heads

  describe('fee heads (R176)', () => {
    it('lists the seeded heads; creates, edits and archives; refuses duplicates and the forbidden flags', async () => {
      const school = await createSchool();
      await seedHeads(school);
      const principal = await signIn('principal', school);

      const list = await get('/fee-heads', principal).expect(200);
      const heads = (list.body as Page<FeeHead>).data;
      expect(heads.map((h) => [h.name, h.category, h.frequency, h.concessionEligible, h.refundable, h.seeded])).toEqual([
        ['Admission', 'admission', 'once', true, false, true],
        ['Annual charges', 'annual', 'yearly', true, true, true],
        ['Exam', 'exam', 'per_term', true, true, true],
        ['Fine', 'fine', 'ad_hoc', false, true, true],
        ['Tuition', 'tuition', 'monthly', true, true, true],
      ]);

      // At most one live tuition and one live fine head; names are unique case-insensitively.
      const tuition = heads.find((h) => h.category === 'tuition')!;
      const second = await post('/fee-heads', { name: 'Tuition two', category: 'tuition', frequency: 'monthly' }, principal);
      expect([second.status, err(second).error.code, err(second).error.details.feeHeadId]).toEqual([409, ErrorCode.FEE_HEAD_CATEGORY_TAKEN, tuition.id]);
      const same = await post('/fee-heads', { name: 'exam', category: 'other', frequency: 'ad_hoc' }, principal);
      expect([same.status, err(same).error.code]).toEqual([409, ErrorCode.FEE_HEAD_NAME_TAKEN]);

      // A fine is never concession-eligible; an admission fee never refundable (422, and CHECKs).
      const fine = await post('/fee-heads', { name: 'Late fine', category: 'fine', frequency: 'ad_hoc', concessionEligible: true }, principal);
      expect([fine.status, err(fine).error.details.fields?.[0]?.path]).toEqual([422, 'concessionEligible']);
      const admission = await post('/fee-heads', { name: 'Re-admission', category: 'admission', frequency: 'once', refundable: true }, principal);
      expect([admission.status, err(admission).error.details.fields?.[0]?.path]).toEqual([422, 'refundable']);
      const fineHead = heads.find((h) => h.category === 'fine')!;
      const fineEdit = await patch(`/fee-heads/${fineHead.id}`, { concessionEligible: true }, principal);
      expect(fineEdit.status).toBe(422);
      await expect(
        db().feeHead.updateMany({ where: { schoolId: school.id, id: BigInt(fineHead.id) }, data: { concessionEligible: true } }),
      ).rejects.toThrow();

      const created = await post('/fee-heads', { name: 'Transport', category: 'other', frequency: 'monthly' }, principal).expect(201);
      const transport = created.body as FeeHead;
      expect([transport.concessionEligible, transport.refundable, transport.seeded]).toEqual([true, true, false]);
      // Category and frequency are frozen: not in the PATCH body.
      const frozen = await patch(`/fee-heads/${transport.id}`, { category: 'tuition' }, principal);
      expect([frozen.status, err(frozen).error.details.fields?.[0]?.code]).toEqual([422, ErrorCode.UNKNOWN_FIELD]);
      const renamed = await patch(`/fee-heads/${transport.id}`, { name: 'Van', refundable: false }, principal).expect(200);
      expect((renamed.body as FeeHead).name).toBe('Van');

      const archived = await post(`/fee-heads/${transport.id}/archive`, { reason: 'No more vans' }, principal).expect(200);
      expect([(archived.body as FeeHead).status, (archived.body as FeeHead).archiveReason]).toEqual(['archived', 'No more vans']);
      const late = await patch(`/fee-heads/${transport.id}`, { name: 'Bus' }, principal);
      expect([late.status, err(late).error.code]).toEqual([409, ErrorCode.FEE_HEAD_ARCHIVED]);
      // An archived head frees its name; repeating the archive writes no second row.
      await post('/fee-heads', { name: 'Van', category: 'other', frequency: 'monthly' }, principal).expect(201);
      await post(`/fee-heads/${transport.id}/archive`, { reason: 'Again' }, principal).expect(200);

      expect((await auditRows(school.id, 'fee_head.created')).length).toBe(2);
      expect((await auditRows(school.id, 'fee_head.updated')).map((r) => r.metadata)).toEqual([
        { changes: { name: { from: 'Transport', to: 'Van' }, refundable: { from: true, to: false } } },
      ]);
      expect((await auditRows(school.id, 'fee_head.archived')).map((r) => [r.actorUserId, r.reason])).toEqual([
        [principal.user.userId, 'No more vans'],
      ]);
    });
  });

  // -------------------------------------------------------------------------- fee structures

  describe('fee structures (R177)', () => {
    async function setup() {
      const school = await createSchool();
      await seedHeads(school);
      const principal = await signIn('principal', school);
      const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
      const cls = await createClass(db(), school, year, { name: 'Class One' });
      const tuition = await db().feeHead.findFirstOrThrow({ where: { schoolId: school.id, category: 'tuition' } });
      const key = () => ({ 'Idempotency-Key': newIdempotencyKey() });
      const body = (amount: number, effectiveFrom: string, extra: Json = {}) => ({
        academicYearId: year.id.toString(),
        classId: cls.id.toString(),
        feeHeadId: tuition.id.toString(),
        amount,
        effectiveFrom,
        ...extra,
      });
      return { school, principal, year, cls, tuition, key, body };
    }

    it('sets an amount, refuses an earlier or same month without a reason, supersedes with one, and replays', async () => {
      const { school, principal, year, cls, key, body } = await setup();

      const k = key();
      const first = await post('/fee-structures', body(3000, '2026-04'), principal, k).expect(201);
      const firstRow = first.body as Structure;
      // The same key and body replay the row (200), a different body under it is refused.
      const replay = await post('/fee-structures', body(3000, '2026-04'), principal, k).expect(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect((replay.body as Structure).id).toBe(firstRow.id);
      const reused = await post('/fee-structures', body(3100, '2026-04'), principal, k);
      expect([reused.status, err(reused).error.code]).toEqual([409, ErrorCode.IDEMPOTENCY_KEY_REUSED]);
      await post('/fee-structures', body(3000, '2026-04'), principal).expect(422);

      const exists = await post('/fee-structures', body(3500, '2026-04'), principal, key());
      expect([exists.status, err(exists).error.code, err(exists).error.details.structureId]).toEqual([409, ErrorCode.FEE_STRUCTURE_EXISTS, firstRow.id]);

      const later = await post('/fee-structures', body(3200, '2026-09'), principal, key()).expect(201);
      const notLater = await post('/fee-structures', body(3300, '2026-06'), principal, key());
      expect([notLater.status, err(notLater).error.code, err(notLater).error.details.latestEffectiveFrom]).toEqual([
        409,
        ErrorCode.FEE_STRUCTURE_NOT_LATER,
        '2026-09',
      ]);
      const outside = await post('/fee-structures', body(3300, '2027-04'), principal, key());
      expect([outside.status, err(outside).error.details.fields?.[0]?.path]).toEqual([422, 'effectiveFrom']);

      // Same month with a reason supersedes; the old row stays, frozen, naming its successor.
      const replaced = await post('/fee-structures', body(3400, '2026-04', { reason: 'Typo in the amount' }), principal, key()).expect(201);
      const replacement = replaced.body as Structure;
      const old = await db().feeStructure.findFirstOrThrow({ where: { schoolId: school.id, id: BigInt(firstRow.id) } });
      expect([old.status, old.supersededBy?.toString(), old.amount]).toEqual(['superseded', replacement.id, 3000]);
      await expect(
        db().feeStructure.updateMany({ where: { schoolId: school.id, id: old.id }, data: { amount: 1 } }),
      ).rejects.toThrow();
      await expect(
        db().feeStructure.updateMany({ where: { schoolId: school.id, id: old.id }, data: { status: 'active', supersededAt: null } }),
      ).rejects.toThrow();

      // An unknown year, or another school's, is refused as on create.
      const otherYear = await createAcademicYear(db(), await createSchool());
      for (const id of ['999999999', otherYear.id.toString()]) {
        const refusedYear = await get(`/fee-structures?academicYearId=${id}`, principal);
        expect([refusedYear.status, err(refusedYear).error.details.fields?.[0]]).toEqual([
          422,
          { path: 'academicYearId', code: ErrorCode.REFERENCE_NOT_FOUND, message: 'No such academic year' },
        ]);
      }
      const grid = await get(`/fee-structures?academicYearId=${year.id}`, principal).expect(200);
      const [row] = (grid.body as Page<StructureClass>).data;
      expect(row?.classId).toBe(cls.id.toString());
      expect(row?.heads.map((h) => [h.amount, h.effectiveFrom])).toEqual([[3200, '2026-09']]);
      expect(row?.history.map((h) => [h.amount, h.effectiveFrom, h.status])).toEqual([
        [3200, '2026-09', 'active'],
        [3400, '2026-04', 'active'],
        [3000, '2026-04', 'superseded'],
      ]);
      expect((later.body as Structure).status).toBe('active');

      const created = await auditRows(school.id, 'fee_structure.created');
      expect(created).toHaveLength(3);
      expect(created[2]?.metadata).toMatchObject({ supersededId: firstRow.id, supersededAmount: 3000, amount: 3400 });
    });

    it('refuses a closed year, an archived head and a class of another year; copies a year by class name', async () => {
      const { school, principal, year, tuition, key, body } = await setup();
      const closed = await createAcademicYear(db(), school, { startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'closed' });
      const closedClass = await createClass(db(), school, closed, { name: 'Class One' });
      const refused = await post('/fee-structures', body(1000, '2025-05', { academicYearId: closed.id.toString(), classId: closedClass.id.toString() }), principal, key());
      expect([refused.status, err(refused).error.code]).toEqual([409, ErrorCode.ACADEMIC_YEAR_CLOSED]);
      const wrongClass = await post('/fee-structures', body(1000, '2026-05', { classId: closedClass.id.toString() }), principal, key());
      expect([wrongClass.status, err(wrongClass).error.details.fields?.[0]?.path]).toEqual([422, 'classId']);

      await post('/fee-structures', body(3000, '2026-04'), principal, key()).expect(201);
      const exam = await db().feeHead.findFirstOrThrow({ where: { schoolId: school.id, category: 'exam' } });
      await post('/fee-structures', body(800, '2026-04', { feeHeadId: exam.id.toString() }), principal, key()).expect(201);

      const next = await createAcademicYear(db(), school, { startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' });
      const nextClass = await createClass(db(), school, next, { name: 'class one' });
      await createClass(db(), school, next, { name: 'Class Two' });
      await post(`/fee-heads/${exam.id}/archive`, { reason: 'Exams are campaigns now' }, principal).expect(200);
      const archivedHead = await post('/fee-structures', body(900, '2026-05', { feeHeadId: exam.id.toString() }), principal, key());
      expect([archivedHead.status, err(archivedHead).error.code]).toEqual([409, ErrorCode.FEE_HEAD_ARCHIVED]);

      const copy = await post('/fee-structures/copy', { fromAcademicYearId: year.id.toString(), toAcademicYearId: next.id.toString(), effectiveFrom: '2027-04' }, principal).expect(200);
      expect(copy.body).toEqual({ created: 1, skipped: 1 });
      const copied = await db().feeStructure.findMany({ where: { schoolId: school.id, academicYearId: next.id } });
      expect(copied.map((r) => [r.classId, r.feeHeadId, r.amount, r.effectiveFrom])).toEqual([[nextClass.id, tuition.id, 3000, '2027-04']]);
      // Copying again leaves the priced pair alone.
      const again = await post('/fee-structures/copy', { fromAcademicYearId: year.id.toString(), toAcademicYearId: next.id.toString(), effectiveFrom: '2027-05' }, principal).expect(200);
      expect(again.body).toEqual({ created: 0, skipped: 2 });
      expect((await auditRows(school.id, 'fee_structure.copied')).map((r) => r.metadata)).toEqual([
        { fromAcademicYearId: year.id.toString(), effectiveFrom: '2027-04', created: 1, skipped: 1 },
        { fromAcademicYearId: year.id.toString(), effectiveFrom: '2027-05', created: 0, skipped: 2 },
      ]);
    });
  });

  // ------------------------------------------------------------------------ payment accounts

  describe('payment accounts (rule 21, R233)', () => {
    it('only a principal writes them; finance readers read them; a guardian sees the active ones', async () => {
      const school = await createSchool();
      const principal = await signIn('principal', school);
      const office = await signIn('office_staff', school);
      // A grant of school.settings.manage reaches the route but never satisfies the principal gate.
      await grant(office.user, principal.user, Capability.SCHOOL_SETTINGS_MANAGE);
      const account = { kind: 'bank', title: 'Iqra School', accountNo: 'pk36 scbl 0000 0011 2345 6702', bankName: 'Standard Chartered' };

      const refused = await post('/payment-accounts', account, office);
      expect([refused.status, err(refused).error.code, err(refused).error.details.reason]).toEqual([403, ErrorCode.PERMISSION_DENIED, 'principal_required']);
      const identity = await post('/payment-accounts', { ...account, accountNo: '35202-1234567-1' }, principal);
      expect([identity.status, err(identity).error.details.fields?.[0]?.path]).toEqual([422, 'accountNo']);
      const walletBank = await post('/payment-accounts', { kind: 'jazzcash', title: 'Iqra', accountNo: '03001234567', bankName: 'X' }, principal);
      expect(walletBank.status).toBe(422);

      const created = await post('/payment-accounts', account, principal).expect(201);
      const id = (created.body as { id: string; accountNo: string }).id;
      expect((created.body as { accountNo: string }).accountNo).toBe('PK36SCBL0000001123456702');
      const wallet = await post('/payment-accounts', { kind: 'easypaisa', title: 'Iqra School', accountNo: '03001234567' }, principal).expect(201);

      // The office reads them (payment.record is an office default).
      const list = await get('/payment-accounts', office).expect(200);
      expect((list.body as Page<{ id: string }>).data.map((r) => r.id)).toEqual([id, (wallet.body as { id: string }).id]);
      await get(`/payment-accounts/${id}`, office).expect(200);

      const disableRefused = await post(`/payment-accounts/${id}/disable`, { reason: 'Closed' }, office);
      expect(err(disableRefused).error.details.reason).toBe('principal_required');
      await post(`/payment-accounts/${id}/disable`, { reason: 'Account closed' }, principal).expect(200);
      await post(`/payment-accounts/${id}/disable`, { reason: 'Account closed' }, principal).expect(200);

      // The guardian: active accounts only, no who-set-it-up.
      const student = await createStudent(db(), school);
      const guardian = await createGuardianUser(db(), school);
      await linkGuardian(db(), school, student, { id: guardian.guardianId }, { canLogin: true });
      const parent = await createSchoolSession(db(), school, guardian);
      const mine = await get('/me/payment-accounts', parent).expect(200);
      expect((mine.body as Page<Json>).data).toEqual([
        { id: (wallet.body as { id: string }).id, kind: 'easypaisa', title: 'Iqra School', accountNo: '03001234567', bankName: null },
      ]);
      // Staff without the guardian capacity are refused it.
      await get('/me/payment-accounts', principal).expect(403);

      expect((await auditRows(school.id, 'payment_account.created')).map((r) => r.metadata)).toEqual([
        { kind: 'bank', title: 'Iqra School', accountNoEnding: '6702' },
        { kind: 'easypaisa', title: 'Iqra School', accountNoEnding: '4567' },
      ]);
      expect((await auditRows(school.id, 'payment_account.disabled')).map((r) => [r.subjectId?.toString(), r.reason])).toEqual([[id, 'Account closed']]);
    });
  });

  // ------------------------------------------------------------------------------ R234

  it('R234: a teacher reaches no fee head, fee structure or payment account route', async () => {
    const school = await createSchool();
    await seedHeads(school);
    const teacher = await signIn('teacher', school);
    const year = await createAcademicYear(db(), school);
    for (const path of ['/fee-heads', '/fee-heads/1', `/fee-structures?academicYearId=${year.id}`, '/payment-accounts', '/payment-accounts/1']) {
      expect([path, (await get(path, teacher)).status]).toEqual([path, 403]);
    }
    for (const path of ['/fee-heads', '/fee-heads/1/archive', '/fee-structures', '/fee-structures/copy', '/payment-accounts', '/payment-accounts/1/disable']) {
      expect([path, (await post(path, {}, teacher)).status]).toEqual([path, 403]);
    }
    expect((await patch('/fee-heads/1', {}, teacher)).status).toBe(403);
  });

  // ------------------------------------------------------------------------------ settings

  describe('settings (R178)', () => {
    it('ranges hold; late fees need an amount; enabling stamps late_fee_enabled_at; the change is audited', async () => {
      const school = await createSchool();
      await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
      const principal = await signIn('principal', school);

      const before = await get('/school/settings', principal).expect(200);
      expect(before.body).toMatchObject({
        feeCutoffDay: 15,
        lateFeeEnabled: false,
        lateFeeAmount: null,
        lateFeeGraceDays: 7,
        lateFeeEnabledAt: null,
        expenseApprovalThreshold: 5000,
        payDay: 1,
        feeReminderDaysBefore: 3,
        overdueReminderEveryDays: 14,
      });
      expect((before.body as { smsAllowedTypes: string[] }).smsAllowedTypes).toEqual(
        expect.arrayContaining(['fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected']),
      );

      for (const [field, value] of [
        ['feeCutoffDay', 29],
        ['feeCutoffDay', 0],
        ['lateFeeGraceDays', 31],
        ['payDay', 29],
        ['feeReminderDaysBefore', 11],
        ['overdueReminderEveryDays', 6],
        ['expenseApprovalThreshold', -1],
        ['expenseApprovalThreshold', 10_000_001],
        ['lateFeeAmount', 0],
        ['lateFeeAmount', 1.5],
      ] as const) {
        const res = await patch('/school/settings', { [field]: value }, principal);
        expect([field, value, res.status]).toEqual([field, value, 422]);
      }

      const noAmount = await patch('/school/settings', { lateFeeEnabled: true }, principal);
      expect([noAmount.status, err(noAmount).error.details.fields?.[0]?.path]).toEqual([422, 'lateFeeAmount']);
      const enabled = await patch('/school/settings', { lateFeeEnabled: true, lateFeeAmount: 300, feeCutoffDay: 20 }, principal).expect(200);
      const stamp = (enabled.body as { lateFeeEnabledAt: string | null }).lateFeeEnabledAt;
      expect(stamp).not.toBeNull();
      const cleared = await patch('/school/settings', { lateFeeAmount: null }, principal);
      expect(cleared.status).toBe(422);
      // Disabling keeps the stamp; enabling again moves it.
      await patch('/school/settings', { lateFeeEnabled: false }, principal).expect(200);
      const again = await patch('/school/settings', { lateFeeEnabled: true }, principal).expect(200);
      expect((again.body as { lateFeeEnabledAt: string }).lateFeeEnabledAt > stamp!).toBe(true);
      // The client never writes the stamp.
      const stampWrite = await patch('/school/settings', { lateFeeEnabledAt: new Date().toISOString() }, principal);
      expect([stampWrite.status, err(stampWrite).error.details.fields?.[0]?.code]).toEqual([422, ErrorCode.UNKNOWN_FIELD]);

      const audits = await auditRows(school.id, 'school_settings.updated');
      expect(audits[0]?.metadata).toEqual({
        changes: {
          feeCutoffDay: { from: 15, to: 20 },
          lateFeeEnabled: { from: false, to: true },
          lateFeeAmount: { from: null, to: 300 },
        },
      });
    });
  });
});
