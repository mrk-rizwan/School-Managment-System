import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { GradeBand, PassRule, ResultSheetStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope } from '../tenancy/scope';
import { Prisma } from './generated/prisma/client';
import { userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-31.md §2 (phase-4-academic.md §3.2, rule 27): the tenant tables result_sheets
// and result_sheet_remarks. Every read and write takes the caller's MarksScope and applies it in
// the predicate (sheetScopeWhere): school-wide, or the sections the caller class-teaches or covers
// on the scope's date. The status edges, the approver rule and the snapshot freeze are the
// database's (migration 20261008120000_wave_o_result_sheets); the service checks first.

/** The settings a sheet was approved with (§3.2), null until approval. */
export interface SheetSnapshot {
  testWeight: number | null;
  examWeight: number | null;
  passPercent: number | null;
  passRule: PassRule | null;
  bands: GradeBand[] | null;
  /** The final sheet's: the year's terms in order, with their weights and whether held. */
  termWeights: TermWeight[] | null;
}

export interface TermWeight {
  termId: bigint;
  weight: number;
  held: boolean;
}

export interface ResultSheetRecord {
  id: bigint;
  academicYearId: bigint;
  termId: bigint | null;
  termName: string | null;
  classId: bigint;
  className: string;
  sectionId: bigint;
  sectionName: string;
  version: number;
  status: ResultSheetStatus;
  createdBy: bigint;
  submittedBy: bigint | null;
  submittedAt: Date | null;
  submittedUnderAssignmentId: bigint | null;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  selfApproved: boolean;
  returnReason: string | null;
  publishedBy: bigint | null;
  publishedAt: Date | null;
  supersedesId: bigint | null;
  snapshot: SheetSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemarkRecord {
  enrolmentId: bigint;
  remark: string | null;
  writtenBy: bigint;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  academicYearId: true,
  termId: true,
  classId: true,
  sectionId: true,
  version: true,
  status: true,
  createdBy: true,
  submittedBy: true,
  submittedAt: true,
  submittedUnderAssignmentId: true,
  decidedBy: true,
  decidedAt: true,
  selfApproved: true,
  returnReason: true,
  publishedBy: true,
  publishedAt: true,
  supersedesId: true,
  testWeight: true,
  examWeight: true,
  passPercent: true,
  passRule: true,
  bands: true,
  termWeights: true,
  createdAt: true,
  updatedAt: true,
  // Same school and year by the composite foreign keys.
  term: { select: { name: true } },
  class: { select: { name: true } },
  section: { select: { name: true } },
} satisfies Prisma.ResultSheetSelect;

type Row = Prisma.ResultSheetGetPayload<{ select: typeof SELECT }>;

const isObject = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored bands (CHECK result_sheets_snapshot_check: an array). */
function toBands(value: Prisma.JsonValue | null): GradeBand[] | null {
  if (value === null || !Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const { grade, minPercent } = entry;
    return typeof grade === 'string' && typeof minPercent === 'number'
      ? [{ grade, minPercent }]
      : [];
  });
}

function toTermWeights(value: Prisma.JsonValue | null): TermWeight[] | null {
  if (value === null || !Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const { termId, weight, held } = entry;
    return typeof termId === 'string' && typeof weight === 'number' && typeof held === 'boolean'
      ? [{ termId: BigInt(termId), weight, held }]
      : [];
  });
}

const toRecord = ({
  term,
  class: klass,
  section,
  testWeight,
  examWeight,
  passPercent,
  passRule,
  bands,
  termWeights,
  ...row
}: Row): ResultSheetRecord => ({
  ...row,
  termName: term?.name ?? null,
  className: klass.name,
  sectionName: section.name,
  snapshot: {
    testWeight,
    examWeight,
    passPercent,
    passRule,
    bands: toBands(bands),
    termWeights: toTermWeights(termWeights),
  },
});

/**
 * The scope as a result_sheets predicate (§3.1), or null when it reaches nothing (an empty scope
 * means no rows, never no filter): `all` adds no condition; otherwise the sections the caller is
 * class teacher or cover of on the scope's date. A subject teacher reads no sheet.
 */
