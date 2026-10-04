// POST /admissions end to end (contracts/slice-6.md §6.3; R25, R26, R33-R35, R82-R89, R91, R97)
// over the real AppModule, the real database and the local object store.
import { randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability } from '@asms/shared';
import { loadEnv } from '../../src/config/env';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { EnrolmentRepository } from '../../src/repositories/enrolment.repository';
import { IdempotencyKeyRepository } from '../../src/repositories/idempotency-key.repository';
import { createTestApp } from '../core/app';
import { jpegWithExif, pdf } from '../documents/fixtures';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createClassWithSection,
  createGuardian,
  createSection,
  createStudent,
  enrol,
  linkGuardian,
  randomPhone,
  type TestSection,
} from '../support/students';

const ORIGIN = new URL(loadEnv().APP_URL).origin;
const ID = /^[1-9][0-9]{0,18}$/;

interface Result {
  student: { id: string; admissionNo: string; fullName: string; status: string; hasBForm: boolean };
  enrolment: {
    id: string;
    sectionId: string;
    rollNo: number | null;
    status: string;
    startedOn: string;
  };
  guardianLinks: {
    guardianId: string;
    isPrimaryContact: boolean;
    isFeePayer: boolean;
    canLogin: boolean;
  }[];
  documents: { id: string; type: string; mime: string }[];
  loginOffers: {
    student: boolean;
    guardians: { guardianId: string; fullName: string; available: boolean }[];
  };
}
interface ErrorBody {
  error: {
    code: string;
    details: {
      fields?: { path: string; code: string }[];
      matches?: { studentId: string; className: string | null }[];
      studentId?: string;
      readmissible?: boolean;
      guardianId?: string;
      mergedIntoId?: string;
    } | null;
  };
}

const newKey = () => `adm_${randomBytes(12).toString('base64url')}`;

