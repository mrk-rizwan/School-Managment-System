import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { RemarkCategory, RemarkVisibility } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import { liveGuardiansOf, staffNames, subjectNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// contracts/slice-13.md §5. The tenant table remarks: never edited (R141). A correction is a new
// row naming its predecessor in supersedes_id (a chain: partial unique remarks_supersedes_id_key);
// the AFTER INSERT trigger remarks_mark_superseded stamps the predecessor's superseded_at, the only
// column that ever changes. Student-linked: every read takes the caller's Scope through the
// remark's student.

/** The partial unique index on supersedes_id: a second correction of the same remark. */
export const REMARK_SUPERSEDES_UNIQUE = 'remarks_supersedes_id_key';

export interface RemarkRecord {
  id: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  authorStaffId: bigint;
  subjectId: bigint | null;
  /** UTC midnight of the calendar date (a `date` column). */
  date: Date;
  category: RemarkCategory;
  text: string;
  visibility: RemarkVisibility;
  supersedesId: bigint | null;
  correctionReason: string | null;
  supersededAt: Date | null;
  /** The correction naming this row, once one exists. */
  supersededById: bigint | null;
  createdAt: Date;
}

/** A remark with the names its DTOs carry. */
export interface RemarkView extends RemarkRecord {
  subjectName: string | null;
  authorName: string;
}

export interface RemarkCreate {
  enrolmentId: bigint;
  studentId: bigint;
  authorStaffId: bigint;
  subjectId: bigint | null;
  date: Date;
  category: RemarkCategory;
  text: string;
  visibility: RemarkVisibility;
  /** Both set for a correction, both null for an original (CHECK remarks_correction_check). */
  supersedesId: bigint | null;
  correctionReason: string | null;
}

export interface RemarkListQuery {
  category?: RemarkCategory;
  /** The visibilities to return; filtered in the query, never in a serialiser (§6.4). */
  visibilities?: readonly RemarkVisibility[];
  dateFrom?: Date;
  dateTo?: Date;
  includeSuperseded: boolean;
  descending: boolean;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  enrolmentId: true,
  studentId: true,
  authorStaffId: true,
  subjectId: true,
  date: true,
  category: true,
  text: true,
  visibility: true,
  supersedesId: true,
  correctionReason: true,
  supersededAt: true,
  createdAt: true,
  supersededBy: { select: { id: true }, take: 1 },
} satisfies Prisma.RemarkSelect;

type Row = Prisma.RemarkGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ supersededBy, ...row }: Row): RemarkRecord => ({
  ...row,
  supersededById: supersededBy[0]?.id ?? null,
});

/** Through the remark's enrolment's student: the student must be in the caller's scope. */
const inScope = (scope: Scope): Prisma.RemarkWhereInput => ({
  enrolment: { is: { student: { is: studentInScope(scope) } } },
});

@Injectable()
export class RemarkRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A correction naming an already corrected row fails REMARK_SUPERSEDES_UNIQUE. */
  async create(schoolId: SchoolId, data: RemarkCreate): Promise<RemarkRecord> {
    return toRecord(
      await this.txHost.tx.remark.create({ data: { schoolId, ...data }, select: SELECT }),
    );
  }

  /** Scoped: a remark whose student is outside the caller's scope reads as absent. */
  async findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<RemarkRecord | null> {
    const row = await this.txHost.tx.remark.findFirst({
      where: { schoolId, id, ...inScope(scope) },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** A student's remarks across every enrolment; none when the student is out of scope. */
  async listForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: RemarkListQuery,
  ): Promise<{ rows: RemarkRecord[]; total: number }> {
    const where: Prisma.RemarkWhereInput = {
      schoolId,
      studentId,
      ...inScope(scope),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.visibilities === undefined ? {} : { visibility: { in: [...query.visibilities] } }),
      ...(query.includeSuperseded ? {} : { supersededAt: null }),
      ...(query.dateFrom === undefined && query.dateTo === undefined
        ? {}
        : {
            date: {
              ...(query.dateFrom === undefined ? {} : { gte: query.dateFrom }),
              ...(query.dateTo === undefined ? {} : { lte: query.dateTo }),
            },
          }),
    };
    const total = await this.txHost.tx.remark.count({ where });
    const direction = query.descending ? 'desc' : 'asc';
    const rows = await this.txHost.tx.remark.findMany({
      where,
      select: SELECT,
      orderBy: [{ date: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    return { rows: rows.map(toRecord), total };
  }

  /**
   * Locks a remark that is not yet superseded, for the rest of the transaction (a no-op write of
   * superseded_at: null, which every remark trigger allows). False when it is already superseded,
   * or became so while this request waited for the lock.
   */
  async lockIfNotSuperseded(schoolId: SchoolId, id: bigint): Promise<boolean> {
    const { count } = await this.txHost.tx.remark.updateMany({
      where: { schoolId, id, supersededAt: null },
      data: { supersededAt: null },
    });
    return count === 1;
  }

  /**
   * The remark_posted audience (§5.4): every not-merged guardian with a live link to the student,
   * whatever its login flag (a suppression row is the visible outcome). Ascending ids.
   */
  guardianRecipients(schoolId: SchoolId, studentId: bigint): Promise<bigint[]> {
    return liveGuardiansOf(this.txHost.tx, schoolId, [studentId]);
  }

  /** Subject and author names for a page of remarks: two sequential statements. */
  async withNames(schoolId: SchoolId, rows: RemarkRecord[]): Promise<RemarkView[]> {
    if (rows.length === 0) return [];
    const subject = await subjectNames(
      this.txHost.tx,
      schoolId,
      rows.flatMap((r) => (r.subjectId === null ? [] : [r.subjectId])),
    );
    const author = await staffNames(this.txHost.tx, schoolId, rows.map((r) => r.authorStaffId));
    return rows.map((row) => ({
      ...row,
      subjectName: row.subjectId === null ? null : (subject(row.subjectId) ?? null),
      authorName: author(row.authorStaffId) ?? '',
    }));
  }
}
