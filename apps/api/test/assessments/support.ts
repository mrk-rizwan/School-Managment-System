// Shared by the slice-30 suites (contracts/slice-30.md): a school with a year whose terms and
// result settings are seeded, one class with two sections and two subjects on its list, teachers
// assigned 30 days back, two students in 6-A and one in 6-B, and a guardian login for the first.
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Capability } from '@asms/shared';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { AssessmentRepository } from '../../src/repositories/assessment.repository';
import { MarkRepository } from '../../src/repositories/mark.repository';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { guardianLogin, type Signed } from '../diary/support';
import { ORIGIN, type Caller, type StaffHarness } from '../staff/support';
import { createSchool, type TestSchool } from '../support/schools';
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

export const api = (path: string): string => `/api/v1${path}`;

/** A phone-style entry key: 24 URL-safe characters, never a digit run. */
export const entryKey = (): string =>
  `k${randomBytes(18).toString('base64url')}`.replace(/[0-9]/g, 'x');

export interface MarkRoom {
  school: TestSchool;
  year: TestAcademicYear;
  klass: TestClass;
  sixA: TestSection;
  sixB: TestSection;
  maths: { id: bigint; classSubjectId: bigint };
  english: { id: bigint; classSubjectId: bigint };
  principal: Caller;
  office: Caller;
  /** Class teacher of 6-A; teaches no subject. */
  classTeacher: Caller;
  /** Maths in 6-A. */
  mathsTeacher: Caller;
  /** English in 6-A. */
  englishTeacher: Caller;
  /** Maths in 6-B. */
  bTeacher: Caller;
  child1: TestStudent;
  child2: TestStudent;
  childB: TestStudent;
  enrolment1: bigint;
  enrolment2: bigint;
  enrolmentB: bigint;
  parent: TestGuardian;
  parentLogin: Signed;
}

/** The room (see the file header). Terms: Mid-term and Annual, seeded over the year's two halves. */
export async function markRoom(h: StaffHarness): Promise<MarkRoom> {
  const db = h.db;
  const school = await createSchool();
  await db.schoolSettings.create({
    data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true },
  });
  const year = await createAcademicYear(db, school);
  await db.$executeRaw`SELECT asms_seed_year_results(${school.id}::bigint, ${year.id}::bigint)`;
  const klass = await createClass(db, school, year, { name: 'Six' });
  const sixA = await createSection(db, school, klass, { name: 'A' });
  const sixB = await createSection(db, school, klass, { name: 'B' });
  const mathsSubject = await createSubject(db, school, { name: 'Mathematics' });
  const englishSubject = await createSubject(db, school, { name: 'English' });
  const listed = async (subjectId: bigint, sortOrder: number) =>
    (
      await db.classSubject.create({
        data: {
          schoolId: school.id,
          academicYearId: year.id,
          classId: klass.id,
          subjectId,
          sortOrder,
          examMaxMarks: 100,
        },
      })
    ).id;
  const maths = { id: mathsSubject.id, classSubjectId: await listed(mathsSubject.id, 1) };
  const english = { id: englishSubject.id, classSubjectId: await listed(englishSubject.id, 2) };

  const principal = await h.caller(school, 'principal', 'Nadia Principal');
  const office = await h.caller(school, 'office_staff', 'Omar Office');
  const classTeacher = await h.caller(school, 'teacher', 'Ayesha Class');
  const mathsTeacher = await h.caller(school, 'teacher', 'Bilal Maths');
  const englishTeacher = await h.caller(school, 'teacher', 'Erum English');
  const bTeacher = await h.caller(school, 'teacher', 'Hina Bsection');
  const started = isoDay(-30);
  await createTeacherAssignment(db, school, classTeacher, {
    role: 'class_teacher',
    section: sixA,
    startsOn: started,
  });
  await createTeacherAssignment(db, school, mathsTeacher, {
    role: 'subject_teacher',
    subjectId: maths.id,
    section: sixA,
    startsOn: started,
  });
  await createTeacherAssignment(db, school, englishTeacher, {
    role: 'subject_teacher',
    subjectId: english.id,
    section: sixA,
    startsOn: started,
  });
  await createTeacherAssignment(db, school, bTeacher, {
    role: 'subject_teacher',
    subjectId: maths.id,
    section: sixB,
    startsOn: started,
  });

  const child1 = await createStudent(db, school, { fullName: 'Zara Khan' });
  const child2 = await createStudent(db, school, { fullName: 'Ali Raza' });
  const childB = await createStudent(db, school, { fullName: 'Sara Malik' });
  const enrolment1 = (await enrol(db, school, child1, sixA, { startedOn: started, rollNo: 1 })).id;
  const enrolment2 = (await enrol(db, school, child2, sixA, { startedOn: started, rollNo: 2 })).id;
  const enrolmentB = (await enrol(db, school, childB, sixB, { startedOn: started, rollNo: 1 })).id;
  const parent = await createGuardian(db, school, { fullName: 'Sana Khan' });
  await linkGuardian(db, school, child1, parent, { canLogin: true, relationship: 'mother' });
  return {
    school,
    year,
    klass,
    sixA,
    sixB,
    maths,
    english,
    principal,
    office,
    classTeacher,
    mathsTeacher,
    englishTeacher,
    bTeacher,
    child1,
    child2,
    childB,
    enrolment1,
    enrolment2,
    enrolmentB,
    parent,
    parentLogin: await guardianLogin(db, school, parent),
  };
}

/** A live grant of `capability` to `user` (slice 7): school-wide, as every grant is. */
export async function grant(
  h: StaffHarness,
  room: MarkRoom,
  user: Caller,
  capability: Capability,
): Promise<void> {
  await h.db.userCapabilityGrant.create({
    data: {
      schoolId: room.school.id,
      userId: user.userId,
      capabilityKey: capability,
      effect: 'grant',
      grantedBy: room.principal.userId,
      reason: 'Covering the marks desk',
    },
  });
}

/** A POST with an Idempotency-Key (fresh unless given) and optional extra headers. */
export const postKeyed = (
  h: StaffHarness,
  path: string,
  body: object,
  cookie: string,
  key: string = entryKey(),
) =>
  request(h.app.getHttpServer())
    .post(path)
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', key)
    .send(body);

/**
 * The assessment and mark repositories over the real database, for the isolation probes (control
 * 4): the tenant comes only from the SchoolId each call is given.
 */
export async function marksRepositories(): Promise<{
  assessments: AssessmentRepository;
  marks: MarkRepository;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [AssessmentRepository, MarkRepository],
  }).compile();
  await moduleRef.init();
  return {
    assessments: moduleRef.get(AssessmentRepository),
    marks: moduleRef.get(MarkRepository),
    close: () => moduleRef.close(),
  };
}
