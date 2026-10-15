import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  ChargeStatus,
  GuardianRelationship,
  LateCountsAs,
  PaymentMethod,
  PaymentStatus,
  SchoolStatus,
  StatementBasis,
  StudentStatus,
} from '../generated/prisma/client';
import type { SchoolId } from '../../tenancy/school-id';
import { AuditReadsRepository, type AuditReadFilter, type AuditReadRow } from '../audit-reads.repository';
import type { PrismaTxAdapter } from '../prisma';

// Exception 7's closed set of read views (phase-5-extended.md §1.1 "Support views", §3.1; rule 35,
// R351; contracts/slice-45.md §2.2). The ONLY tenant reads a platform support session makes: each
// method takes the support SchoolId (schoolIdFromSupportSession), filters school_id on every
// statement, and selects named, non-sensitive columns only - never a CNIC, B-Form, hash, object
// key, message, document, slip, payroll or staff identity column. Lists are bounded by the
// caller's page (at most 50). Each method returns the ids it read, so both audit logs can name the
// subjects. Read-only: no method writes, and every call runs in SupportReadContext (READ ONLY, the
// guard's `support` flag). Importable only from src/modules/platform/support/** (eslint.config.mjs).

/** What a view read: its rows and the subject ids for the audit rows. */
export interface SupportRead<T> {
  value: T;
  /** e.g. { students: [5n] } or { charges: [..], student: [5n] }. */
  subjects: Record<string, readonly bigint[]>;
}

export interface SupportSettingsRow {
  schoolId: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
  feeDueDay: number;
  feeCutoffDay: number;
  lateFeeEnabled: boolean;
  lateFeeAmount: number | null;
  lateFeeGraceDays: number;
  payDay: number;
  expenseApprovalThreshold: number;
  periodsPerDay: number;
  weeklyOffDays: number[];
  studentLoginEnabled: boolean;
  lateCountsAs: LateCountsAs;
  financialStatementBasis: StatementBasis;
}

export interface SupportEnrolmentRow {
  academicYearName: string;
  className: string;
  sectionName: string;
  rollNo: number | null;
}

export interface SupportStudentSummaryRow {
  id: bigint;
  admissionNo: string;
  fullName: string;
  status: StudentStatus;
  current: SupportEnrolmentRow | null;
}

export interface SupportGuardianRow {
  id: bigint;
  fullName: string;
  phone: string | null;
  relationship: GuardianRelationship;
  isPrimaryContact: boolean;
  isFeePayer: boolean;
}

export interface SupportStudentRow extends SupportStudentSummaryRow {
  admittedOn: Date;
  guardians: SupportGuardianRow[];
}

export interface SupportChargeRow {
  id: bigint;
  description: string;
  feeHeadName: string;
  period: string | null;
  dueOn: Date;
  amount: number;
  allocatedAmount: number;
  creditedAmount: number;
  status: ChargeStatus;
}

export interface SupportPaymentRow {
  id: bigint;
  receivedOn: Date;
  method: PaymentMethod;
  amount: number;
  /** What of it went to this student's charges (live allocations), or the advance held for them. */
  forStudent: number;
  status: PaymentStatus;
  verifiedAt: Date;
  receiptNo: number | null;
}

const STUDENT_SUMMARY = { id: true, admissionNo: true, fullName: true, status: true } as const;

@Injectable()
export class SupportReadsRepository {
  /** The audit screen's read (slice 46), built here so the support module never holds it. */
  private readonly auditReads: AuditReadsRepository;

  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {
    this.auditReads = new AuditReadsRepository(txHost);
  }

  /** The school's timezone (the audit view's calendar dates). */
  async timezone(schoolId: SchoolId): Promise<string> {
    const row = await this.txHost.tx.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
    return row?.timezone ?? 'Asia/Karachi';
  }

