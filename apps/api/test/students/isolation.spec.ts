// Control 4 / R62 for the slice 6 part A tables: a row written as school A is invisible to, and
// unwritable by, school B, through the repositories the services use. Each student-linked read
// takes a Scope; a school-wide one (`all`) is used here so only the tenant key keeps rows apart.
import { Test } from '@nestjs/testing';
import { Capability } from '@asms/shared';
import { PasswordHasher } from '../../src/common/crypto/password';
import { EnvModule, loadEnv } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { EnrolmentRepository } from '../../src/repositories/enrolment.repository';
import { StudentGuardianRepository } from '../../src/repositories/student-guardian.repository';
import { StudentStatusChangeRepository } from '../../src/repositories/student-status-change.repository';
import { StudentRepository } from '../../src/repositories/student.repository';
import { UserRepository } from '../../src/repositories/user.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import type { Scope } from '../../src/tenancy/scope';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser, testIdentityHash } from '../support/school-session';
import {
  closeTestDb,
  createSchool,
  createTwoSchools,
  testDb,
  type TestSchool,
} from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  day,
  enrol,
  linkGuardian,
} from '../support/students';

describe('students tenant isolation', () => {
  let close: () => Promise<void>;
  let students: StudentRepository;
  let links: StudentGuardianRepository;
  let enrolments: EnrolmentRepository;
  let statusChanges: StudentStatusChangeRepository;
  let users: UserRepository;
  /** A school-wide scope, from a principal's student.view. */
  let all: Scope;
  /** A section scope over no sections (a teacher with no assignments). */
  let none: Scope;
  const db = testDb();
  const page = { skip: 0, take: 50 };
  const asSchool = (schoolId: SchoolId): TestSchool => ({ id: schoolId, shortCode: '' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule, AccessModule],
      providers: [
        StudentRepository,
        StudentGuardianRepository,
        EnrolmentRepository,
        StudentStatusChangeRepository,
        UserRepository,
      ],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    students = moduleRef.get(StudentRepository);
    links = moduleRef.get(StudentGuardianRepository);
    enrolments = moduleRef.get(EnrolmentRepository);
    statusChanges = moduleRef.get(StudentStatusChangeRepository);
    users = moduleRef.get(UserRepository);

    const school = await createSchool();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const permissions = moduleRef.get(PermissionsService);
    const access = await permissions.load(school.id, principal.userId);
    const scope = access && (await permissions.can(school.id, access, Capability.STUDENT_VIEW));
    if (!scope || scope.kind !== 'all') throw new Error('expected a school-wide scope');
    all = scope;
    // A teacher with no assignments: a section scope with no sections, which matches no row.
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const teacherAccess = await permissions.load(school.id, teacher.userId);
    const narrow =
      teacherAccess && (await permissions.can(school.id, teacherAccess, Capability.STUDENT_VIEW));
    if (!narrow || narrow.kind !== 'sections' || narrow.ids.length !== 0) {
      throw new Error('expected an empty section scope');
    }
    none = narrow;
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  it('students', async () => {
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => (await createStudent(db, asSchool(schoolId))).id,
      read: (schoolId, id) => students.findById(schoolId, all, id),
      list: async (schoolId) =>
        (await students.list(schoolId, all, { sort: 'fullName', ...page })).rows,
      write: (schoolId, id) =>
        students.update(schoolId, id, { fullName: 'Taken Over' }).then(() => 1),
      snapshot: (row) => (row as { fullName: string } | null)?.fullName,
    });
  });

  it('students: the B-Form hash and the lock are per school', async () => {
    const { a, b } = await createTwoSchools();
    const student = await createStudent(db, a);
    expect(await students.findByBFormHash(b.id, student.bFormHash ?? '')).toBeNull();
    expect(await students.findByBFormHash(a.id, student.bFormHash ?? '')).toMatchObject({
      id: student.id,
    });
    const row = await students.findById(a.id, all, student.id);
    if (!row) throw new Error('missing');
    expect(await students.lockIfUnchanged(b.id, row)).toBe(false);
  });

  it('student_guardians', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const school = asSchool(schoolId);
        const student = await createStudent(db, school);
        return (await linkGuardian(db, school, student, await createGuardian(db, school))).id;
      },
      read: (schoolId, id) => links.findById(schoolId, all, id),
      write: (schoolId, id) => links.update(schoolId, id, { canLogin: true }).then(() => 1),
      snapshot: (row) => (row as { canLogin: boolean } | null)?.canLogin,
    });
    // Ending another school's link changes nothing either.
    const student = await createStudent(db, schools.a);
    const link = await linkGuardian(db, schools.a, student, await createGuardian(db, schools.a));
    expect(await links.end(schools.b.id, link.id, new Date())).toBe(0);
    expect(await links.liveForStudent(schools.b.id, all, student.id)).toEqual([]);
    expect(await links.liveForStudent(schools.a.id, all, student.id)).toHaveLength(1);
  });

  it('enrolments', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const school = asSchool(schoolId);
        const { section } = await createClassWithSection(db, school);
        return (await enrol(db, school, await createStudent(db, school), section)).id;
      },
      read: (schoolId, id) => enrolments.findById(schoolId, all, id),
      write: (schoolId, id) => enrolments.update(schoolId, id, { rollNo: 99 }).then(() => 1),
      snapshot: (row) => (row as { rollNo: number | null } | null)?.rollNo,
    });
    const { section } = await createClassWithSection(db, schools.a);
    const student = await createStudent(db, schools.a);
    const enrolment = await enrol(db, schools.a, student, section);
    expect(await enrolments.close(schools.b.id, enrolment.id, day('2026-01-01'))).toBe(0);
    expect(await enrolments.findActiveForStudent(schools.b.id, all, student.id)).toBeNull();
    expect((await enrolments.listForStudent(schools.b.id, all, student.id, page)).total).toBe(0);
    expect(await enrolments.hasActiveInSection(schools.b.id, section.id)).toBe(false);
    expect(await enrolments.hasActiveInSection(schools.a.id, section.id)).toBe(true);
  });

  it('student_status_changes (append-only: read and list only)', async () => {
    const { a, b } = await createTwoSchools();
    const student = await createStudent(db, a);
    const actor = await createSchoolUser(db, a, { systemRole: 'office_staff' });
    const row = await statusChanges.record(a.id, {
      studentId: student.id,
      fromStatus: 'active',
      toStatus: 'suspended',
      reason: 'Isolation check',
      changedBy: actor.userId,
      effectiveOn: day('2026-01-01'),
    });
    expect(
      (await statusChanges.listForStudent(a.id, all, student.id, page)).rows.map((r) => r.id),
    ).toEqual([row.id]);
    expect((await statusChanges.listForStudent(b.id, all, student.id, page)).total).toBe(0);
    expect(await statusChanges.latestForStudent(b.id, student.id)).toBeNull();
    // A row naming another school's student or user is refused by the composite foreign keys.
    await expect(
      statusChanges.record(b.id, {
        studentId: student.id,
        fromStatus: 'active',
        toStatus: 'suspended',
        reason: 'Cross-tenant',
        changedBy: actor.userId,
        effectiveOn: day('2026-01-01'),
      }),
    ).rejects.toThrow();
  });

  it('users.student_id: a student login is found only in its own school', async () => {
    const { a, b } = await createTwoSchools();
    const student = await createStudent(db, a);
    const passwordHash = await new PasswordHasher(loadEnv()).hash(student.bForm ?? '');
    const userId = await users.create(a.id, {
      usernameHash: testIdentityHash(student.bForm ?? ''),
      passwordHash,
      studentId: student.id,
    });
    expect((await users.find(a.id, userId))?.studentId).toBe(student.id);
    expect(await users.find(b.id, userId)).toBeNull();
    await expect(
      users.create(b.id, {
        usernameHash: testIdentityHash('1234567890123'),
        passwordHash,
        studentId: student.id,
      }),
    ).rejects.toThrow();
  });

  it('control 7: the per-student lists take the caller scope; out of scope reads as nothing', async () => {
    const { a } = await createTwoSchools();
    const { section } = await createClassWithSection(db, a);
    const student = await createStudent(db, a);
    await enrol(db, a, student, section);
    await linkGuardian(db, a, student, await createGuardian(db, a));
    const actor = await createSchoolUser(db, a, { systemRole: 'office_staff' });
    await statusChanges.record(a.id, {
      studentId: student.id,
      fromStatus: null,
      toStatus: 'active',
      reason: null,
      changedBy: actor.userId,
      effectiveOn: day('2026-01-01'),
    });
    for (const [scope, seen] of [[all, 1], [none, 0]] as const) {
      expect((await enrolments.listForStudent(a.id, scope, student.id, page)).total).toBe(seen);
      expect(await enrolments.findActiveForStudent(a.id, scope, student.id)).toEqual(
        seen ? expect.objectContaining({ studentId: student.id }) : null,
      );
      expect(await enrolments.activeForStudents(a.id, scope, [student.id])).toHaveLength(seen);
      expect(await links.liveForStudent(a.id, scope, student.id)).toHaveLength(seen);
      const linkPage = { includeEnded: true, ...page };
      expect((await links.listForStudent(a.id, scope, student.id, linkPage)).total).toBe(seen);
      expect((await statusChanges.listForStudent(a.id, scope, student.id, page)).total).toBe(seen);
    }
  });
});
