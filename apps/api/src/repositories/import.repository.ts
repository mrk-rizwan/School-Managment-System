import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ImportKind, ImportRowError, ImportStatus, ImportStudent } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// Phase 5 slice 43 (contracts/slice-43.md; phase-5-extended.md rule 39, §3.2, R339-R343): the
// tenant table `imports` — a commencement file's preview (its parsed rows and row errors) until it
// is committed or fails. The status edges, the bounds and the no-identity CHECKs are the
// database's (migration 20261016120000_wave_u_rankings_imports_support). Also the two student
// reads a preview validates admission numbers against. Only the imports module and the
// staged-upload sweep (expiry) import it (lint).

export interface ImportRecord {
  id: bigint;
  kind: ImportKind;
  fileHash: string;
  fileName: string;
  rowCount: number;
  rows: Prisma.JsonValue;
  errors: Prisma.JsonValue;
  errorCount: number;
  status: ImportStatus;
  academicYearId: bigint;
  sectionId: bigint | null;
  classId: bigint | null;
  termId: bigint | null;
  dueOn: Date | null;
  createdBy: bigint;
  createdAt: Date;
  committedBy: bigint | null;
  committedAt: Date | null;
  failedAt: Date | null;
  error: string | null;
  updatedAt: Date;
  /** Names for display, by the composite foreign keys (same school). */
  academicYear: { name: string };
  class: { name: string } | null;
  section: { name: string } | null;
  term: { name: string } | null;
}

/** An import row without its stored rows (the history list). */
export type ImportSummary = Omit<ImportRecord, 'rows'>;

export interface NewImport {
  kind: ImportKind;
  fileHash: string;
  fileName: string;
  rowCount: number;
  rows: Prisma.InputJsonValue[];
  errors: readonly ImportRowError[];
  errorCount: number;
  academicYearId: bigint;
  sectionId: bigint | null;
  classId: bigint | null;
  termId: bigint | null;
  dueOn: Date | null;
  createdBy: bigint;
}

export interface ImportListFilter {
  kind?: ImportKind;
  status?: ImportStatus;
}

const SUMMARY = {
  id: true,
  kind: true,
  fileHash: true,
  fileName: true,
  rowCount: true,
  errors: true,
  errorCount: true,
  status: true,
  academicYearId: true,
  sectionId: true,
  classId: true,
  termId: true,
  dueOn: true,
  createdBy: true,
  createdAt: true,
  committedBy: true,
  committedAt: true,
  failedAt: true,
  error: true,
  updatedAt: true,
  academicYear: { select: { name: true } },
  class: { select: { name: true } },
  section: { select: { name: true } },
  term: { select: { name: true } },
} satisfies Prisma.ImportSelect;

const SELECT = { ...SUMMARY, rows: true } satisfies Prisma.ImportSelect;

/** A preview is committed within 24 hours, else it fails "expired" (§3.2, R339). */
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60_000;

/** Why an expired preview failed (§3.2: error "expired"). */
export const IMPORT_EXPIRED_ERROR = 'expired';

@Injectable()
export class ImportRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A preview: born `previewed` (trigger imports_guard). */
  create(schoolId: SchoolId, data: NewImport): Promise<ImportRecord> {
    return this.txHost.tx.import.create({
      data: {
        schoolId,
        ...data,
        errors: data.errors.map((e) => ({ ...e })),
      },
      select: SELECT,
    });
  }

  find(schoolId: SchoolId, id: bigint): Promise<ImportRecord | null> {
    return this.txHost.tx.import.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /**
   * The commit's row lock: a no-op update of a still-previewed import, held to the end of the
   * transaction, so a concurrent commit of the same import waits and then finds it committed.
   * False when it is no longer previewed.
   */
  async lockPreviewed(schoolId: SchoolId, id: bigint): Promise<boolean> {
    const { count } = await this.txHost.tx.import.updateMany({
      where: { schoolId, id, status: 'previewed' },
      data: { status: 'previewed' },
    });
    return count === 1;
  }

  /** previewed → committed (needs error_count = 0, CHECK imports_committed_check). */
  async markCommitted(schoolId: SchoolId, id: bigint, by: bigint, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.import.updateMany({
      where: { schoolId, id, status: 'previewed' },
      data: { status: 'committed', committedBy: by, committedAt: at },
    });
    return count;
  }

  /**
   * previewed → failed "expired" for every preview created before `before` (the 24-hour expiry,
   * folded into the staged-upload sweep, §3.5; or one import, at its commit). Returns the ids.
   */
  async expire(schoolId: SchoolId, before: Date, at: Date, id?: bigint): Promise<bigint[]> {
    const rows = await this.txHost.tx.import.updateManyAndReturn({
      where: { schoolId, status: 'previewed', createdAt: { lt: before }, ...(id === undefined ? {} : { id }) },
      data: { status: 'failed', failedAt: at, error: IMPORT_EXPIRED_ERROR },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** The committed import of this file, if any (R341). */
  async committedWithHash(schoolId: SchoolId, kind: ImportKind, fileHash: string): Promise<bigint | null> {
    const row = await this.txHost.tx.import.findFirst({
      where: { schoolId, kind, fileHash, status: 'committed' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** A page of the school's imports, newest first, and the total. */
  async list(
    schoolId: SchoolId,
    filter: ImportListFilter,
    page: { skip: number; take: number },
  ): Promise<{ rows: ImportSummary[]; total: number }> {
    const where: Prisma.ImportWhereInput = {
      schoolId,
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    };
    const rows = await this.txHost.tx.import.findMany({
      where,
      select: SUMMARY,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.import.count({ where });
    return { rows, total };
  }

  // -------------------------------------------------------------------- the students a file names

  /** Of `admissionNos`, those that are the school's (any status): "unknown" vs "not on roster". */
  async knownAdmissionNos(schoolId: SchoolId, admissionNos: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(admissionNos)].filter((no) => no !== '' && no.length <= 20);
    if (wanted.length === 0) return new Set();
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, admissionNo: { in: wanted } },
      select: { admissionNo: true },
    });
    return new Set(rows.map((r) => r.admissionNo));
  }

  /**
   * An opening-balances file's roster (§1.1, R339 "no live enrolment"): each student of the year
   * whose enrolment has not ended and who is active or suspended (a suspended student is still
   * charged, rule 20), with that enrolment. A student holds at most one open enrolment a year.
   */
  async openingBalanceRoster(schoolId: SchoolId, academicYearId: bigint): Promise<ImportStudent[]> {
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        academicYearId,
        endedOn: null,
        student: { schoolId, status: { in: ['active', 'suspended'] } },
      },
      select: { id: true, studentId: true, student: { select: { admissionNo: true } } },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      admissionNo: r.student.admissionNo,
      studentId: r.studentId.toString(),
      enrolmentId: r.id.toString(),
    }));
  }

  /** Students' names and admission numbers by id (the preview table). */
  async studentNames(
    schoolId: SchoolId,
    ids: readonly bigint[],
  ): Promise<Map<bigint, { fullName: string; admissionNo: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true, admissionNo: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: r.fullName, admissionNo: r.admissionNo }]));
  }

  /** Display names of users (who previewed, who committed). */
  names(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, ids);
  }
}