describe('admissions (e2e)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let section: TestSection;
  let office: TestSchoolUser;
  let cookie: string;
  /** Every response body, checked for identity digits at the end (plan §3.6). */
  const bodies: string[] = [];
  const digitsUsed: string[] = [];
  const db = testDb();
  const http = () => request(app.getHttpServer());
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

  const digits = () => {
    const d = randomIdentityDigits();
    digitsUsed.push(d);
    return d;
  };

  const admit = async (body: object, key: string | null = newKey(), as = cookie) => {
    const req = http().post('/api/v1/admissions').set('Cookie', as).set('Origin', ORIGIN);
    if (key !== null) req.set('Idempotency-Key', key);
    const res = await req.send(body);
    bodies.push(res.text);
    return res;
  };

  const stage = async (file: Buffer, as = cookie): Promise<string> => {
    const res = await http()
      .post('/api/v1/uploads')
      .set('Cookie', as)
      .set('Origin', ORIGIN)
      .attach('file', file, 'f');
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  /** A valid admission with one new guardian (primary, fee payer, with a phone). */
  const body = (over: Record<string, unknown> = {}, target: TestSection = section) => ({
    student: {
      fullName: `Ali ${randomBytes(3).toString('hex')}`,
      gender: 'male',
      dateOfBirth: '2018-03-01',
      bForm: digits(),
    },
    guardians: [
      {
        newGuardian: {
          fullName: 'Ahmed Raza',
          cnic: digits(),
          phone: randomPhone(),
          contactCapability: 'whatsapp',
        },
        relationship: 'father',
        isPrimaryContact: true,
        isFeePayer: true,
        canLogin: true,
      },
    ],
    enrolment: { classId: target.classId.toString(), sectionId: target.id.toString() },
    ...over,
  });

  const counter = async (target = school) =>
    (await db.schoolCounter.findFirst({ where: { schoolId: target.id, name: 'admission_no' } }))
      ?.value ?? -1n;
  const keyRows = (user = office) =>
    db.idempotencyKey.count({ where: { schoolId: school.id, userId: user.userId } });
  const studentRows = () => db.student.count({ where: { schoolId: school.id } });

  /** A school as the platform creates it: the admission counter and the settings row. */
  async function admissionReadySchool(): Promise<TestSchool> {
    const created = await createSchool();
    await db.schoolCounter.create({
      data: { schoolId: created.id, name: 'admission_no', value: 0n },
    });
    await db.schoolSettings.create({
      data: { schoolId: created.id, feeDueDay: 10, studentLoginEnabled: true },
    });
    return created;
  }

  async function officeIn(target: TestSchool) {
    const user = await createSchoolUser(db, target, { systemRole: 'office_staff' });
    return { user, cookie: (await createSchoolSession(db, target, user)).cookie };
  }

  beforeAll(async () => {
    app = await createTestApp();
    school = await admissionReadySchool();
    ({ section } = await createClassWithSection(db, school));
  });

  // A fresh office user per test: uploads are limited per user, and keys are per user.
  beforeEach(async () => {
    ({ user: office, cookie } = await officeIn(school));
  });

  afterAll(async () => {
    // No identity number ever leaves the API (plan §3.6).
    for (const text of bodies) for (const d of digitsUsed) expect(text).not.toContain(d);
    await app.close();
    await closeTestDb();
  });

  describe('access and the key', () => {
    it('401 without a session; 403 for a teacher; the key is not read first (R85)', async () => {
      const anon = await http()
        .post('/api/v1/admissions')
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', newKey())
        .send(body());
      expect(anon.status).toBe(401);
      const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
      const tCookie = (await createSchoolSession(db, school, teacher)).cookie;
      expect((await admit(body(), newKey(), tCookie)).status).toBe(403);
    });

    it('422 on Idempotency-Key when missing, malformed or holding 13 digits; nothing stored', async () => {
      const before = await counter();
      for (const key of [null, 'short', 'has spaces in it!!', `abc${'1234567890123'}xyz`]) {
        const res = await admit(body(), key);
        expect(res.status).toBe(422);
        expect(errorOf(res).details?.fields?.[0]?.path).toBe('Idempotency-Key');
      }
      expect(await keyRows()).toBe(0);
      expect(await counter()).toBe(before);
    });
  });

  describe('a committed admission', () => {
    it('R35 / R82: 201 creates student, guardians, links, enrolment, documents, status row and audit in one go; the key row holds no digits and no body', async () => {
      const existing = await createGuardian(db, school, { fullName: 'Amina Bibi' });
      const photo = await stage(await jpegWithExif());
      const scan = await stage(pdf());
      const before = await counter();
      const key = newKey();
      const res = await admit(
        body({
          guardians: [
            {
              newGuardian: {
                fullName: 'Ahmed Raza',
                cnic: digits(),
                phone: '0300-1234567',
                contactCapability: 'keypad',
              },
              relationship: 'father',
              isPrimaryContact: true,
              isFeePayer: true,
              canLogin: true,
            },
            {
              guardianId: existing.id.toString(),
              relationship: 'mother',
              isPrimaryContact: false,
              isFeePayer: false,
              canLogin: false,
            },
          ],
          enrolment: {
            classId: section.classId.toString(),
            sectionId: section.id.toString(),
            rollNo: 7,
          },
          documents: [
            { stagedUploadId: photo, type: 'photo' },
            { stagedUploadId: scan, type: 'b_form' },
          ],
        }),
        key,
      );
      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBeUndefined();
      const result = res.body as Result;
      const studentId = BigInt(result.student.id);
      expect(result.student).toMatchObject({
        id: expect.stringMatching(ID),
        admissionNo: String(before + 1n),
        status: 'active',
        hasBForm: true,
      });
      expect(result.enrolment).toMatchObject({
        sectionId: section.id.toString(),
        rollNo: 7,
        status: 'active',
      });
      expect(result.guardianLinks).toHaveLength(2);
      expect(result.guardianLinks.filter((l) => l.isPrimaryContact)).toHaveLength(1);
      expect(result.documents.map((d) => d.type).sort()).toEqual(['b_form', 'photo']);
      expect(result.loginOffers.student).toBe(true);
      expect(result.loginOffers.guardians).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ guardianId: existing.id.toString(), available: false }),
          expect.objectContaining({ fullName: 'Ahmed Raza', available: true }),
        ]),
      );

      expect(await counter()).toBe(before + 1n);
      const where = { schoolId: school.id, studentId };
      expect(await db.studentGuardian.count({ where })).toBe(2);
      expect(await db.enrolment.count({ where: { ...where, status: 'active' } })).toBe(1);
      expect(await db.studentDocument.count({ where })).toBe(2);
      const status = await db.studentStatusChange.findFirst({ where });
      expect(status).toMatchObject({
        fromStatus: null,
        toStatus: 'active',
        changedBy: office.userId,
      });
      for (const id of [photo, scan]) {
        const row = await db.stagedUpload.findFirst({
          where: { schoolId: school.id, id: BigInt(id) },
        });
        expect(row?.consumedAt).not.toBeNull();
        const doc = await db.studentDocument.findFirst({
          where: { schoolId: school.id, objectKey: row?.objectKey ?? '' },
        });
        expect(doc?.studentId).toBe(studentId);
      }
      const audits = await db.auditLog.findMany({
        where: { schoolId: school.id, actorUserId: office.userId },
        orderBy: { id: 'asc' },
      });
      expect(audits.map((a) => a.action)).toEqual(['guardian.created', 'student.admitted']);
      expect(audits[1]?.subjectId).toBe(studentId);

      // R82: the key row holds a hash, the subject and the status: no digits, no body.
      const keyRow = await db.idempotencyKey.findFirst({
        where: { schoolId: school.id, userId: office.userId, key },
      });
      expect(keyRow).toMatchObject({
        endpoint: 'admissions',
        responseStatus: 201,
        subjectType: 'student',
        subjectId: studentId,
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // No column for a response body exists at all; a new one must be a reviewed change here.
      expect(Object.keys(keyRow ?? {}).sort()).toEqual(
        ['createdAt', 'endpoint', 'id', 'key', 'requestHash', 'responseStatus', 'schoolId', 'subjectId', 'subjectType', 'userId'],
      );
      // The request hash is 64 hex characters, which hold a run of 13 decimal digits about one
      // time in 23 by chance, so the pattern check skips it; the digits actually sent are
      // checked in every column.
      const { requestHash: _hash, ...rest } = keyRow ?? {};
      const asText = (v: object) =>
        JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
      expect(asText(rest)).not.toMatch(/[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);
      for (const d of digitsUsed) expect(asText(keyRow ?? {})).not.toContain(d);
    });

    it('R33: the same key and body replays the result with Idempotency-Replayed and writes nothing', async () => {
      const key = newKey();
      const payload = body();
      const first = await admit(payload, key);
      expect(first.status).toBe(201);
      const counts = [await studentRows(), await counter(), await keyRows()];

      // acknowledgedDuplicateStudentIds is outside the hash: adding it is still the same request.
      const again = await admit({ ...payload, acknowledgedDuplicateStudentIds: ['1'] }, key);
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect((again.body as Result).student.id).toBe((first.body as Result).student.id);
      expect((again.body as Result).student.admissionNo).toBe(
        (first.body as Result).student.admissionNo,
      );
      expect([await studentRows(), await counter(), await keyRows()]).toEqual(counts);
    });

    it('R83: the same key with another body is 409 IDEMPOTENCY_KEY_REUSED and writes nothing', async () => {
      const key = newKey();
      expect((await admit(body(), key)).status).toBe(201);
      const counts = [await studentRows(), await counter()];
      const res = await admit(body(), key);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect([await studentRows(), await counter()]).toEqual(counts);
    });

    it("R84: another user's equal key is independent", async () => {
      const key = newKey();
      expect((await admit(body(), key)).status).toBe(201);
      const other = await officeIn(school);
      const res = await admit(body(), key, other.cookie);
      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBeUndefined();
    });

    it('R85: a replay by a user who has lost student.create is 403', async () => {
      await db.userRole.create({
        data: {
          schoolId: school.id,
          userId: office.userId,
          systemRole: 'teacher',
          assignedBy: office.userId,
        },
      });
      const key = newKey();
      const payload = body();
      expect((await admit(payload, key)).status).toBe(201);
      await db.userRole.updateMany({
        where: { schoolId: school.id, userId: office.userId, systemRole: 'office_staff' },
        data: { endedAt: new Date(), endedBy: office.userId },
      });
      const res = await admit(payload, key);
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('PERMISSION_DENIED');
    });

    it('R89: two racing submits of one key make one student; the loser replays the winner', async () => {
      const key = newKey();
      const payload = body();
      const before = await studentRows();
      const [a, b] = await Promise.all([admit(payload, key), admit(payload, key)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.body as Result).student.id).toBe((b.body as Result).student.id);
      expect([a.headers['idempotency-replayed'], b.headers['idempotency-replayed']]).toContain(
        'true',
      );
      expect(await studentRows()).toBe(before + 1);
      expect(await keyRows()).toBe(1);
    });

    it('R34: concurrent admissions take consecutive numbers; a refused one leaves no gap', async () => {
      const before = await counter();
      const others = await Promise.all([officeIn(school), officeIn(school), officeIn(school)]);
      const results = await Promise.all(others.map((o) => admit(body(), newKey(), o.cookie)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      const numbers = results
        .map((r) => BigInt((r.body as Result).student.admissionNo))
        .sort((x, y) => (x < y ? -1 : 1));
      expect(numbers).toEqual([before + 1n, before + 2n, before + 3n]);

      // A refusal after the duplicate check rolls back: the roll number is taken.
      const holder = await createStudent(db, school);
      await enrol(db, school, holder, section, { rollNo: 4321 });
      const refused = await admit(
        body({
          enrolment: {
            classId: section.classId.toString(),
            sectionId: section.id.toString(),
            rollNo: 4321,
          },
        }),
      );
      expect(refused.status).toBe(409);
      expect(errorOf(refused).code).toBe('ROLL_NO_TAKEN');
      const next = await admit(body());
      expect((next.body as Result).student.admissionNo).toBe(String(before + 4n));
    });
  });

  describe('the possible-duplicate warning (R87, R88)', () => {
    it('409 with the matches, nothing stored; the same key with the ids acknowledged commits', async () => {
      const guardian = await createGuardian(db, school);
      const twin = await createStudent(db, school, {
        fullName: 'Sara Khan',
        dateOfBirth: '2017-06-15',
      });
      await linkGuardian(db, school, twin, guardian);
      await enrol(db, school, twin, section);
      const sibling = await createStudent(db, school, {
        fullName: 'SARA KHAN',
        dateOfBirth: '2017-06-15',
      });
      await linkGuardian(db, school, sibling, guardian);

      const key = newKey();
      const payload = body({
        student: { fullName: 'sara khan', gender: 'female', dateOfBirth: '2017-06-15' },
        guardians: [
          {
            guardianId: guardian.id.toString(),
            relationship: 'father',
            isPrimaryContact: true,
            isFeePayer: true,
            canLogin: false,
          },
        ],
      });
      const before = await counter();
      const warned = await admit(payload, key);
      expect(warned.status).toBe(409);
      expect(errorOf(warned).code).toBe('ADMISSION_POSSIBLE_DUPLICATE');
      const matches = errorOf(warned).details?.matches ?? [];
      expect(matches.map((m) => m.studentId).sort()).toEqual(
        [twin.id.toString(), sibling.id.toString()].sort(),
      );
      expect(matches.find((m) => m.studentId === twin.id.toString())?.className).toEqual(
        expect.any(String),
      );
      expect(matches.find((m) => m.studentId === sibling.id.toString())?.className).toBeNull();
      expect(await keyRows()).toBe(0);
      expect(await counter()).toBe(before);

      // Acknowledging one of two: the other still warns.
      const partial = await admit(
        { ...payload, acknowledgedDuplicateStudentIds: [twin.id.toString()] },
        key,
      );
      expect(partial.status).toBe(409);
      expect(errorOf(partial).code).toBe('ADMISSION_POSSIBLE_DUPLICATE');

      const ok = await admit(
        {
          ...payload,
          acknowledgedDuplicateStudentIds: [twin.id.toString(), sibling.id.toString()],
        },
        key,
      );
      expect(ok.status).toBe(201);
      expect(await keyRows()).toBe(1);
      const audit = await db.auditLog.findFirst({
        where: { schoolId: school.id, action: 'student.admitted', actorUserId: office.userId },
      });
      expect(JSON.stringify(audit?.metadata)).toContain(twin.id.toString());
    });

    it('an ended link or a new primary guardian is not a match', async () => {
      const guardian = await createGuardian(db, school);
      const former = await createStudent(db, school, {
        fullName: 'Bilal Ahmed',
        dateOfBirth: '2016-01-01',
      });
      await linkGuardian(db, school, former, guardian, { endedAt: new Date() });
      const res = await admit(
        body({
          student: { fullName: 'Bilal Ahmed', gender: 'male', dateOfBirth: '2016-01-01' },
          guardians: [
            {
              guardianId: guardian.id.toString(),
              relationship: 'father',
              isPrimaryContact: true,
              isFeePayer: true,
              canLogin: false,
            },
          ],
        }),
      );
      expect(res.status).toBe(201);
    });
  });

  describe('refusals store nothing (R87, R91)', () => {
    /** Submits, expects the refusal, and checks no key, number or staged upload was used. */
    async function refused(
      payload: object,
      status: number,
      code: string,
      path?: string,
      staged?: string,
    ) {
      const before = [await counter(), await studentRows()];
      const res = await admit(payload);
      expect(res.status).toBe(status);
      expect(status === 422 ? errorOf(res).details?.fields?.[0]?.code : errorOf(res).code).toBe(
        code,
      );
      if (path) expect(errorOf(res).details?.fields?.[0]?.path).toBe(path);
      expect(await keyRows()).toBe(0);
      expect([await counter(), await studentRows()]).toEqual(before);
      if (staged) {
        const row = await db.stagedUpload.findFirst({
          where: { schoolId: school.id, id: BigInt(staged) },
        });
        expect(row?.consumedAt).toBeNull();
      }
      return res;
    }

    const guardianEntry = (over: Record<string, unknown>) => ({
      relationship: 'father',
      isPrimaryContact: false,
      isFeePayer: false,
      canLogin: false,
      ...over,
    });

    it('422: the guardian set breaks a rule', async () => {
      const g = await createGuardian(db, school);
      const base = body().guardians[0];
      await refused(
        body({ guardians: [{ ...base, isPrimaryContact: false }] }),
        422,
        'INVALID_VALUE',
        'guardians',
      );
      await refused(
        body({ guardians: [{ ...base, isFeePayer: false }] }),
        422,
        'INVALID_VALUE',
        'guardians',
      );
      await refused(
        body({ guardians: [{ ...base, guardianId: g.id.toString() }] }),
        422,
        'INVALID_VALUE',
        'guardians[0]',
      );
      await refused(
        body({
          guardians: [
            base,
            guardianEntry({ guardianId: g.id.toString() }),
            guardianEntry({ guardianId: g.id.toString() }),
          ],
        }),
        422,
        'INVALID_VALUE',
        'guardians[2].guardianId',
      );
      await refused(body({ guardians: [] }), 422, 'INVALID_VALUE', 'guardians');
      await refused(
        body({
          guardians: [
            guardianEntry({ guardianId: '999999999999', isPrimaryContact: true, isFeePayer: true }),
          ],
        }),
        422,
        'REFERENCE_NOT_FOUND',
        'guardians[0].guardianId',
      );
    });

    it('422: unknown or foreign references and unusable uploads', async () => {
      const other = await admissionReadySchool();
      const foreignGuardian = await createGuardian(db, other);
      await refused(
        body({
          guardians: [
            guardianEntry({
              guardianId: foreignGuardian.id.toString(),
              isPrimaryContact: true,
              isFeePayer: true,
            }),
          ],
        }),
        422,
        'REFERENCE_NOT_FOUND',
        'guardians[0].guardianId',
      );
      await refused(
        body({ enrolment: { classId: '999999999999', sectionId: section.id.toString() } }),
        422,
        'REFERENCE_NOT_FOUND',
        'enrolment.classId',
      );
      // §6.3 order: guardians and uploads are resolved before the class and section.
      await refused(
        body({
          guardians: [
            guardianEntry({ guardianId: '999999999999', isPrimaryContact: true, isFeePayer: true }),
          ],
          enrolment: { classId: '999999999999', sectionId: '999999999999' },
        }),
        422,
        'REFERENCE_NOT_FOUND',
        'guardians[0].guardianId',
      );
      const { section: foreignSection } = await createClassWithSection(db, other);
      await refused(
        body({
          enrolment: {
            classId: section.classId.toString(),
            sectionId: foreignSection.id.toString(),
          },
        }),
        422,
        'REFERENCE_NOT_FOUND',
        'enrolment.sectionId',
      );

      const someoneElses = await stage(pdf(), (await officeIn(school)).cookie);
      await refused(
        body({ documents: [{ stagedUploadId: someoneElses, type: 'other' }] }),
        422,
        'REFERENCE_NOT_FOUND',
        'documents[0].stagedUploadId',
        someoneElses,
      );
      const mine = await stage(pdf());
      await refused(
        body({ documents: [{ stagedUploadId: mine, type: 'photo' }] }),
        422,
        'INVALID_VALUE',
        'documents[0].type',
        mine,
      );
      await refused(
        body({
          documents: [
            { stagedUploadId: mine, type: 'other' },
            { stagedUploadId: mine, type: 'b_form' },
          ],
        }),
        422,
        'INVALID_VALUE',
        'documents[1].stagedUploadId',
        mine,
      );
      await db.stagedUpload.update({
        where: { schoolId_id: { schoolId: school.id, id: BigInt(mine) } },
        data: {
          createdAt: new Date(Date.now() - 2 * 86_400_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await refused(
        body({ documents: [{ stagedUploadId: mine, type: 'other' }] }),
        422,
        'REFERENCE_NOT_FOUND',
        'documents[0].stagedUploadId',
        mine,
      );
    });

    it('422: dates and the body shape', async () => {
      const student = body().student;
      await refused(
        body({ student: { ...student, dateOfBirth: '2099-01-01' } }),
        422,
        'INVALID_VALUE',
        'student.dateOfBirth',
      );
      await refused(
        body({ student: { ...student, admittedOn: '2099-01-01' } }),
        422,
        'INVALID_VALUE',
        'student.admittedOn',
      );
      await refused(
        body({ student: { ...student, dateOfBirth: '2018-02-30' } }),
        422,
        'INVALID_VALUE',
        'student.dateOfBirth',
      );
      await refused(body({ schoolId: '1' }), 422, 'UNKNOWN_FIELD', 'schoolId');
      await refused(
        body({ student: { ...student, bForm: '12345' } }),
        422,
        'INVALID_VALUE',
        'student.bForm',
      );
    });

    it('409: B-Form taken (R25, with readmissible), guardian CNIC taken, merged guardian, phoneless primary', async () => {
      const bForm = digits();
      const withdrawn = await createStudent(db, school, { bForm, status: 'withdrawn' });
      const taken = await refused(
        body({ student: { ...body().student, bForm } }),
        409,
        'STUDENT_BFORM_EXISTS',
      );
      expect(errorOf(taken).details).toMatchObject({
        studentId: withdrawn.id.toString(),
        readmissible: true,
      });

      // R25: the same digits in another school are another child.
      const other = await admissionReadySchool();
      const { section: otherSection } = await createClassWithSection(db, other);
      const otherOffice = await officeIn(other);
      expect(
        (
          await admit(
            body({ student: { ...body().student, bForm } }, otherSection),
            newKey(),
            otherOffice.cookie,
          )
        ).status,
      ).toBe(201);

      const cnic = digits();
      const holder = await createGuardian(db, school, { cnic });
      const base = body().guardians[0];
      const cnicTaken = await refused(
        body({ guardians: [{ ...base, newGuardian: { ...base?.newGuardian, cnic } }] }),
        409,
        'GUARDIAN_CNIC_EXISTS',
      );
      expect(errorOf(cnicTaken).details?.guardianId).toBe(holder.id.toString());

      const survivor = await createGuardian(db, school);
      const merged = await createGuardian(db, school);
      await db.guardian.update({
        where: { schoolId_id: { schoolId: school.id, id: merged.id } },
        data: { status: 'merged', mergedIntoId: survivor.id },
      });
      const mergedRes = await refused(
        body({
          guardians: [
            guardianEntry({
              guardianId: merged.id.toString(),
              isPrimaryContact: true,
              isFeePayer: true,
            }),
          ],
        }),
        409,
        'GUARDIAN_MERGED',
      );
      expect(errorOf(mergedRes).details?.mergedIntoId).toBe(survivor.id.toString());

      const phoneless = await createGuardian(db, school, { phone: null });
      await refused(
        body({
          guardians: [
            guardianEntry({
              guardianId: phoneless.id.toString(),
              isPrimaryContact: true,
              isFeePayer: true,
            }),
          ],
        }),
        409,
        'PRIMARY_CONTACT_NEEDS_PHONE',
      );
      await refused(
        body({
          guardians: [
            { ...base, newGuardian: { fullName: 'No Phone', contactCapability: 'keypad' } },
          ],
        }),
        409,
        'PRIMARY_CONTACT_NEEDS_PHONE',
      );
    });

    it('409: archived section, archived class, closed year', async () => {
      const year = await createAcademicYear(db, school);
      const klass = await createClass(db, school, year);
      const archived = await createSection(db, school, klass, { deletedAt: new Date() });
      await refused(body({}, archived), 409, 'SECTION_ARCHIVED');
      const archivedClass = await createClass(db, school, year, { status: 'archived' });
      await refused(
        body({}, await createSection(db, school, archivedClass)),
        409,
        'CLASS_ARCHIVED',
      );
      const closed = await createAcademicYear(db, school, { status: 'closed' });
      const closedClass = await createClass(db, school, closed);
      await refused(
        body({}, await createSection(db, school, closedClass)),
        409,
        'ACADEMIC_YEAR_CLOSED',
      );
    });
  });

  describe('atomicity and sessions', () => {
    it('R35: a failure at the last statement leaves no row and no consumed upload', async () => {
      const staged = await stage(pdf());
      const existing = await createGuardian(db, school);
      const payload = body({
        guardians: [
          body().guardians[0],
          {
            guardianId: existing.id.toString(),
            relationship: 'mother',
            isPrimaryContact: false,
            isFeePayer: false,
            canLogin: false,
          },
        ],
        documents: [{ stagedUploadId: staged, type: 'other' }],
      });
      const before = {
        counter: await counter(),
        students: await studentRows(),
        guardians: await db.guardian.count({ where: { schoolId: school.id } }),
        links: await db.studentGuardian.count({ where: { schoolId: school.id } }),
        enrolments: await db.enrolment.count({ where: { schoolId: school.id } }),
        documents: await db.studentDocument.count({ where: { schoolId: school.id } }),
        statuses: await db.studentStatusChange.count({ where: { schoolId: school.id } }),
        audits: await db.auditLog.count({ where: { schoolId: school.id } }),
      };
      // On the prototype: other modules (the diary, slice 13) provide their own instance too.
      const keys = IdempotencyKeyRepository.prototype;
      const spy = jest.spyOn(keys, 'setSubject').mockRejectedValueOnce(new Error('forced failure'));
      const res = await admit(payload);
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect({
        counter: await counter(),
        students: await studentRows(),
        guardians: await db.guardian.count({ where: { schoolId: school.id } }),
        links: await db.studentGuardian.count({ where: { schoolId: school.id } }),
        enrolments: await db.enrolment.count({ where: { schoolId: school.id } }),
        documents: await db.studentDocument.count({ where: { schoolId: school.id } }),
        statuses: await db.studentStatusChange.count({ where: { schoolId: school.id } }),
        audits: await db.auditLog.count({ where: { schoolId: school.id } }),
      }).toEqual(before);
      expect(await keyRows()).toBe(0);
      const row = await db.stagedUpload.findFirst({
        where: { schoolId: school.id, id: BigInt(staged) },
      });
      expect(row?.consumedAt).toBeNull();

      // The upload is still usable, and the same request now commits.
      expect((await admit(payload)).status).toBe(201);
    });

    it('R97: an expired session is 401 and writes nothing; after re-login the same key and uploads commit', async () => {
      const staged = await stage(await jpegWithExif());
      const expired = await createSchoolSession(db, school, office, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const key = newKey();
      const payload = body({ documents: [{ stagedUploadId: staged, type: 'photo' }] });
      const before = await counter();
      const res = await admit(payload, key, expired.cookie);
      expect(res.status).toBe(401);
      expect(await counter()).toBe(before);
      expect(await keyRows()).toBe(0);

      const fresh = await createSchoolSession(db, school, office);
      const ok = await admit(payload, key, fresh.cookie);
      expect(ok.status).toBe(201);
      expect((ok.body as Result).documents.map((d) => d.type)).toEqual(['photo']);
    });
  });

  describe('review fixes (wave B)', () => {
    it('A1: a roll number taken after the in-transaction check is ROLL_NO_TAKEN naming the holder', async () => {
      const holder = await createStudent(db, school);
      const held = await enrol(db, school, holder, section, { rollNo: 4777 });
      // Force the race: the in-transaction check misses the holder, so the insert hits the
      // unique index and the refusal is built after the rollback.
      const enrolments = app.get(EnrolmentRepository, { strict: false });
      const spy = jest.spyOn(enrolments, 'findActiveByRollNo').mockResolvedValueOnce(null);
      const before = await counter();
      const res = await admit(
        body({
          enrolment: {
            classId: section.classId.toString(),
            sectionId: section.id.toString(),
            rollNo: 4777,
          },
        }),
      );
      spy.mockRestore();
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ROLL_NO_TAKEN');
      expect((errorOf(res).details as { enrolmentId?: string } | null)?.enrolmentId).toBe(
        held.id.toString(),
      );
      expect(await counter()).toBe(before);
      expect(await keyRows()).toBe(0);
    });

    it('L3b: a new guardian or a guardian login needs guardian.manage too', async () => {
      const permissions = app.get(PermissionsService, { strict: false });
      const load = permissions.load.bind(permissions);
      const spy = jest.spyOn(permissions, 'load').mockImplementation(async (schoolId, userId) => {
        const access = await load(schoolId, userId);
        if (!access || userId !== office.userId) return access;
        const capabilities = new Set(access.capabilities);
        capabilities.delete(Capability.GUARDIAN_MANAGE);
        return { ...access, capabilities };
      });
      try {
        const existing = await createGuardian(db, school, { phone: randomPhone() });
        const linkExisting = (canLogin: boolean) =>
          body({
            guardians: [
              {
                guardianId: existing.id.toString(),
                relationship: 'father',
                isPrimaryContact: true,
                isFeePayer: true,
                canLogin,
              },
            ],
          });
        const created = await admit(body());
        expect(created.status).toBe(403);
        expect(errorOf(created).code).toBe('PERMISSION_DENIED');
        const withLogin = await admit(linkExisting(true));
        expect(withLogin.status).toBe(403);
        expect(await keyRows()).toBe(0);
        // Linking an existing guardian without a login is student.create's alone.
        expect((await admit(linkExisting(false))).status).toBe(201);
      } finally {
        spy.mockRestore();
      }
    });

    it('M1: admission spends the identity-probe budget the lookups spend', async () => {
      for (let i = 0; i < 30; i++) {
        const res = await http()
          .post('/api/v1/students/lookup')
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .send({ bForm: '1111111111111' });
        expect(res.status).toBe(200);
      }
      const before = await counter();
      const res = await admit(body());
      expect(res.status).toBe(429);
      expect(errorOf(res).code).toBe('RATE_LIMITED');
      expect(await counter()).toBe(before);
      // Another user's budget is untouched.
      const other = await officeIn(school);
      expect((await admit(body(), newKey(), other.cookie)).status).toBe(201);
    });
  });
});