export function sheetScopeWhere(scope: MarksScope): Prisma.ResultSheetWhereInput | null {
  if (scope.kind === 'all') return {};
  const sections = [...scope.sections]
    .filter(([, roles]) => roles.classTeacher || roles.cover)
    .map(([sectionId]) => sectionId);
  return sections.length === 0 ? null : { sectionId: { in: sections } };
}

/** Whether the scope reaches a sheet of `sectionId` (the in-memory twin of sheetScopeWhere). */
export function sheetScopeReaches(scope: MarksScope, sectionId: bigint): boolean {
  if (scope.kind === 'all') return true;
  const roles = scope.sections.get(sectionId);
  return roles !== undefined && (roles.classTeacher || roles.cover);
}

export interface SheetListFilter {
  termId?: bigint;
  /** True: the final sheets only. */
  finalOnly?: boolean;
  classId?: bigint;
  sectionId?: bigint;
  status?: ResultSheetStatus;
}

export type SheetListSort = '-updatedAt' | 'updatedAt' | 'submittedAt';

@Injectable()
export class ResultSheetRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The sheet if the scope reads it, else null. */
  async find(schoolId: SchoolId, scope: MarksScope, id: bigint): Promise<ResultSheetRecord | null> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return null;
    const row = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, id, ...scoped },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /**
   * The row lock: a compare-and-set UPDATE on updated_at that holds the row to the end of the
   * transaction. False when it changed since it was read, or is outside the scope.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    scope: MarksScope,
    row: Pick<ResultSheetRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return false;
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, ...scoped },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The open (not published) version of a section's term (or final) sheet, if any (R267). */
  async findOpen(
    schoolId: SchoolId,
    scope: MarksScope,
    sectionId: bigint,
    termId: bigint | null,
  ): Promise<ResultSheetRecord | null> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return null;
    const row = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, sectionId, termId, status: { not: 'published' }, ...scoped },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** Whether a published version of the section's term (or final) sheet exists. */
  async hasPublished(
    schoolId: SchoolId,
    sectionId: bigint,
    termId: bigint | null,
  ): Promise<boolean> {
    const row = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, sectionId, termId, status: 'published' },
      select: { id: true },
    });
    return row !== null;
  }

  /** Of `termIds`, those with a published sheet for the section (R275). */
  async publishedTermIds(
    schoolId: SchoolId,
    sectionId: bigint,
    termIds: readonly bigint[],
  ): Promise<Set<bigint>> {
    if (termIds.length === 0) return new Set();
    const rows = await this.txHost.tx.resultSheet.findMany({
      where: { schoolId, sectionId, termId: { in: [...termIds] }, status: 'published' },
      select: { termId: true },
    });
    return new Set(rows.flatMap((row) => (row.termId === null ? [] : [row.termId])));
  }

  /** A page of the sheets the scope reads, and its total. */
  async list(
    schoolId: SchoolId,
    scope: MarksScope,
    filter: SheetListFilter,
    page: { skip: number; take: number; sort: SheetListSort },
  ): Promise<{ rows: ResultSheetRecord[]; total: number }> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return { rows: [], total: 0 };
    const where: Prisma.ResultSheetWhereInput = {
      schoolId,
      AND: [
        scoped,
        {
          ...(filter.finalOnly
            ? { termId: null }
            : filter.termId === undefined
              ? {}
              : { termId: filter.termId }),
          ...(filter.classId === undefined ? {} : { classId: filter.classId }),
          ...(filter.sectionId === undefined ? {} : { sectionId: filter.sectionId }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
        },
      ],
    };
    const orderBy: Prisma.ResultSheetOrderByWithRelationInput[] =
      page.sort === 'submittedAt'
        ? [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
        : page.sort === 'updatedAt'
          ? [{ updatedAt: 'asc' }, { id: 'asc' }]
          : [{ updatedAt: 'desc' }, { id: 'desc' }];
    const rows = await this.txHost.tx.resultSheet.findMany({
      where,
      select: SELECT,
      orderBy,
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.resultSheet.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** Version 1 of a section's term (or final) sheet, born draft. */
  async create(
    schoolId: SchoolId,
    data: {
      academicYearId: bigint;
      termId: bigint | null;
      classId: bigint;
      sectionId: bigint;
      createdBy: bigint;
    },
  ): Promise<ResultSheetRecord> {
    const row = await this.txHost.tx.resultSheet.create({
      data: { schoolId, ...data, version: 1, status: 'draft' },
      select: SELECT,
    });
    return toRecord(row);
  }

  /** draft | returned → submitted, under the caller's row lock. */
  async submit(
    schoolId: SchoolId,
    id: bigint,
    data: { submittedBy: bigint; submittedAt: Date; submittedUnderAssignmentId: bigint | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id, status: { in: ['draft', 'returned'] } },
      data: {
        ...data,
        status: 'submitted',
        decidedBy: null,
        decidedAt: null,
        selfApproved: false,
        returnReason: null,
      },
    });
    return count;
  }

  /**
   * The final sheet's entry into review (it has no submitter, R275): draft | returned → submitted
   * with no submitter, in the approving transaction, so the status edges stay the six of §3.2.
   */
  async enterReviewWithoutSubmitter(schoolId: SchoolId, id: bigint): Promise<number> {
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id, termId: null, status: { in: ['draft', 'returned'] } },
      data: {
        status: 'submitted',
        submittedBy: null,
        submittedAt: null,
        decidedBy: null,
        decidedAt: null,
        selfApproved: false,
        returnReason: null,
      },
    });
    return count;
  }

  /** submitted | approved → returned, with the decider and the reason. */
  async markReturned(
    schoolId: SchoolId,
    id: bigint,
    data: { decidedBy: bigint; decidedAt: Date; returnReason: string },
  ): Promise<number> {
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id, status: { in: ['submitted', 'approved'] } },
      data: { ...data, status: 'returned', selfApproved: false },
    });
    return count;
  }

  /** submitted → approved, with the decision and the settings snapshot (§3.2). */
  async markApproved(
    schoolId: SchoolId,
    id: bigint,
    data: {
      decidedBy: bigint;
      decidedAt: Date;
      selfApproved: boolean;
      snapshot: SheetSnapshot;
    },
  ): Promise<number> {
    const { snapshot } = data;
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id, status: 'submitted' },
      data: {
        status: 'approved',
        decidedBy: data.decidedBy,
        decidedAt: data.decidedAt,
        selfApproved: data.selfApproved,
        testWeight: snapshot.testWeight,
        examWeight: snapshot.examWeight,
        passPercent: snapshot.passPercent,
        passRule: snapshot.passRule,
        ...(snapshot.bands === null
          ? {}
          : { bands: snapshot.bands.map((b) => ({ grade: b.grade, minPercent: b.minPercent })) }),
        ...(snapshot.termWeights === null
          ? {}
          : {
              termWeights: snapshot.termWeights.map((t) => ({
                termId: t.termId.toString(),
                weight: t.weight,
                held: t.held,
              })),
            }),
      },
    });
    return count;
  }

  /** approved → published. */
  async markPublished(
    schoolId: SchoolId,
    id: bigint,
    data: { publishedBy: bigint; publishedAt: Date },
  ): Promise<number> {
    const { count } = await this.txHost.tx.resultSheet.updateMany({
      where: { schoolId, id, status: 'approved' },
      data: { ...data, status: 'published' },
    });
    return count;
  }

  /**
   * What a submission locks (R268, §2.4), written after the sheet is `submitted` (trigger
   * result_sheet_locks_guard): a result_sheet_locks row per test the sheet holds and per roster
   * student, and locked_at stamped once on each of those tests that has none (one another sheet
   * locked keeps its stamp). Returns how many tests were stamped.
   */
  async lockSubmission(
    schoolId: SchoolId,
    sheetId: bigint,
    lock: { testIds: readonly bigint[]; studentIds: readonly bigint[]; at: Date },
  ): Promise<number> {
    await this.txHost.tx.resultSheetLock.createMany({
      data: [
        ...lock.testIds.map((assessmentId) => ({ schoolId, sheetId, assessmentId })),
        ...lock.studentIds.map((studentId) => ({ schoolId, sheetId, studentId })),
      ],
    });
    if (lock.testIds.length === 0) return 0;
    await this.lockTestRows(schoolId, lock.testIds);
    const { count } = await this.txHost.tx.assessment.updateMany({
      where: {
        schoolId,
        id: { in: [...lock.testIds] },
        kind: 'test',
        voidedAt: null,
        lockedAt: null,
      },
      data: { lockedAt: lock.at },
    });
    return count;
  }

  /**
   * A return (R269), after the sheet is `returned`: its lock rows are released (released_at; never
   * deleted), and exactly the tests it locked unlock, except those another unreleased row still
   * names — a test locked by two sheets stays locked until both are returned. Returns how many
   * tests were unlocked.
   */
  async releaseSubmission(schoolId: SchoolId, sheetId: bigint, at: Date): Promise<number> {
    const own = await this.txHost.tx.resultSheetLock.findMany({
      where: { schoolId, sheetId, releasedAt: null, assessmentId: { not: null } },
      select: { assessmentId: true },
    });
    const testIds = own.flatMap((r) => (r.assessmentId === null ? [] : [r.assessmentId]));
    // Serialises with a concurrent submission or return holding the same tests, so the read of
    // the other holders below sees one that committed in the meantime.
    if (testIds.length > 0) await this.lockTestRows(schoolId, testIds);
    await this.txHost.tx.resultSheetLock.updateMany({
      where: { schoolId, sheetId, releasedAt: null },
      data: { releasedAt: at },
    });
    if (testIds.length === 0) return 0;
    const others = await this.txHost.tx.resultSheetLock.findMany({
      where: { schoolId, assessmentId: { in: testIds }, releasedAt: null },
      select: { assessmentId: true },
    });
    const held = new Set(others.map((r) => r.assessmentId));
    const free = testIds.filter((id) => !held.has(id));
    if (free.length === 0) return 0;
    const { count } = await this.txHost.tx.assessment.updateMany({
      where: { schoolId, id: { in: free }, kind: 'test', lockedAt: { not: null } },
      data: { lockedAt: null },
    });
    return count;
  }

  /** The tests' rows FOR UPDATE, in id order (a submission and a return of two sheets). */
  private async lockTestRows(schoolId: SchoolId, testIds: readonly bigint[]): Promise<void> {
    await this.txHost.tx.$queryRaw`
      SELECT a.id FROM assessments a
       WHERE a.school_id = ${schoolId} AND a.id IN (${Prisma.join([...testIds])})
       ORDER BY a.id
         FOR UPDATE`;
  }

  // ------------------------------------------------------------------------------------ remarks

  /** The sheet's remarks, by enrolment. */
  async remarks(schoolId: SchoolId, sheetId: bigint): Promise<RemarkRecord[]> {
    return this.txHost.tx.resultSheetRemark.findMany({
      where: { schoolId, sheetId },
      select: { enrolmentId: true, remark: true, writtenBy: true, updatedAt: true },
      orderBy: { enrolmentId: 'asc' },
    });
  }

  /**
   * Writes the given remarks (null clears one; the row stays), under the sheet's row lock; the
   * trigger result_sheet_remarks_open refuses a sheet that is not draft or returned. Returns the
   * enrolments whose text changed.
   */
  async writeRemarks(
    schoolId: SchoolId,
    sheetId: bigint,
    writtenBy: bigint,
    remarks: readonly { enrolmentId: bigint; remark: string | null }[],
  ): Promise<bigint[]> {
    const existing = new Map(
      (await this.remarks(schoolId, sheetId)).map((r) => [r.enrolmentId, r.remark]),
    );
    const changed: bigint[] = [];
    for (const { enrolmentId, remark } of remarks) {
      if (existing.has(enrolmentId)) {
        if (existing.get(enrolmentId) === remark) continue;
        await this.txHost.tx.resultSheetRemark.updateMany({
          where: { schoolId, sheetId, enrolmentId },
          data: { remark, writtenBy },
        });
      } else {
        if (remark === null) continue;
        await this.txHost.tx.resultSheetRemark.create({
          data: { schoolId, sheetId, enrolmentId, remark, writtenBy },
        });
      }
      changed.push(enrolmentId);
    }
    return changed;
  }

  /** Display names of users (submitter, decider, publisher, remark writers). */
  names(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, ids);
  }
}