  /** View 1: the school's own row and its settings, non-sensitive fields only. */
  async settings(schoolId: SchoolId): Promise<SupportRead<SupportSettingsRow | null>> {
    const school = await this.txHost.tx.school.findFirst({
      where: { id: schoolId },
      select: { id: true, name: true, shortCode: true, status: true, timezone: true },
    });
    const settings = await this.txHost.tx.schoolSettings.findFirst({
      where: { schoolId },
      select: {
        feeDueDay: true,
        feeCutoffDay: true,
        lateFeeEnabled: true,
        lateFeeAmount: true,
        lateFeeGraceDays: true,
        payDay: true,
        expenseApprovalThreshold: true,
        periodsPerDay: true,
        weeklyOffDays: true,
        studentLoginEnabled: true,
        lateCountsAs: true,
        financialStatementBasis: true,
      },
    });
    if (school === null || settings === null) return { value: null, subjects: {} };
    const { id, ...rest } = school;
    return { value: { schoolId: id, ...rest, ...settings }, subjects: { school: [id] } };
  }

  /** View 2: students by exact admission number (unique per school, so one at most). */
  async studentsByAdmissionNo(
    schoolId: SchoolId,
    admissionNo: string,
    skip: number,
    take: number,
  ): Promise<SupportRead<{ rows: SupportStudentSummaryRow[]; total: number }>> {
    const where = { schoolId, admissionNo };
    const students = await this.txHost.tx.student.findMany({
      where,
      select: STUDENT_SUMMARY,
      orderBy: { id: 'asc' },
      skip,
      take,
    });
    const total = await this.txHost.tx.student.count({ where });
    const current = await this.currentEnrolments(schoolId, students.map((s) => s.id));
    const rows = students.map((s) => ({ ...s, current: current.get(s.id) ?? null }));
    return { value: { rows, total }, subjects: { students: rows.map((r) => r.id) } };
  }

