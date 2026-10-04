// Shared by the slice-13 suites (contracts/slice-13.md): guardian and student logins written
// straight to the database, a probe of the capacity scope the access guard binds (§1.2), and the
// idempotency header.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Controller, Get, Module, Query } from '@nestjs/common';
import { RequireCapacity } from '../../src/common/auth/route-access';
import {
  CurrentSchoolSession,
  scopeOf,
  type SchoolSessionContext,
} from '../../src/common/auth/school-session';
import { ApiErrors } from '../../src/common/openapi';
import { NoQueryDto } from '../../src/common/validation';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ORIGIN, type Caller, type StaffHarness } from '../staff/support';
import { createSchoolSession, randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { createSchool, type testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createGuardian,
  createSection,
  createStudent,
  createSubject,
  createTeacherAssignment,
  enrol,
  isoDay,
  linkGuardian,
  type TestAcademicYear,
  type TestClass,
  type TestGuardian,
  type TestSection,
  type TestStudent,
} from '../support/students';

type GuardedPrismaClient = ReturnType<typeof testDb>;

const describeScope = (session: SchoolSessionContext) => {
  const scope = scopeOf(session);
  return scope.kind === 'all'
    ? { kind: 'all' }
    : { kind: scope.kind, ids: scope.ids.map(String).sort() };
};

/** Reports the capacity scope the guard bound (contracts/slice-13.md §1.2). Test-only. */
@Controller('me/test-capacity-scope')
class CapacityScopeProbeController {
  @Get('guardian')
  @RequireCapacity('guardian')
  @ApiErrors(401, 403)
  guardian(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    return describeScope(session);
  }

  @Get('student')
  @RequireCapacity('student')
  @ApiErrors(401, 403)
  student(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    return describeScope(session);
  }
}

@Module({ controllers: [CapacityScopeProbeController] })
export class CapacityScopeProbeModule {}

export interface Signed {
  userId: bigint;
  cookie: string;
  bearer: Record<string, string>;
}

/** A login for `guardian` (users.guardian_id) with a cookie session. */
export async function guardianLogin(
  db: GuardedPrismaClient,
  school: TestSchool,
  guardian: Pick<TestGuardian, 'id' | 'cnic'>,
  extra: { staffId?: bigint } = {},
): Promise<Signed> {
  const digits = guardian.cnic ?? randomIdentityDigits();
  const user = await db.user.create({
    data: {
      schoolId: school.id,
      usernameHash: testIdentityHash(digits),
      passwordHash:
        '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
      passwordIsDefault: true,
      guardianId: guardian.id,
      staffId: extra.staffId ?? null,
    },
  });
  const session = await createSchoolSession(db, school, { userId: user.id });
  return { userId: user.id, cookie: session.cookie, bearer: session.bearer };
}

/** A login for `student` (users.student_id) with a cookie session; needs studentLoginEnabled. */
export async function studentLogin(
  db: GuardedPrismaClient,
  school: TestSchool,
  student: Pick<TestStudent, 'id' | 'bForm'>,
): Promise<Signed> {
  const digits = student.bForm ?? randomIdentityDigits();
  const user = await db.user.create({
    data: {
      schoolId: school.id,
      usernameHash: testIdentityHash(digits),
      passwordHash:
        '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
      passwordIsDefault: true,
      studentId: student.id,
    },
  });
  const session = await createSchoolSession(db, school, { userId: user.id });
  return { userId: user.id, cookie: session.cookie, bearer: session.bearer };
}

/** A fresh Idempotency-Key, as newIdempotencyKey() makes one (a dashed UUID). */
export const idemKey = (): string => randomUUID();

// ------------------------------------------------------------------------------ a classroom

/**
 * One school with a classroom (contracts/slice-13.md tests): a principal, an office clerk, a
 * class teacher and a maths teacher on section A, a class teacher on section B (same class),
 * two subjects, and two children in A with their guardians: `whatsapp` (a login, primary for
 * both) and `keypad` (no login, the second child's). Student logins are on. Enrolments and
 * assignments start 30 days ago, so backdated writes are inside them.
 */
export async function classroom(h: StaffHarness): Promise<Classroom> {
  const db = h.db;
  const school = await createSchool();
  await db.schoolSettings.create({
    data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true },
  });
  const year = await createAcademicYear(db, school);
  const klass = await createClass(db, school, year, { name: 'Class Five' });
  const sectionA = await createSection(db, school, klass, { name: 'Blue' });
  const sectionB = await createSection(db, school, klass, { name: 'Green' });
  const maths = await createSubject(db, school, { name: 'Mathematics' });
  const english = await createSubject(db, school, { name: 'English' });
  const principal = await h.caller(school, 'principal', 'Nadia Principal');
  const office = await h.caller(school, 'office_staff', 'Omar Office');
  const classTeacher = await h.caller(school, 'teacher', 'Ayesha Class');
  const mathsTeacher = await h.caller(school, 'teacher', 'Bilal Maths');
  const otherTeacher = await h.caller(school, 'teacher', 'Hina Green');
  const started = isoDay(-30);
  await createTeacherAssignment(db, school, classTeacher, {
    role: 'class_teacher',
    section: sectionA,
    startsOn: started,
  });
  await createTeacherAssignment(db, school, mathsTeacher, {
    role: 'subject_teacher',
    subjectId: maths.id,
    section: sectionA,
    startsOn: started,
  });
  await createTeacherAssignment(db, school, otherTeacher, {
    role: 'class_teacher',
    section: sectionB,
    startsOn: started,
  });
  const child1 = await createStudent(db, school, { fullName: 'Zara Khan' });
  const child2 = await createStudent(db, school, { fullName: 'Ali Khan' });
  await enrol(db, school, child1, sectionA, { startedOn: started, rollNo: 1 });
  await enrol(db, school, child2, sectionA, { startedOn: started, rollNo: 2 });
  const parent = await createGuardian(db, school, { fullName: 'Sana Khan' });
  const keypad = await createGuardian(db, school, { contactCapability: 'keypad' });
  await linkGuardian(db, school, child1, parent, { canLogin: true, relationship: 'mother' });
  await linkGuardian(db, school, child2, parent, { canLogin: true, relationship: 'mother' });
  await linkGuardian(db, school, child2, keypad, { isPrimaryContact: false, isFeePayer: false });
  return {
    school,
    year,
    klass,
    sectionA,
    sectionB,
    maths,
    english,
    principal,
    office,
    classTeacher,
    mathsTeacher,
    otherTeacher,
    child1,
    child2,
    parent,
    keypad,
    parentLogin: await guardianLogin(db, school, parent),
  };
}

export interface Classroom {
  school: TestSchool;
  year: TestAcademicYear;
  klass: TestClass;
  sectionA: TestSection;
  sectionB: TestSection;
  maths: { id: bigint };
  english: { id: bigint };
  principal: Caller;
  office: Caller;
  classTeacher: Caller;
  mathsTeacher: Caller;
  otherTeacher: Caller;
  child1: TestStudent;
  child2: TestStudent;
  parent: TestGuardian;
  keypad: TestGuardian;
  parentLogin: Signed;
}

/** A POST with an Idempotency-Key (a fresh one unless given). */
export const postIdem = (
  h: StaffHarness,
  path: string,
  body: object,
  cookie: string,
  key: string | null = idemKey(),
) => {
  const req = request(h.app.getHttpServer()).post(path).set('Cookie', cookie).set('Origin', ORIGIN);
  return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
};

/** The OutboxDispatcher's enqueue, recorded instead of reaching Redis (jobs run after commit). */
export function captureOutbox(h: StaffHarness): void {
  jest
    .spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'messages')
    .mockImplementation(() => Promise.resolve());
}
