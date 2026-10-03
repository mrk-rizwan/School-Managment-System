// Academic structure, students, guardian links, enrolments and teacher assignments written straight
// to the database, for slice 4 and slice 6 tests that need rows to exist without driving the API.
// Every row satisfies the CHECKs, partial indexes and triggers of migrations
// 20261003093413_slice4_teacher_assignments, 20261003120000_slice4_assignment_voiding and
// 20261003120100_slice6_students_enrolment; none of them is bypassed.
//
// Identity values follow plan §3.6: the B-Form is AES-256-GCM under FIELD_ENCRYPTION_KEYS with AAD
// `schoolId|students|b_form`, and b_form_hash is the same HMAC as cnic_hash (testIdentityHash).
// Dates are `@db.Date` columns: pass 'YYYY-MM-DD' strings; they are stored as UTC midnight.
import { randomBytes, randomInt } from 'node:crypto';
import { FieldCipher } from '../../src/common/crypto/field-encryption';
import { addDays, todayIn } from '../../src/common/school-clock';
import { loadEnv, type Env } from '../../src/config/env';
import type {
  AcademicYearStatus,
  AttendanceMode,
  ClassStatus,
  ContactCapability,
  EnrolmentStatus,
  Gender,
  GuardianRelationship,
  StudentStatus,
  TeacherAssignmentRole,
} from '../../src/repositories/generated/prisma/client';
import type { GuardedPrismaClient } from '../../src/repositories/prisma';
import type { SchoolId } from '../../src/tenancy/school-id';
import { randomIdentityDigits, testIdentityHash } from './school-session';
import type { TestSchool } from './schools';

let env: Env | undefined;
const testEnv = (): Env => (env ??= loadEnv());

/** 'YYYY-MM-DD' as the Date Prisma writes to a `date` column (UTC midnight). */
export const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * Today in the test schools' timezone (Asia/Karachi, the schools default) as 'YYYY-MM-DD', shifted
 * by `offsetDays`. Not the UTC date: between midnight and 05:00 in Karachi the two differ and the
 * API, which reads the school clock, would disagree with the test.
 */
export function isoDay(offsetDays = 0): string {
  return addDays(todayIn('Asia/Karachi'), offsetDays).toISOString().slice(0, 10);
}

/** A short word unique to one call: keeps names apart under the per-school unique keys. */
const word = (): string => randomBytes(3).toString('hex');