  /** View 3: one student, the current enrolment and the live guardian links (names and phones). */
  async student(schoolId: SchoolId, studentId: bigint): Promise<SupportRead<SupportStudentRow | null>> {
    const student = await this.txHost.tx.student.findFirst({
      where: { schoolId, id: studentId },
      select: { ...STUDENT_SUMMARY, admittedOn: true },
    });
    if (student === null) return { value: null, subjects: {} };
    const current = await this.currentEnrolments(schoolId, [student.id]);
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, studentId: student.id, endedAt: null },
      select: { guardianId: true, relationship: true, isPrimaryContact: true, isFeePayer: true },
      orderBy: { id: 'asc' },
    });
    const guardians = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: links.map((l) => l.guardianId) } },
      select: { id: true, fullName: true, phone: true },
    });
    const byId = new Map(guardians.map((g) => [g.id, g]));
    const rows = links.flatMap((link): SupportGuardianRow[] => {
      const guardian = byId.get(link.guardianId);
      return guardian === undefined
        ? []
        : [
            {
              id: guardian.id,
              fullName: guardian.fullName,
              phone: guardian.phone,
              relationship: link.relationship,
              isPrimaryContact: link.isPrimaryContact,
              isFeePayer: link.isFeePayer,
            },
          ];
    });
    return {
      value: { ...student, current: current.get(student.id) ?? null, guardians: rows },
      subjects: { student: [student.id], guardians: rows.map((g) => g.id) },
    };
  }

  /** Whether the student is this school's (the charges and payments views' 404). */
  async studentExists(schoolId: SchoolId, studentId: bigint): Promise<boolean> {
    return (
      (await this.txHost.tx.student.findFirst({ where: { schoolId, id: studentId }, select: { id: true } })) !== null
    );
  }

  /** View 4: the student's charges, newest due first. */
  async charges(
    schoolId: SchoolId,
    studentId: bigint,
    skip: number,
    take: number,
  ): Promise<SupportRead<{ rows: SupportChargeRow[]; total: number }>> {
    const where = { schoolId, studentId };
    const charges = await this.txHost.tx.charge.findMany({
      where,
      select: {
        id: true,
        description: true,
        feeHeadId: true,
        period: true,
        dueOn: true,
        amount: true,
        allocatedAmount: true,
        creditedAmount: true,
        status: true,
      },
      orderBy: [{ dueOn: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    const total = await this.txHost.tx.charge.count({ where });
    const heads = await this.txHost.tx.feeHead.findMany({
      where: { schoolId, id: { in: [...new Set(charges.map((c) => c.feeHeadId))] } },
      select: { id: true, name: true },
    });
    const headName = new Map(heads.map((h) => [h.id, h.name]));
    const rows = charges.map(({ feeHeadId, ...charge }) => ({ ...charge, feeHeadName: headName.get(feeHeadId) ?? '' }));
    return { value: { rows, total }, subjects: { student: [studentId], charges: rows.map((r) => r.id) } };
  }

  /**
   * View 5: payments that reached the student, newest first: those with an allocation to one of
   * the student's charges, and advances held for the student.
   */
  async payments(
    schoolId: SchoolId,
    studentId: bigint,
    skip: number,
    take: number,
  ): Promise<SupportRead<{ rows: SupportPaymentRow[]; total: number }>> {
    const where = {
      schoolId,
      OR: [{ advanceForStudentId: studentId }, { allocations: { some: { schoolId, studentId } } }],
    };
    const payments = await this.txHost.tx.payment.findMany({
      where,
      select: {
        id: true,
        receivedOn: true,
        method: true,
        amount: true,
        unallocatedAmount: true,
        advanceForStudentId: true,
        status: true,
        verifiedAt: true,
      },
      orderBy: [{ receivedOn: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    const total = await this.txHost.tx.payment.count({ where });
    const ids = payments.map((p) => p.id);
    const allocations = await this.txHost.tx.paymentAllocation.findMany({
      where: { schoolId, studentId, paymentId: { in: ids }, reversedAt: null },
      select: { paymentId: true, amount: true },
    });
    const receipts = await this.txHost.tx.receipt.findMany({
      where: { schoolId, paymentId: { in: ids } },
      select: { paymentId: true, receiptNo: true },
    });
    const allocated = new Map<bigint, number>();
    for (const a of allocations) allocated.set(a.paymentId, (allocated.get(a.paymentId) ?? 0) + a.amount);
    const receiptNo = new Map(receipts.map((r) => [r.paymentId, r.receiptNo]));
    const rows = payments.map((p) => ({
      id: p.id,
      receivedOn: p.receivedOn,
      method: p.method,
      amount: p.amount,
      forStudent: (allocated.get(p.id) ?? 0) + (p.advanceForStudentId === studentId ? p.unallocatedAmount : 0),
      status: p.status,
      verifiedAt: p.verifiedAt,
      receiptNo: receiptNo.get(p.id) ?? null,
    }));
    return { value: { rows, total }, subjects: { student: [studentId], payments: rows.map((r) => r.id) } };
  }

  /** View 6: the school's own audit log, with the audit screen's exclusions (slice 46). */
  async auditLog(
    schoolId: SchoolId,
    filter: AuditReadFilter,
    skip: number,
    take: number,
  ): Promise<SupportRead<{ rows: AuditReadRow[]; total: number }>> {
    const page = await this.auditReads.page(schoolId, filter, skip, take);
    return { value: page, subjects: { audit_log: page.rows.map((r) => r.id) } };
  }

  /** The active enrolment of each student, with its year, class and section names. */
  private async currentEnrolments(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
  ): Promise<Map<bigint, SupportEnrolmentRow>> {
    if (studentIds.length === 0) return new Map();
    const enrolments = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, studentId: { in: [...studentIds] }, status: 'active' },
      select: { studentId: true, academicYearId: true, classId: true, sectionId: true, rollNo: true },
      orderBy: { id: 'asc' },
    });
    if (enrolments.length === 0) return new Map();
    const unique = (ids: bigint[]) => [...new Set(ids)];
    const years = await this.txHost.tx.academicYear.findMany({
      where: { schoolId, id: { in: unique(enrolments.map((e) => e.academicYearId)) } },
      select: { id: true, name: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: unique(enrolments.map((e) => e.classId)) } },
      select: { id: true, name: true },
    });
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: unique(enrolments.map((e) => e.sectionId)) } },
      select: { id: true, name: true },
    });
    const name = (rows: { id: bigint; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));
    const year = name(years);
    const cls = name(classes);
    const section = name(sections);
    return new Map(
      enrolments.map((e) => [
        e.studentId,
        {
          academicYearName: year.get(e.academicYearId) ?? '',
          className: cls.get(e.classId) ?? '',
          sectionName: section.get(e.sectionId) ?? '',
          rollNo: e.rollNo,
        },
      ]),
    );
  }
}
