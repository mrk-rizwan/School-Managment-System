// The one certificate body builder (phase-4-academic.md slice 34, §7.1; contracts/slice-34.md §3).
// A body is a snapshot: built once at issue and copied unchanged by a reissue, so a later change
// to the student's name changes nothing issued (R291). It may hold names, dates, the class history
// and the school's own wording; never an identity number, a phone, an address, a dues figure, a
// user id, an object key or a Phase 2 remark. Every string is checked with containsIdentityNumber
// before the row is written (the CHECK certificates_body_no_id_check is the database's line).
import { containsIdentityNumber, type CertificateType } from '@asms/shared';
import type { CertificateBody, CertificateStudent } from '../../repositories/certificate.repository';
import type { EnrolmentView } from '../../repositories/enrolment.repository';
import { toDateString } from '../academics/academics.shared';

/** The type's own printed title, used when the issuer gives none (`other` always gives one). */
export const CERTIFICATE_TITLES: Readonly<Record<CertificateType, string>> = {
  leaving: 'School Leaving Certificate',
  character: 'Character Certificate',
  academic: 'Academic Certificate',
  completion: 'Completion Certificate',
  other: 'Certificate',
};

export interface CertificateBodyInput {
  schoolName: string;
  student: CertificateStudent;
  fatherName: string | null;
  /** Every enrolment of the student, any order. */
  enrolments: readonly EnrolmentView[];
  /** The named year (null only on an `other` certificate of a student with no enrolment). */
  academicYearId: bigint | null;
  conduct: string | null;
  remarks: string | null;
  signatoryName: string;
}

/** Every string in a JSON value, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Throws when any string of the body carries an identity number. Its inputs were validated where
 * they were stored, so this firing is a bug (a 500), never a user's mistake.
 */
export function assertNoIdentityNumber(body: unknown): void {
  if (strings(body).some(containsIdentityNumber)) {
    throw new Error('a certificate body would carry an identity number');
  }
}

export function buildCertificateBody(input: CertificateBodyInput): CertificateBody {
  const { student } = input;
  const oldestFirst = [...input.enrolments].sort(
    (a, b) => a.startedOn.getTime() - b.startedOn.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // The class and section of the named year: its latest enrolment (a section change is
  // close-old/open-new, R174, so the last one is where the student ended that year).
  const inYear = oldestFirst.filter((e) => e.academicYearId === input.academicYearId);
  const named = inYear.at(-1) ?? null;
  const first = oldestFirst[0] ?? null;
  const last = oldestFirst.at(-1) ?? null;
  const body: CertificateBody = {
    schoolName: input.schoolName,
    studentName: student.fullName,
    fatherName: input.fatherName,
    admissionNo: student.admissionNo,
    gender: student.gender,
    dateOfBirth: toDateString(student.dateOfBirth),
    admittedOn: toDateString(student.admittedOn),
    studentStatus: student.status,
    academicYearName: named?.academicYearName ?? null,
    className: named?.className ?? null,
    sectionName: named?.sectionName ?? null,
    attendedFrom: first === null ? null : toDateString(first.startedOn),
    attendedTo: last === null || last.endedOn === null ? null : toDateString(last.endedOn),
    enrolments: oldestFirst.map((e) => ({
      academicYearName: e.academicYearName,
      className: e.className,
      sectionName: e.sectionName,
      from: toDateString(e.startedOn),
      to: e.endedOn === null ? null : toDateString(e.endedOn),
    })),
    conduct: input.conduct,
    remarks: input.remarks,
    signatoryName: input.signatoryName,
  };
  assertNoIdentityNumber(body);
  return body;
}
