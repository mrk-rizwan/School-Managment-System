// Phase 5 wave R groundwork (phase-5-extended.md §3.2, §3.6, §4): direct writes against every
// database rule migrations 20261009120000_phase5_enums and 20261009120100_phase5_groundwork add or
// change, plus the fee-structure refusal through the API (R329). Each refusal names the
// constraint the error mapper reads. Tests never truncate; each builds its own schools.
import { createHash, randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import request from 'supertest';
import {
  DEFAULT_REQUIRED_DOCUMENT_TYPES,
  ErrorCode,
  newIdempotencyKey,
  SEEDED_FEE_HEADS,
} from '@asms/shared';
import { ApiException } from '../../src/common/errors/api-exception';
import { summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { DevicePunchService } from '../../src/modules/staff-attendance/device-punch.service';
import { createTestApp } from '../core/app';
import { ORIGIN } from '../school-auth/support';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection, createStudent } from '../support/students';

const db = () => testDb();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** The constraint a refused write names (trigger refusals carry it in DETAIL, which Prisma's message omits). */
const refusal = async (write: Promise<unknown>): Promise<string> => {
  try {
    await write;
    return 'accepted';
  } catch (error) {
    return summariseDatabaseError(error)?.constraint ?? String(error);
  }
};
const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from({ length: 26 }, () => alphabet[Math.floor(Math.random() * 32)]).join('');
};

describe('Phase 5 groundwork: database rules (wave R)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  // ---------------------------------------------------------------------------- student_documents

  describe('student_documents (rule 36, R322)', () => {
    const document = async (school: TestSchool, uploader: TestSchoolUser, extra: object = {}) => {
      const student = await createStudent(db(), school);
      return db().studentDocument.create({
        data: {
          schoolId: school.id,
          studentId: student.id,
          type: 'b_form',
          objectKey: `${school.id}/${ulid()}.pdf`,
          mime: 'application/pdf',
          sizeBytes: 100,
          uploadedBy: uploader.userId,
          ...extra,
        },
      });
    };
    const decide = (school: TestSchool, id: bigint, data: object) =>
      db().studentDocument.updateMany({ where: { schoolId: school.id, id }, data });

    it('a document is born uploaded, decided once by someone other than its uploader', async () => {
      const school = await createSchool();
      const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const doc = await document(school, office);
      expect(doc.status).toBe('uploaded');
      expect([doc.decidedBy, doc.decidedAt, doc.rejectReason]).toEqual([null, null, null]);

      // The uploader may not decide it, whatever their role (no sole-principal exception).
      expect(await refusal(decide(school, doc.id, { status: 'verified', decidedBy: office.userId, decidedAt: new Date() }))).toMatch(/student_documents_not_self/);
      await decide(school, doc.id, { status: 'verified', decidedBy: principal.userId, decidedAt: new Date() });
      // Final: neither rejected afterwards nor re-decided by someone else.
      expect(await refusal(decide(school, doc.id, { status: 'rejected', rejectReason: 'Blurred', decidedBy: principal.userId, decidedAt: new Date() }))).toMatch(/student_documents_(decided_at_frozen|status_transition)/);
      expect(await refusal(decide(school, doc.id, { decidedBy: office.userId }))).toMatch(/student_documents/);
    });

    it('a rejection carries a trimmed reason free of identity numbers; nothing else does', async () => {
      const school = await createSchool();
      const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const verifier = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const doc = await document(school, office);
      const at = new Date();
      expect(await refusal(decide(school, doc.id, { status: 'rejected', decidedBy: verifier.userId, decidedAt: at }))).toMatch(/student_documents_decided_check/);
      expect(await refusal(decide(school, doc.id, { status: 'rejected', decidedBy: verifier.userId, decidedAt: at, rejectReason: 'B-Form 4210112345671 is cut off' }))).toMatch(/student_documents_reject_reason_no_id_check/);
      expect(await refusal(decide(school, doc.id, { status: 'rejected', decidedBy: verifier.userId, decidedAt: at, rejectReason: ' padded ' }),)).toMatch(/student_documents_reject_reason_check/);
      expect(await refusal(decide(school, doc.id, { status: 'verified', decidedBy: verifier.userId, decidedAt: at, rejectReason: 'Fine' }),)).toMatch(/student_documents_decided_check/);
      await decide(school, doc.id, { status: 'rejected', decidedBy: verifier.userId, decidedAt: at, rejectReason: 'The photo is blurred' });
      const row = await db().studentDocument.findFirst({ where: { schoolId: school.id, id: doc.id } });
      expect([row?.status, row?.rejectReason]).toEqual(['rejected', 'The photo is blurred']);
    });

    it('is born uploaded, its file never changes, and it is never deleted (rule 4)', async () => {
      const school = await createSchool();
      const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      expect(await refusal(document(school, office, { status: 'verified', decidedBy: principal.userId, decidedAt: new Date() }),)).toMatch(/student_documents_born_uploaded/);
      const doc = await document(school, office);
      expect(await refusal(decide(school, doc.id, { type: 'photo' }))).toMatch(/student_documents_type_immutable/);
      expect(await refusal(decide(school, doc.id, { uploadedBy: principal.userId }))).toMatch(/student_documents_uploaded_by_immutable/);
      expect(await refusal(db().studentDocument.deleteMany({ where: { schoolId: school.id, id: doc.id } }))).toMatch(/student_documents_no_delete/);
    });
  });

  // ------------------------------------------------------------------------------ staff_attendance

  describe('staff_attendance.source (rule 40)', () => {
    it('a device mark has no marking user, a manual mark has one, and the source is frozen', async () => {
      const school = await createSchool();
      const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const mark = (date: string, data: object) =>
        db().staffAttendance.create({ data: { schoolId: school.id, staffId: teacher.staffId, date: day(date), status: 'present', ...data } });

      // asms_staff_attendance_not_self passes a NULL marker: no user made a device mark.
      const device = await mark('2026-09-01', { source: 'device', markedBy: null });
      expect([device.source, device.markedBy]).toEqual(['device', null]);
      expect(await refusal(mark('2026-09-02', { source: 'device', markedBy: office.userId }))).toMatch(/staff_attendance_source_check/);
      expect(await refusal(mark('2026-09-03', { markedBy: null }))).toMatch(/staff_attendance_source_check/);
      const manual = await mark('2026-09-04', { markedBy: office.userId });
      expect(manual.source).toBe('manual');
      expect(await refusal(db().staffAttendance.updateMany({ where: { schoolId: school.id, id: manual.id }, data: { source: 'device', markedBy: null } }),)).toMatch(/staff_attendance_(source|marked_by)_immutable/);
    });

    it('the existing self-marking refusal still holds for manual marks', async () => {
      const school = await createSchool();
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      expect(await refusal(db().staffAttendance.create({
          data: { schoolId: school.id, staffId: teacher.staffId, date: day('2026-09-01'), status: 'present', markedBy: teacher.userId },
        }),)).toMatch(/staff_attendance_not_self/);
    });
  });

  // ---------------------------------------------------------------------- staff.device_user_id, schools

  describe('device identities (rule 40, R344)', () => {
    it('a device user id is unique per school, printable ASCII, never an identity number', async () => {
      const [a, b] = [await createSchool(), await createSchool()];
      const [a1, a2] = [await createSchoolUser(db(), a, { systemRole: 'teacher' }), await createSchoolUser(db(), a, { systemRole: 'teacher' })];
      const b1 = await createSchoolUser(db(), b, { systemRole: 'teacher' });
      const setId = (school: TestSchool, staffId: bigint, deviceUserId: string | null) =>
        db().staff.updateMany({ where: { schoolId: school.id, id: staffId }, data: { deviceUserId } });
      await setId(a, a1.staffId, '0042');
      expect(await refusal(setId(a, a2.staffId, '0042'))).toMatch(/staff_school_id_device_user_id_key/);
      await setId(b, b1.staffId, '0042');
      expect(await refusal(setId(a, a2.staffId, 'has space'))).toMatch(/staff_device_user_id_check/);
      expect(await refusal(setId(a, a2.staffId, '4210112345671'))).toMatch(/staff_device_user_id_no_id_check/);
      // Cleared to reuse it.
      await setId(a, a1.staffId, null);
      await setId(a, a2.staffId, '0042');
    });

    it('a device token hash is lower-case sha-256 hex, set with its rotation time, and names one school', async () => {
      const [a, b] = [await createSchool(), await createSchool()];
      // Random per run: tests never delete, so a fixed hash would meet last run's school.
      const hash = randomBytes(32).toString('hex');
      const setHash = (school: TestSchool, data: object) => db().school.updateMany({ where: { id: school.id }, data });
      expect(await refusal(setHash(a, { deviceTokenHash: 'AB'.repeat(32), deviceTokenRotatedAt: new Date() }))).toMatch(/schools_device_token_hash_check/);
      expect(await refusal(setHash(a, { deviceTokenHash: hash }))).toMatch(/schools_device_token_rotated_check/);
      await setHash(a, { deviceTokenHash: hash, deviceTokenRotatedAt: new Date() });
      expect(await refusal(setHash(b, { deviceTokenHash: hash, deviceTokenRotatedAt: new Date() }))).toMatch(/schools_device_token_hash_key/);
    });
  });

  // ------------------------------------------------------------------ device token resolution (R348)

  describe('DevicePunchService.authorise (named exception 4, widened)', () => {
    const token = () => randomBytes(32).toString('base64url');
    const rotate = async (school: TestSchool, raw: string) =>
      db().school.updateMany({
        where: { id: school.id },
        data: { deviceTokenHash: createHash('sha256').update(raw).digest('hex'), deviceTokenRotatedAt: new Date() },
      });
    const authorise = (headers: Record<string, string>) =>
      app.get(DevicePunchService).authorise({ headers } as Request);
    const outcome = async (headers: Record<string, string>) => {
      try {
        await authorise(headers);
        return 'resolved';
      } catch (error) {
        return error instanceof ApiException ? `${error.status} ${error.code}` : String(error);
      }
    };
    const INVALID = `401 ${ErrorCode.DEVICE_TOKEN_INVALID}`;

    it('resolves the school of a live token; refuses unknown, rotated-out, malformed, browser and terminated', async () => {
      const school = await createSchool();
      const first = token();
      await rotate(school, first);
      expect(await outcome({ authorization: `Bearer ${first}` })).toBe('resolved');
      // Rotation invalidates the old token.
      const second = token();
      await rotate(school, second);
      expect(await outcome({ authorization: `Bearer ${first}` })).toBe(INVALID);
      expect(await outcome({ authorization: `Bearer ${second}` })).toBe('resolved');
      expect(await outcome({ authorization: `Bearer ${token()}` })).toBe(INVALID);
      expect(await outcome({})).toBe(INVALID);
      expect(await outcome({ authorization: `Bearer ${second}x` })).toBe(INVALID);
      expect(await outcome({ authorization: second })).toBe(INVALID);
      expect(await outcome({ authorization: `Bearer ${second}`, origin: ORIGIN })).toBe(INVALID);
      expect(await outcome({ authorization: `Bearer ${second}`, cookie: 'a=b' })).toBe(INVALID);
      // A suspended school's device works (R80 lifted); a terminated school's does not.
      await db().school.updateMany({ where: { id: school.id }, data: { status: 'suspended' } });
      expect(await outcome({ authorization: `Bearer ${second}` })).toBe('resolved');
      const gone = await createSchool({ status: 'terminated' });
      const third = token();
      await rotate(gone, third);
      expect(await outcome({ authorization: `Bearer ${third}` })).toBe(INVALID);
    });
  });

  // --------------------------------------------------------------------------------------- settings

  describe('settings (§3.6)', () => {
    it('required document types default to the shared list and refuse repeats and nulls', async () => {
      const school = await createSchool();
      const settings = await db().schoolSettings.create({ data: { schoolId: school.id } });
      expect(settings.requiredDocumentTypes).toEqual([...DEFAULT_REQUIRED_DOCUMENT_TYPES]);
      expect([settings.contractWarningDays, settings.staffLateAfter, settings.financialStatementBasis]).toEqual([30, null, 'received']);
      const set = (data: object) => db().schoolSettings.updateMany({ where: { schoolId: school.id }, data });
      expect(await refusal(set({ requiredDocumentTypes: ['photo', 'photo'] }))).toMatch(/school_settings_required_document_types_check/);
      expect(await refusal(set({ contractWarningDays: 0 }))).toMatch(/school_settings_contract_warning_days_check/);
      expect(await refusal(set({ contractWarningDays: 91 }))).toMatch(/school_settings_contract_warning_days_check/);
      await set({ requiredDocumentTypes: [], contractWarningDays: 90 });
      await set({ requiredDocumentTypes: ['b_form', 'photo', 'guardian_cnic'] });
    });

    it('support sessions last 4 hours by default, at most 24', async () => {
      const row = await db().platformSettings.findFirst({ where: { id: 1n } });
      expect(row?.supportSessionHours).toBe(4);
      expect(await refusal(db().platformSettings.updateMany({ where: { id: 1n }, data: { supportSessionHours: 25 } }))).toMatch(/platform_settings_support_session_hours_check/);
    });
  });

  // ----------------------------------------------------------------------------------- result_sheets

  describe('result_sheets.provenance (rule 39, R340)', () => {
    it('an imported term sheet is born published with no submitter; a manual one is still born draft', async () => {
      const school = await createSchool();
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const { year, klass, section } = await createClassWithSection(db(), school);
      const term = await db().academicTerm.create({
        data: {
          schoolId: school.id,
          academicYearId: year.id,
          name: 'Mid-term',
          sortOrder: 1,
          startsOn: day(year.startsOn),
          endsOn: day(year.endsOn),
          weight: 100,
        },
      });
      const now = new Date();
      const published = {
        schoolId: school.id,
        academicYearId: year.id,
        termId: term.id,
        classId: klass.id,
        sectionId: section.id,
        createdBy: principal.userId,
        status: 'published' as const,
        decidedBy: principal.userId,
        decidedAt: now,
        publishedBy: principal.userId,
        publishedAt: now,
        testWeight: 0,
        examWeight: 100,
        passPercent: 40,
        passRule: 'all_subjects' as const,
        bands: [{ grade: 'A', minPercent: 80 }],
      };
      expect(await refusal(db().resultSheet.create({ data: published }))).toMatch(/result_sheets_born_draft/);
      expect(await refusal(db().resultSheet.create({ data: { ...published, provenance: 'imported', submittedBy: office.userId, submittedAt: now } }),)).toMatch(/result_sheets_imported_check/);
      expect(await refusal(db().resultSheet.create({ data: { ...published, provenance: 'imported', publishedBy: office.userId } }),)).toMatch(/result_sheets_imported_check/);
      const sheet = await db().resultSheet.create({ data: { ...published, provenance: 'imported' } });
      expect([sheet.provenance, sheet.status, sheet.submittedBy, sheet.version]).toEqual(['imported', 'published', null, 1]);
      expect(await refusal(db().resultSheet.updateMany({ where: { schoolId: school.id, id: sheet.id }, data: { provenance: 'manual' } }),)).toMatch(/result_sheets_provenance_immutable/);
    });
  });

  // ------------------------------------------------------------------------------ fee heads, structures

  describe('fee heads and structures (rules 34, 37; R329)', () => {
    const seed = (school: TestSchool) => db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    const heads = (school: TestSchool) =>
      db().feeHead.findMany({ where: { schoolId: school.id }, select: { name: true, category: true, createdBy: true, status: true }, orderBy: { id: 'asc' } });

    it('the seed writes the three Phase 5 heads once, each skipped where the school already has one like it', async () => {
      const plain = await createSchool();
      await seed(plain);
      await seed(plain);
      expect((await heads(plain)).map((h) => h.name)).toEqual(SEEDED_FEE_HEADS.map((h) => h.name));

      // A hand-made live head named Transport (category other) and a hand-made event head: the
      // seed adds neither Transport (name taken) nor a second event head... nor fails.
      const custom = await createSchool();
      const office = await createSchoolUser(db(), custom, { systemRole: 'office_staff' });
      await db().feeHead.create({
        data: { schoolId: custom.id, name: 'Transport', category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: office.userId },
      });
      await seed(custom);
      const names = (await heads(custom)).filter((h) => h.createdBy === null).map((h) => h.name);
      expect(names).toEqual(['Tuition', 'Admission', 'Annual charges', 'Exam', 'Fine', 'Event', 'Opening balance']);

      // A live transport head by hand blocks the seeded one (at most one live transport head).
      const own = await createSchool();
      const clerk = await createSchoolUser(db(), own, { systemRole: 'office_staff' });
      await db().feeHead.create({
        data: { schoolId: own.id, name: 'Van fee', category: 'transport', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: clerk.userId },
      });
      await seed(own);
      expect((await heads(own)).filter((h) => h.category === 'transport').map((h) => h.name)).toEqual(['Van fee']);
      expect(await refusal(db().feeHead.create({
          data: { schoolId: own.id, name: 'Bus fee', category: 'transport', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: clerk.userId },
        }),)).toMatch(/fee_heads_one_transport_key/);
    });

    // Scoped to schools asms_seed_school_finance seeded (they carry a system tuition head): test
    // fixtures that insert a bare school row never had seeded heads to backfill.
    it('every seeded school has the three heads, or a live head of that name', async () => {
      const missing = await db().$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM schools s
        CROSS JOIN (VALUES ('Transport'), ('Event'), ('Opening balance')) AS v(name)
        WHERE EXISTS (SELECT 1 FROM fee_heads t WHERE t.school_id = s.id AND t.category = 'tuition' AND t.created_by IS NULL)
          AND NOT EXISTS (SELECT 1 FROM fee_heads h WHERE h.school_id = s.id AND lower(h.name) = lower(v.name))
          AND NOT (v.name = 'Transport' AND EXISTS (
            SELECT 1 FROM fee_heads h WHERE h.school_id = s.id AND h.category = 'transport' AND h.status <> 'archived'))`;
      expect(missing[0]?.n).toBe(0n);
    });

    it('a transport or event head takes no fee structure: refused by the API and by the database', async () => {
      const school = await createSchool();
      await seed(school);
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const session = await createSchoolSession(db(), school, principal);
      const { year, klass } = await createClassWithSection(db(), school);
      const headOf = async (category: 'transport' | 'event' | 'tuition') =>
        (await db().feeHead.findFirst({ where: { schoolId: school.id, category } }))?.id ?? 0n;
      const effectiveFrom = year.startsOn.slice(0, 7);
      for (const category of ['transport', 'event'] as const) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/fee-structures')
          .set('Cookie', session.cookie)
          .set('Origin', ORIGIN)
          .set('Idempotency-Key', newIdempotencyKey())
          .send({ academicYearId: year.id.toString(), classId: klass.id.toString(), feeHeadId: (await headOf(category)).toString(), amount: 1500, effectiveFrom });
        const body = res.body as { error: { code: string; details: { fields: { path: string }[] } } };
        expect([res.status, body.error.code, body.error.details.fields[0]?.path]).toEqual([422, ErrorCode.VALIDATION_FAILED, 'feeHeadId']);
        expect(await refusal(db().feeStructure.create({
            data: { schoolId: school.id, academicYearId: year.id, classId: klass.id, feeHeadId: await headOf(category), amount: 1500, effectiveFrom, createdBy: principal.userId },
          }),)).toMatch(/fee_structures_head_category/);
      }
      // Tuition still takes one.
      await db().feeStructure.create({
        data: { schoolId: school.id, academicYearId: year.id, classId: klass.id, feeHeadId: await headOf('tuition'), amount: 1500, effectiveFrom, createdBy: principal.userId },
      });
    });
  });
});