/** A Pakistani mobile number in E.164, as normalisePhone() stores it. */
export const randomPhone = (): string =>
  `+923${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

// ---- academic structure -------------------------------------------------------------------

export interface TestAcademicYear {
  id: bigint;
  schoolId: SchoolId;
  startsOn: string;
  endsOn: string;
}

/** Default: an `active` year running from 180 days ago to 180 days ahead, so today is inside it. */
export async function createAcademicYear(
  db: GuardedPrismaClient,
  school: TestSchool,
  opts: { name?: string; startsOn?: string; endsOn?: string; status?: AcademicYearStatus } = {},
): Promise<TestAcademicYear> {
  const startsOn = opts.startsOn ?? isoDay(-180);
  const endsOn = opts.endsOn ?? isoDay(180);
  const row = await db.academicYear.create({
    data: {
      schoolId: school.id,
      name: opts.name ?? `Year ${word()}`,
      startsOn: day(startsOn),
      endsOn: day(endsOn),
      status: opts.status ?? 'active',
    },
  });
  return { id: row.id, schoolId: school.id, startsOn, endsOn };
}

export interface TestClass {
  id: bigint;
  schoolId: SchoolId;
  academicYearId: bigint;
}

export async function createClass(
  db: GuardedPrismaClient,
  school: TestSchool,
  year: Pick<TestAcademicYear, 'id'>,
  opts: { name?: string; attendanceMode?: AttendanceMode; status?: ClassStatus } = {},
): Promise<TestClass> {
  const row = await db.class.create({
    data: {
      schoolId: school.id,
      academicYearId: year.id,
      name: opts.name ?? `Class ${word()}`,
      attendanceMode: opts.attendanceMode ?? 'daily',
      status: opts.status ?? 'active',
    },
  });
  return { id: row.id, schoolId: school.id, academicYearId: row.academicYearId };
}

export interface TestSection {
  id: bigint;
  schoolId: SchoolId;
  classId: bigint;
  /** The class's year, carried so enrol() and createTeacherAssignment() need only the section. */
  academicYearId: bigint;
}

export async function createSection(
  db: GuardedPrismaClient,
  school: TestSchool,
  klass: Pick<TestClass, 'id' | 'academicYearId'>,
  opts: { name?: string; capacity?: number | null; deletedAt?: Date | null } = {},
): Promise<TestSection> {
  const row = await db.section.create({
    data: {
      schoolId: school.id,
      classId: klass.id,
      name: opts.name ?? `S${word()}`,
      capacity: opts.capacity ?? null,
      deletedAt: opts.deletedAt ?? null,
    },
  });
  return {
    id: row.id,
    schoolId: school.id,
    classId: klass.id,
    academicYearId: klass.academicYearId,
  };
}

/** Year, class and one section in one call: the usual starting point of a slice-6 test. */
export async function createClassWithSection(
  db: GuardedPrismaClient,
  school: TestSchool,
): Promise<{ year: TestAcademicYear; klass: TestClass; section: TestSection }> {
  const year = await createAcademicYear(db, school);
  const klass = await createClass(db, school, year);
  const section = await createSection(db, school, klass);
  return { year, klass, section };
}

export async function createSubject(
  db: GuardedPrismaClient,
  school: TestSchool,
  opts: { name?: string; code?: string | null } = {},
): Promise<{ id: bigint; schoolId: SchoolId }> {
  const row = await db.subject.create({
    data: { schoolId: school.id, name: opts.name ?? `Subject ${word()}`, code: opts.code ?? null },
  });
  return { id: row.id, schoolId: school.id };
}

// ---- students -----------------------------------------------------------------------------

export interface TestStudent {
  id: bigint;
  schoolId: SchoolId;
  admissionNo: string;
  /** The 13 B-Form digits, or null when created without one. Never log or assert on it in a URL. */
  bForm: string | null;
  bFormHash: string | null;
}

export interface StudentOptions {
  fullName?: string;
  gender?: Gender;
  /** Default 2018-05-01. */
  dateOfBirth?: string;
  /** Default today; must be after dateOfBirth (students_date_of_birth_check). */
  admittedOn?: string;
  /**
   * 13 digits to store encrypted, `null` for no B-Form, absent for fresh random digits. The same
   * digits twice in one school hit students_school_id_b_form_hash_key.
   */
  bForm?: string | null;
  status?: StudentStatus;
  /**
   * Default: a random 12-digit number. Real admissions take the next value of the school's
   * school_counters 'admission_no' row; tests that assert R34 drive the API instead.
   */
  admissionNo?: string;
  notes?: string | null;
}

export async function createStudent(
  db: GuardedPrismaClient,
  school: TestSchool,
  opts: StudentOptions = {},
): Promise<TestStudent> {
  const schoolId = school.id;
  const bForm = opts.bForm === undefined ? randomIdentityDigits() : opts.bForm;
  const bFormHash = bForm === null ? null : testIdentityHash(bForm);
  const cipher = new FieldCipher(testEnv().FIELD_ENCRYPTION_KEYS);
  const admissionNo = opts.admissionNo ?? String(randomInt(100_000_000_000, 999_999_999_999));
  const row = await db.student.create({
    data: {
      schoolId,
      admissionNo,
      fullName: opts.fullName ?? `Student ${word()}`,
      gender: opts.gender ?? 'male',
      dateOfBirth: day(opts.dateOfBirth ?? '2018-05-01'),
      bForm: bForm === null ? null : cipher.encrypt(bForm, `${schoolId}|students|b_form`),
      bFormHash,
      status: opts.status ?? 'active',
      admittedOn: day(opts.admittedOn ?? isoDay()),
      notes: opts.notes ?? null,
    },
  });
  return { id: row.id, schoolId, admissionNo, bForm, bFormHash };
}

// ---- guardians and links ------------------------------------------------------------------

export interface TestGuardian {
  id: bigint;
  schoolId: SchoolId;
  /** The 13 CNIC digits, or null. */
  cnic: string | null;
  phone: string | null;
}

/** A guardian with no login (test/school-auth/support.ts has one with a login). */
export async function createGuardian(
  db: GuardedPrismaClient,
  school: TestSchool,
  opts: {
    fullName?: string;
    /** As createStudent's bForm: absent = random digits, null = none. */
    cnic?: string | null;
    /** Absent = random number, null = none (such a guardian cannot be primary contact, R30). */
    phone?: string | null;
    contactCapability?: ContactCapability;
  } = {},
): Promise<TestGuardian> {
  const schoolId = school.id;
  const cnic = opts.cnic === undefined ? randomIdentityDigits() : opts.cnic;
  const phone = opts.phone === undefined ? randomPhone() : opts.phone;
  const cipher = new FieldCipher(testEnv().FIELD_ENCRYPTION_KEYS);
  const row = await db.guardian.create({
    data: {
      schoolId,
      fullName: opts.fullName ?? `Guardian ${word()}`,
      cnic: cnic === null ? null : cipher.encrypt(cnic, `${schoolId}|guardians|cnic`),
      cnicHash: cnic === null ? null : testIdentityHash(cnic),
      phone,
      contactCapability: opts.contactCapability ?? 'whatsapp',
    },
  });
  return { id: row.id, schoolId, cnic, phone };
}

/**
 * A guardian link. Defaults: father, primary contact and fee payer, no login, live. A second live
 * primary for the same student hits student_guardians_primary_key; a second live link of the same
 * pair hits student_guardians_live_pair_key.
 */
export async function linkGuardian(
  db: GuardedPrismaClient,
  school: TestSchool,
  student: Pick<TestStudent, 'id'>,
  guardian: Pick<TestGuardian, 'id'>,
  opts: {
    relationship?: GuardianRelationship;
    isPrimaryContact?: boolean;
    isFeePayer?: boolean;
    canLogin?: boolean;
    endedAt?: Date | null;
  } = {},
): Promise<{ id: bigint }> {
  const row = await db.studentGuardian.create({
    data: {
      schoolId: school.id,
      studentId: student.id,
      guardianId: guardian.id,
      relationship: opts.relationship ?? 'father',
      isPrimaryContact: opts.isPrimaryContact ?? true,
      isFeePayer: opts.isFeePayer ?? true,
      canLogin: opts.canLogin ?? false,
      endedAt: opts.endedAt ?? null,
    },
  });
  return { id: row.id };
}

// ---- enrolment ----------------------------------------------------------------------------

/**
 * An enrolment of `student` in `section` (and so its class and year). Default `active`, started
 * today, no roll number. A non-active status needs `endedOn` (enrolments_ended_check); it defaults
 * to `startedOn` then.
 */
export async function enrol(
  db: GuardedPrismaClient,
  school: TestSchool,
  student: Pick<TestStudent, 'id'>,
  section: Pick<TestSection, 'id' | 'classId' | 'academicYearId'>,
  opts: {
    rollNo?: number | null;
    status?: EnrolmentStatus;
    startedOn?: string;
    endedOn?: string | null;
  } = {},
): Promise<{ id: bigint }> {
  const status = opts.status ?? 'active';
  const startedOn = opts.startedOn ?? isoDay();
  const endedOn =
    opts.endedOn !== undefined ? opts.endedOn : status === 'active' ? null : startedOn;
  const row = await db.enrolment.create({
    data: {
      schoolId: school.id,
      studentId: student.id,
      academicYearId: section.academicYearId,
      classId: section.classId,
      sectionId: section.id,
      rollNo: opts.rollNo ?? null,
      status,
      startedOn: day(startedOn),
      endedOn: endedOn === null ? null : day(endedOn),
    },
  });
  return { id: row.id };
}

// ---- teacher assignments ------------------------------------------------------------------

export type TeacherAssignmentOptions = {
  /** Default today. */
  startsOn?: string;
  endsOn?: string | null;
  /** Voids the row (voided_at now) as this user; a voided row never counts and leaves the EXCLUDE. */
  voidedBy?: bigint;
} & (
  | { role: Extract<TeacherAssignmentRole, 'class_teacher'>; section: TestSection }
  | {
      role: Extract<TeacherAssignmentRole, 'subject_teacher'>;
      subjectId: bigint;
      /** One section, or every section of `klass` when absent (R54). */
      section?: TestSection;
      klass?: Pick<TestClass, 'id' | 'academicYearId'>;
    }
);

/**
 * A teacher assignment for `staff`. A class_teacher overlapping another live one on the same
 * section hits teacher_assignments_class_teacher_excl (SQLSTATE 23P01).
 */
export async function createTeacherAssignment(
  db: GuardedPrismaClient,
  school: TestSchool,
  staff: { staffId: bigint },
  opts: TeacherAssignmentOptions,
): Promise<{ id: bigint }> {
  const section = opts.section;
  const klass = opts.role === 'subject_teacher' ? opts.klass : undefined;
  const classId = section?.classId ?? klass?.id;
  const academicYearId = section?.academicYearId ?? klass?.academicYearId;
  if (classId === undefined || academicYearId === undefined) {
    throw new Error('createTeacherAssignment: give a section, or a class for a subject teacher');
  }
  const row = await db.teacherAssignment.create({
    data: {
      schoolId: school.id,
      staffId: staff.staffId,
      academicYearId,
      classId,
      sectionId: section?.id ?? null,
      subjectId: opts.role === 'subject_teacher' ? opts.subjectId : null,
      role: opts.role,
      startsOn: day(opts.startsOn ?? isoDay()),
      endsOn: opts.endsOn ? day(opts.endsOn) : null,
      voidedAt: opts.voidedBy === undefined ? null : new Date(),
      voidedBy: opts.voidedBy ?? null,
    },
  });
  return { id: row.id };
}
