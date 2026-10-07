// Wave N fixtures (phase-4-academic.md §4 "Slice 30", "Slice 34"): one school's year with its
// seeded terms, a class with a section and a subject, an enrolled student and a principal, and
// writers for assessments, marks and certificates straight through the guarded client. Used by
// the raw guard suites and the isolation suite until the wave N repositories exist.
import { randomBytes } from 'node:crypto';
import type { AssessmentKind, AssessmentMarkStatus, CertificateType, DuesStatus, TestType } from '@asms/shared';
import { createSchoolUser } from '../support/school-session';
import { testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createStudent,
  createSubject,
  day,
  enrol,
} from '../support/students';

/** The assessment columns a test may override. */
export interface AssessmentExtra {
  kind?: AssessmentKind;
  testType?: TestType | null;
  name?: string;
  maxMarks?: number;
  heldOn?: Date;
  termId?: bigint;
  lockedAt?: Date | null;
}

/** The mark columns a test may override. */
export interface MarkExtra {
  obtained?: number | null;
  absent?: boolean;
  excused?: boolean;
  status?: AssessmentMarkStatus;
  supersedesId?: bigint | null;
  correctionReason?: string | null;
  clientEntryKey?: string | null;
  decidedBy?: bigint | null;
  decidedAt?: Date | null;
  enrolmentId?: bigint;
}

/** The certificate columns a test may override. */
export interface CertificateExtra {
  type?: CertificateType;
  issueNo?: number;
  reissueOfId?: bigint | null;
  academicYearId?: bigint | null;
  title?: string | null;
  body?: Record<string, string>;
  reason?: string | null;
  duesStatus?: DuesStatus;
}

export interface MarksFixture {
  school: TestSchool;
  userId: bigint;
  yearId: bigint;
  classId: bigint;
  sectionId: bigint;
  classSubjectId: bigint;
  /** 2026-04-01 to 2026-09-30 (the seeded first half of the year). */
  midTermId: bigint;
  annualTermId: bigint;
  studentId: bigint;
  enrolmentId: bigint;
}

/** A phone-style entry key: 24 URL-safe characters, never a 13-digit run. */
export const entryKey = (): string => `k${randomBytes(18).toString('base64url')}`.replace(/[0-9]/g, 'x');

/** A school with a 2026-27 year (terms seeded), one class, section, class-subject and enrolled student. */
export async function createMarksFixture(school: TestSchool): Promise<MarksFixture> {
  const db = testDb();
  const userId = (await createSchoolUser(db, school, { systemRole: 'principal' })).userId;
  const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
  await db.$executeRaw`SELECT asms_seed_year_results(${school.id}::bigint, ${year.id}::bigint)`;
  const terms = await db.academicTerm.findMany({
    where: { schoolId: school.id, academicYearId: year.id },
    orderBy: { sortOrder: 'asc' },
  });
  const klass = await createClass(db, school, year);
  const section = await createSection(db, school, klass);
  const subject = await createSubject(db, school);
  const classSubject = await db.classSubject.create({
    data: { schoolId: school.id, academicYearId: year.id, classId: klass.id, subjectId: subject.id, sortOrder: 1 },
  });
  const student = await createStudent(db, school, { admittedOn: '2026-04-01' });
  const enrolment = await enrol(db, school, student, section, { startedOn: '2026-04-01' });
  return {
    school,
    userId,
    yearId: year.id,
    classId: klass.id,
    sectionId: section.id,
    classSubjectId: classSubject.id,
    midTermId: terms[0]!.id,
    annualTermId: terms[1]!.id,
    studentId: student.id,
    enrolmentId: enrolment.id,
  };
}

/** A test (default) or exam of the fixture's section in the mid-term. */
export async function createAssessment(
  f: MarksFixture,
  extra: AssessmentExtra = {},
): Promise<{ id: bigint; maxMarks: number }> {
  const kind = extra.kind ?? 'test';
  const row = await testDb().assessment.create({
    data: {
      schoolId: f.school.id,
      academicYearId: f.yearId,
      termId: f.midTermId,
      classId: f.classId,
      sectionId: f.sectionId,
      classSubjectId: f.classSubjectId,
      kind,
      testType: kind === 'test' ? 'weekly' : null,
      name: kind === 'test' ? 'Weekly test' : 'Mid-term exam',
      maxMarks: 20,
      heldOn: day('2026-05-10'),
      createdBy: f.userId,
      ...extra,
    },
  });
  return { id: row.id, maxMarks: row.maxMarks };
}

/** A live mark of the fixture's student on `assessment`. */
export async function createMark(
  f: MarksFixture,
  assessment: { id: bigint; maxMarks: number },
  extra: MarkExtra = {},
): Promise<{ id: bigint }> {
  const absent = extra.absent ?? false;
  const row = await testDb().mark.create({
    data: {
      schoolId: f.school.id,
      assessmentId: assessment.id,
      enrolmentId: f.enrolmentId,
      studentId: f.studentId,
      academicYearId: f.yearId,
      maxMarks: assessment.maxMarks,
      obtained: absent ? null : 15,
      absent,
      status: 'live',
      enteredBy: f.userId,
      clientEntryKey: entryKey(),
      ...extra,
    },
  });
  return { id: row.id };
}

/** A character certificate (issue 1, no dues gate) of the fixture's student. */
export async function createCertificate(
  f: MarksFixture,
  number: number,
  extra: CertificateExtra = {},
): Promise<{ id: bigint }> {
  const row = await testDb().certificate.create({
    data: {
      schoolId: f.school.id,
      studentId: f.studentId,
      type: 'character',
      number,
      academicYearId: f.yearId,
      // The shape the slice-34 body builder writes, so CertificateRepository reads it back.
      body: {
        schoolName: 'Test School',
        studentName: 'Test Student',
        fatherName: null,
        admissionNo: '1001',
        gender: 'male',
        dateOfBirth: '2018-05-01',
        admittedOn: '2026-04-01',
        studentStatus: 'active',
        academicYearName: '2026-27',
        className: null,
        sectionName: null,
        attendedFrom: '2026-04-01',
        attendedTo: null,
        enrolments: [],
        conduct: 'Good',
        remarks: null,
        signatoryName: 'Principal',
      },
      duesStatus: 'not_required',
      issuedBy: f.userId,
      issuedOn: day('2026-06-01'),
      ...extra,
    },
  });
  return { id: row.id };
}
