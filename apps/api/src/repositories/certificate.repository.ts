import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  certificateCounterName,
  GENDERS,
  STUDENT_STATUSES,
  type CertificateType,
  type DuesStatus,
  type Gender,
  type StudentStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import { userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// The tenant table certificates (phase-4-academic.md §3.2 "Certificates", slice 34, R289-R293;
// contracts/slice-34.md). Never deleted; a void stamps the trio and the number stays. A reissue is
// a new row with the same type and number and issue_no + 1. After insert only printed_count and
// the void trio change (triggers certificates_columns_immutable, certificates_voided_frozen).
// Every read takes the caller's row Scope (tenancy control 7): a certificate is student-linked.
// Raw SQL for the counter's upsert and the number's row lock only (RAW_SQL_FILES;
// test/certificates/certificates.e2e-spec.ts).

/** One enrolment of the student as the body records it (dates are YYYY-MM-DD). */
export interface CertificateBodyEnrolment {
  academicYearName: string;
  className: string;
  sectionName: string;
  from: string;
  to: string | null;
}

/**
 * The stored body (certificates.body, a JSON object): written only by the certificates module's
 * body builder, read back field by field. Dates are YYYY-MM-DD.
 */
export interface CertificateBody {
  schoolName: string;
  studentName: string;
  fatherName: string | null;
  admissionNo: string;
  gender: Gender;
  dateOfBirth: string;
  admittedOn: string;
  studentStatus: StudentStatus;
  academicYearName: string | null;
  className: string | null;
  sectionName: string | null;
  attendedFrom: string | null;
  attendedTo: string | null;
  enrolments: CertificateBodyEnrolment[];
  conduct: string | null;
  remarks: string | null;
  signatoryName: string;
}

export interface CertificateRecord {
  id: bigint;
  studentId: bigint;
  type: CertificateType;
  number: number;
  issueNo: number;
  reissueOfId: bigint | null;
  academicYearId: bigint | null;
  title: string | null;
  body: CertificateBody;
  reason: string | null;
  duesStatus: DuesStatus;
  issuedBy: bigint;
  issuedOn: Date;
  printedCount: number;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The student's name and admission number now (the body holds them as issued). */
  studentName: string;
  admissionNo: string;
  academicYearName: string | null;
}

/** The student facts a certificate body and its print view are built from. */
export interface CertificateStudent {
  id: bigint;
  fullName: string;
  admissionNo: string;
  gender: Gender;
  dateOfBirth: Date;
  admittedOn: Date;
  status: StudentStatus;
}

export interface NewCertificate {
  studentId: bigint;
  type: CertificateType;
  number: number;
  issueNo: number;
  reissueOfId: bigint | null;
  academicYearId: bigint | null;
  title: string | null;
  body: CertificateBody;
  reason: string | null;
  duesStatus: DuesStatus;
  issuedBy: bigint;
  issuedOn: Date;
}

export interface CertificateListQuery {
  type?: CertificateType;
  studentId?: bigint;
  issuedFrom?: Date;
  issuedTo?: Date;
  voided?: boolean;
  descending: boolean;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  studentId: true,
  type: true,
  number: true,
  issueNo: true,
  reissueOfId: true,
  academicYearId: true,
  title: true,
  body: true,
  reason: true,
  duesStatus: true,
  issuedBy: true,
  issuedOn: true,
  printedCount: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  createdAt: true,
  updatedAt: true,
  student: { select: { fullName: true, admissionNo: true } },
  academicYear: { select: { name: true } },
} as const satisfies Prisma.CertificateSelect;

type Row = Prisma.CertificateGetPayload<{ select: typeof SELECT }>;

type Json = Prisma.JsonValue;
type JsonObject = Prisma.JsonObject;

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A body written by another shape is a data fault: reported (a 500), never printed half-filled. */
const badBody = (): Error => new Error('certificate body has an unexpected shape');

const text = (value: Json | undefined): string => {
  if (typeof value !== 'string') throw badBody();
  return value;
};
const textOrNull = (value: Json | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return text(value);
};
const oneOf = <T extends string>(value: Json | undefined, values: readonly T[]): T => {
  const found = values.find((v) => v === value);
  if (found === undefined) throw badBody();
  return found;
};

/** The stored JSON as a CertificateBody, field by field. */
function toBody(value: Json): CertificateBody {
  if (!isObject(value)) throw badBody();
  const { enrolments } = value;
  if (!Array.isArray(enrolments)) throw badBody();
  return {
    schoolName: text(value.schoolName),
    studentName: text(value.studentName),
    fatherName: textOrNull(value.fatherName),
    admissionNo: text(value.admissionNo),
    gender: oneOf(value.gender, GENDERS),
    dateOfBirth: text(value.dateOfBirth),
    admittedOn: text(value.admittedOn),
    studentStatus: oneOf(value.studentStatus, STUDENT_STATUSES),
    academicYearName: textOrNull(value.academicYearName),
    className: textOrNull(value.className),
    sectionName: textOrNull(value.sectionName),
    attendedFrom: textOrNull(value.attendedFrom),
    attendedTo: textOrNull(value.attendedTo),
    enrolments: enrolments.map((e) => {
      if (!isObject(e)) throw badBody();
      return {
        academicYearName: text(e.academicYearName),
        className: text(e.className),
        sectionName: text(e.sectionName),
        from: text(e.from),
        to: textOrNull(e.to),
      };
    }),
    conduct: textOrNull(value.conduct),
    remarks: textOrNull(value.remarks),
    signatoryName: text(value.signatoryName),
  };
}

const toRecord = ({ student, academicYear, body, ...row }: Row): CertificateRecord => ({
  ...row,
  body: toBody(body),
  studentName: student.fullName,
  admissionNo: student.admissionNo,
  academicYearName: academicYear?.name ?? null,
});

@Injectable()
export class CertificateRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The register (and a student's list): newest issue first unless `descending` is false. */
  async list(schoolId: SchoolId, scope: Scope, query: CertificateListQuery): Promise<{ rows: CertificateRecord[]; total: number }> {
    const issuedOn: Prisma.DateTimeFilter = {
      ...(query.issuedFrom === undefined ? {} : { gte: query.issuedFrom }),
      ...(query.issuedTo === undefined ? {} : { lte: query.issuedTo }),
    };
    const where: Prisma.CertificateWhereInput = {
      schoolId,
      student: { is: studentInScope(scope) },
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
      ...(Object.keys(issuedOn).length === 0 ? {} : { issuedOn }),
      ...(query.voided === undefined ? {} : { voidedAt: query.voided ? { not: null } : null }),
    };
    const direction = query.descending ? 'desc' : 'asc';
    const rows = await this.txHost.tx.certificate.findMany({
      where,
      select: SELECT,
      orderBy: [{ issuedOn: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.certificate.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<CertificateRecord | null> {
    const row = await this.txHost.tx.certificate.findFirst({
      where: { schoolId, id, student: { is: studentInScope(scope) } },
      select: SELECT,
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * Locks every row of a certificate number to the end of the transaction. Reissue and void both
   * take it first, so a void stamps a reissue committed meanwhile, and a reissue sees a void.
   */
  async lockNumber(schoolId: SchoolId, type: CertificateType, number: number): Promise<void> {
    await this.txHost.tx.$queryRaw`
      SELECT id FROM certificates
      WHERE school_id = ${schoolId} AND type = ${type}::certificate_type AND number = ${number}
      ORDER BY issue_no
      FOR UPDATE`;
  }

  /** True when any issue of the number is voided (a voided number is never reissued). */
  async numberVoided(schoolId: SchoolId, type: CertificateType, number: number): Promise<boolean> {
    const row = await this.txHost.tx.certificate.findFirst({
      where: { schoolId, type, number, voidedAt: { not: null } },
      select: { id: true },
    });
    return row !== null;
  }

  /** The highest issue_no of a certificate number (1 for an original never reissued). */
  async lastIssueNo(schoolId: SchoolId, type: CertificateType, number: number): Promise<number> {
    const row = await this.txHost.tx.certificate.findFirst({
      where: { schoolId, type, number },
      select: { issueNo: true },
      orderBy: { issueNo: 'desc' },
    });
    return row?.issueNo ?? 0;
  }

  /**
   * The student a certificate is issued to, in the caller's scope; null outside it. Read here so
   * the certificates module needs no student-module repository beyond the enrolment names.
   */
  async findStudent(schoolId: SchoolId, scope: Scope, id: bigint): Promise<CertificateStudent | null> {
    return this.txHost.tx.student.findFirst({
      where: { schoolId, id, AND: [studentInScope(scope)] },
      select: {
        id: true,
        fullName: true,
        admissionNo: true,
        gender: true,
        dateOfBirth: true,
        admittedOn: true,
        status: true,
      },
    });
  }

  /**
   * The student's B-Form ciphertext, for the leaving certificate's print view only (§7.1); null
   * outside the caller's scope or when none is recorded. The issue path never reads it.
   */
  async studentBForm(schoolId: SchoolId, scope: Scope, id: bigint): Promise<string | null> {
    const row = await this.txHost.tx.student.findFirst({
      where: { schoolId, id, AND: [studentInScope(scope)] },
      select: { bForm: true },
    });
    return row?.bForm ?? null;
  }

  /** The father's name for the body: a live father link first, else the newest ended one. */
  async fatherName(schoolId: SchoolId, studentId: bigint): Promise<string | null> {
    const row = await this.txHost.tx.studentGuardian.findFirst({
      where: { schoolId, studentId, relationship: 'father' },
      select: { guardian: { select: { fullName: true } } },
      orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { id: 'desc' }],
    });
    return row?.guardian.fullName ?? null;
  }

  /** Issuers' and voiders' display names (staff name, else guardian name, else ''). */
  names(schoolId: SchoolId, userIds: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, userIds);
  }

  /**
   * The type's next number: the cert_<type> counter advanced by one, created at 1 on first use,
   * its row locked to the end of the transaction, so numbers follow commit order and a rollback
   * leaves no gap (R289). Call it last, just before the insert.
   */
  async nextNumber(schoolId: SchoolId, type: CertificateType): Promise<number> {
    const name = certificateCounterName(type);
    const rows = await this.txHost.tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO school_counters (school_id, name, value)
      VALUES (${schoolId}, ${name}, 1)
      ON CONFLICT (school_id, name)
      DO UPDATE SET value = school_counters.value + 1, updated_at = now()
      RETURNING value`;
    const value = rows[0]?.value;
    if (value === undefined) throw new Error('certificate counter not advanced');
    return Number(value);
  }

  /** Inserts and reads back with the names (scope `all`: the caller just checked the student). */
  async create(schoolId: SchoolId, data: NewCertificate): Promise<CertificateRecord> {
    const { body, ...rest } = data;
    const row = await this.txHost.tx.certificate.create({
      data: { schoolId, ...rest, body: { ...body, enrolments: body.enrolments.map((e) => ({ ...e })) } },
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * Locks the row for the rest of the transaction if it is unchanged since `row` was read (a
   * compare-and-set on updated_at that writes nothing visible); false when it moved meanwhile.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<CertificateRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.certificate.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** One more print (R292's audited print). */
  async countPrint(schoolId: SchoolId, id: bigint): Promise<void> {
    await this.txHost.tx.certificate.updateMany({
      where: { schoolId, id },
      data: { printedCount: { increment: 1 } },
    });
  }

  /**
   * Voids a certificate number: stamps the void trio on every live issue of (type, number) in one
   * statement. Returns the issue numbers stamped, ascending; empty when none was live.
   */
  async voidNumber(
    schoolId: SchoolId,
    type: CertificateType,
    number: number,
    by: bigint,
    reason: string,
    now: Date,
  ): Promise<number[]> {
    const rows = await this.txHost.tx.certificate.updateManyAndReturn({
      where: { schoolId, type, number, voidedAt: null },
      data: { voidedAt: now, voidedBy: by, voidReason: reason },
      select: { issueNo: true },
    });
    return rows.map((r) => r.issueNo).sort((a, b) => a - b);
  }
}
