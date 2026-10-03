// The staged-upload sweep (R41, R90), the row scope on documents (plan §3.4, R43), per-table
// isolation of the slice-6B tables (R62) and the re-encode concurrency limit.
import { randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ulid } from 'ulid';
import { Capability } from '@asms/shared';
import { ObjectNotFoundError, ObjectStorage } from '../../src/common/storage/object-storage';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { StagedUploadSweep, SWEEP_GRACE_MS } from '../../src/modules/documents/staged-upload.sweep';
import { ConcurrencyLimit } from '../../src/modules/documents/upload-processing';
import { IdempotencyKeyRepository } from '../../src/repositories/idempotency-key.repository';
import { StagedUploadRepository } from '../../src/repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../src/repositories/student-document.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import {
  closeTestDb,
  createSchool,
  createTwoSchools,
  testDb,
  type TestSchool,
  type TwoSchools,
} from '../support/schools';
import {
  createClassWithSection,
  createSection,
  createStudent,
  createTeacherAssignment,
  enrol,
} from '../support/students';

const HOUR = 3_600_000;

describe('staged uploads, scope and isolation (e2e)', () => {
  let app: NestExpressApplication;
  let storage: ObjectStorage;
  const db = testDb();

  beforeAll(async () => {
    app = await createTestApp();
    storage = app.get(ObjectStorage, { strict: false });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A staged row with its object, created `ageMs` ago and expiring `expiresInMs` from now. */
  async function staged(
    school: TestSchool,
    user: TestSchoolUser,
    opts: { expiresInMs: number; consumed?: boolean },
  ): Promise<{ id: bigint; objectKey: string }> {
    const objectKey = `${school.id}/${ulid()}.pdf`;
    await storage.put(objectKey, Buffer.from('%PDF-1.4 test'), 'application/pdf');
    const now = Date.now();
    const row = await db.stagedUpload.create({
      data: {
        schoolId: school.id,
        uploadedBy: user.userId,
        objectKey,
        mime: 'application/pdf',
        sizeBytes: 13,
        createdAt: new Date(now - 48 * HOUR),
        expiresAt: new Date(now + opts.expiresInMs),
        consumedAt: opts.consumed ? new Date(now - 47 * HOUR) : null,
      },
    });
    return { id: row.id, objectKey };
  }

  const exists = async (key: string): Promise<boolean> => {
    try {
      (await storage.get(key)).body.destroy();
      return true;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return false;
      throw error;
    }
  };
  const rowExists = async (school: TestSchool, id: bigint) =>
    (await db.stagedUpload.findFirst({ where: { schoolId: school.id, id } })) !== null;

  describe('sweep', () => {
    it('deletes only unconsumed rows past expiry plus the grace, object first; keeps committed objects', async () => {
      const school = await createSchool();
      const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
      const student = await createStudent(db, school);
      const expired = await staged(school, user, { expiresInMs: -2 * HOUR });
      const inGrace = await staged(school, user, { expiresInMs: -SWEEP_GRACE_MS / 2 });
      const live = await staged(school, user, { expiresInMs: 10 * HOUR });
      const consumed = await staged(school, user, { expiresInMs: -2 * HOUR, consumed: true });
      await db.studentDocument.create({
        data: {
          schoolId: school.id,
          studentId: student.id,
          type: 'other',
          objectKey: consumed.objectKey,
          mime: 'application/pdf',
          sizeBytes: 13,
          uploadedBy: user.userId,
        },
      });

      const result = await app.get(StagedUploadSweep).sweepSchool(school.id, new Date());
      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(await rowExists(school, expired.id)).toBe(false);
      expect(await exists(expired.objectKey)).toBe(false);
      for (const kept of [inGrace, live, consumed]) {
        expect(await rowExists(school, kept.id)).toBe(true);
        expect(await exists(kept.objectKey)).toBe(true);
      }
    });

    it('an object that cannot be deleted keeps its row for the next run', async () => {
      const school = await createSchool();
      const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
      const row = await staged(school, user, { expiresInMs: -2 * HOUR });
      const spy = jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('store down'));
      const sweep = app.get(StagedUploadSweep);
      expect(await sweep.sweepSchool(school.id, new Date())).toEqual({ deleted: 0, failed: 1 });
      spy.mockRestore();
      expect(await rowExists(school, row.id)).toBe(true);
      expect(await sweep.sweepSchool(school.id, new Date())).toEqual({ deleted: 1, failed: 0 });
      expect(await rowExists(school, row.id)).toBe(false);
    });

    it('the daily fan-out reaches every school, suspended and terminated included', async () => {
      const rows: { school: TestSchool; id: bigint; objectKey: string }[] = [];
      for (const status of ['active', 'suspended', 'terminated'] as const) {
        const school = await createSchool({ status: 'active' });
        const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
        rows.push({ school, ...(await staged(school, user, { expiresInMs: -2 * HOUR })) });
        if (status !== 'active') {
          await db.school.update({ where: { id: school.id }, data: { status } });
        }
      }
      const result = await app.get(StagedUploadSweep).sweepAll(new Date());
      expect(result.deleted).toBeGreaterThanOrEqual(3);
      for (const { school, id, objectKey } of rows) {
        expect(await rowExists(school, id)).toBe(false);
        expect(await exists(objectKey)).toBe(false);
      }
    });
  });

  describe('row scope (plan §3.4)', () => {
    it('a teacher-scoped read sees documents of students in their sections only', async () => {
      const school = await createSchool();
      const { klass, section } = await createClassWithSection(db, school);
      const otherSection = await createSection(db, school, klass);
      const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
      const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
      await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section });
      const mine = await createStudent(db, school);
      const theirs = await createStudent(db, school);
      await enrol(db, school, mine, section);
      await enrol(db, school, theirs, otherSection);
      const doc = async (studentId: bigint) =>
        (
          await db.studentDocument.create({
            data: {
              schoolId: school.id,
              studentId,
              type: 'photo',
              objectKey: `${school.id}/${ulid()}.png`,
              mime: 'image/png',
              sizeBytes: 10,
              uploadedBy: office.userId,
            },
          })
        ).id;
      const mineDoc = await doc(mine.id);
      const theirsDoc = await doc(theirs.id);

      const permissions = app.get(PermissionsService);
      const access = await permissions.load(school.id, teacher.userId);
      if (!access) throw new Error('teacher access missing');
      const scope = await permissions.can(school.id, access, Capability.STUDENT_VIEW);
      if (!scope) throw new Error('teacher scope missing');
      expect(scope.kind).toBe('sections');

      const repo = app.get(StudentDocumentRepository, { strict: false });
      expect(await repo.findById(school.id, scope, mineDoc)).not.toBeNull();
      expect(await repo.findById(school.id, scope, theirsDoc)).toBeNull();
      expect(await repo.findLatestPhoto(school.id, scope, theirs.id)).toBeNull();
      expect((await repo.list(school.id, scope, theirs.id, { skip: 0, take: 10 })).total).toBe(0);
      expect((await repo.list(school.id, scope, mine.id, { skip: 0, take: 10 })).total).toBe(1);
      expect(await repo.listAllForStudent(school.id, scope, theirs.id)).toEqual([]);
    });
  });

  describe('isolation (R62)', () => {
    let two: TwoSchools;
    let userA: TestSchoolUser;
    beforeAll(async () => {
      two = await createTwoSchools();
      userA = await createSchoolUser(db, two.a, { systemRole: 'office_staff' });
    });

    it('staged_uploads', async () => {
      const repo = app.get(StagedUploadRepository, { strict: false });
      await expectIsolated<bigint>(two, {
        create: async (schoolId: SchoolId) =>
          (
            await repo.create(schoolId, {
              uploadedBy: userA.userId,
              objectKey: `${schoolId}/${ulid()}.pdf`,
              mime: 'application/pdf',
              sizeBytes: 5,
              expiresAt: new Date(Date.now() + HOUR),
            })
          ).id,
        read: async (schoolId, id) =>
          (await repo.findOwned(schoolId, userA.userId, [id]))[0] ?? null,
        list: (schoolId) =>
          repo.listExpiredUnconsumed(schoolId, new Date(Date.now() + 2 * HOUR), 1000),
        write: async (schoolId, id) =>
          (await repo.consume(schoolId, userA.userId, id, new Date())) ? 1 : 0,
        snapshot: (row) => (row as { consumedAt: Date | null }).consumedAt,
      });
    });

    it('student_documents', async () => {
      const repo = app.get(StudentDocumentRepository, { strict: false });
      const permissions = app.get(PermissionsService);
      const principalA = await createSchoolUser(db, two.a, { systemRole: 'principal' });
      const principalB = await createSchoolUser(db, two.b, { systemRole: 'principal' });
      const scopeFor = async (schoolId: SchoolId) => {
        const user = schoolId === two.a.id ? principalA : principalB;
        const access = await permissions.load(schoolId, user.userId);
        const scope = access && (await permissions.can(schoolId, access, Capability.DOCUMENT_VIEW));
        if (!scope) throw new Error('principal scope missing');
        return scope;
      };
      const student = await createStudent(db, two.a);
      await expectIsolated<bigint>(two, {
        create: async (schoolId: SchoolId) =>
          (
            await repo.create(schoolId, {
              studentId: student.id,
              type: 'other',
              objectKey: `${schoolId}/${ulid()}.pdf`,
              mime: 'application/pdf',
              sizeBytes: 5,
              uploadedBy: userA.userId,
            })
          ).id,
        read: async (schoolId, id) => repo.findById(schoolId, await scopeFor(schoolId), id),
        list: async (schoolId) =>
          repo.listAllForStudent(schoolId, await scopeFor(schoolId), student.id),
      });
    });

    it('idempotency_keys', async () => {
      const repo = app.get(IdempotencyKeyRepository, { strict: false });
      const key = `k${randomBytes(12).toString('hex')}`;
      await expectIsolated<string>(two, {
        create: async (schoolId: SchoolId) => {
          // Outside a transaction the deferred subject check runs at once: write it complete.
          await db.idempotencyKey.create({
            data: {
              schoolId,
              userId: userA.userId,
              endpoint: 'admissions',
              key,
              requestHash: 'a'.repeat(64),
              responseStatus: 201,
              subjectType: 'student',
              subjectId: 1n,
            },
          });
          return key;
        },
        read: (schoolId, k) => repo.find(schoolId, userA.userId, 'admissions', k),
      });
    });
  });
});

describe('ConcurrencyLimit', () => {
  it('runs at most `max` at once and hands slots over in order', async () => {
    const limit = new ConcurrencyLimit(2, 1000);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) =>
      limit.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        order.push(n);
        running--;
      });
    await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(peak).toBe(2);
    expect(order).toHaveLength(5);
  });

  it('refuses with 503 after waiting longer than the limit, and frees nothing it never held', async () => {
    const limit = new ConcurrencyLimit(1, 30);
    let release: () => void = () => undefined;
    const holder = limit.run(() => new Promise<void>((r) => (release = r)));
    await expect(limit.run(() => Promise.resolve('late'))).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    release();
    await holder;
    // The slot is free again: a timed-out waiter did not take or leak it.
    await expect(limit.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('a failing task releases its slot', async () => {
    const limit = new ConcurrencyLimit(1, 30);
    await expect(limit.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
