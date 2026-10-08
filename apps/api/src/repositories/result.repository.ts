import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ResultSubjectStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { sheetScopeWhere } from './result-sheet.repository';

// contracts/slice-31.md §2 (phase-4-academic.md §0.25, §3.2): the tenant tables results and
// result_subjects. A full row set is written per sheet version at approval, in two statements;
// after that only published_at, superseded_at, superseded_by and notified_at change (trigger
// results_columns_immutable). Staff reads go through the sheet and take the caller's MarksScope,
// applied to the result's sheet (sheetScopeWhere). The result-notify job's claim and sweep run in
// QueueTenancy.runAsSchool with no session, so they take none.

/** One flag of §0.28: a guardian of the student among the contributors. */
export interface OwnChildFlag {
  userId: bigint;
  role: OwnChildRole;
}

export const OWN_CHILD_ROLES = ['mark_author', 'remark_author', 'submitter', 'approver'] as const;
export type OwnChildRole = (typeof OWN_CHILD_ROLES)[number];

export interface ResultSubjectRecord {
  classSubjectId: bigint;
  subjectName: string;
  sortOrder: number;
  testBp: number | null;
  examBp: number | null;
  examObtained: number | null;
  examMax: number | null;
  examAbsent: boolean;
  examExcused: boolean;
  percentBp: number | null;
  obtained: number | null;
  max: number;
  grade: string | null;
  status: ResultSubjectStatus;
  ownChildOf: bigint | null;
}

export interface ResultRecord {
  id: bigint;
  sheetId: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  termId: bigint | null;
  totalObtained: number;
  totalMax: number;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  failedSubjects: number;
  position: number | null;
  positionOf: number | null;
  attendanceBp: number | null;
  remark: string | null;
  ownChildFlags: OwnChildFlag[];
  revised: boolean;
  publishedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  subjects: ResultSubjectRecord[];
}

export type NewResult = Omit<
  ResultRecord,
  'id' | 'publishedAt' | 'supersededAt' | 'createdAt' | 'subjects'
> & {
  classId: bigint;
  publishedAt: Date | null;
  subjects: ResultSubjectRecord[];
};

/** What the result-notify job sends for one claimed row (§3.5). */
export interface ClaimedResult {
  id: bigint;
  studentId: bigint;
  termId: bigint | null;
  percentBp: number | null;
  grade: string | null;
  revised: boolean;
}

const SUBJECT_SELECT = {
  classSubjectId: true,
  subjectName: true,
  sortOrder: true,
  testBp: true,
  examBp: true,
  examObtained: true,
  examMax: true,
  examAbsent: true,
  examExcused: true,
  percentBp: true,
  obtained: true,
  max: true,
  grade: true,
  status: true,
  ownChildOf: true,
} satisfies Prisma.ResultSubjectSelect;

const SELECT = {
  id: true,
  sheetId: true,
  enrolmentId: true,
  studentId: true,
  academicYearId: true,
  termId: true,
  totalObtained: true,
  totalMax: true,
  percentBp: true,
  grade: true,
  passed: true,
  failedSubjects: true,
  position: true,
  positionOf: true,
  attendanceBp: true,
  remark: true,
  ownChildFlags: true,
  revised: true,
  publishedAt: true,
  supersededAt: true,
  createdAt: true,
  subjects: { select: SUBJECT_SELECT, orderBy: [{ sortOrder: 'asc' }, { classSubjectId: 'asc' }] },
} satisfies Prisma.ResultSelect;

type Row = Prisma.ResultGetPayload<{ select: typeof SELECT }>;

const isRole = (value: unknown): value is OwnChildRole =>
  typeof value === 'string' && (OWN_CHILD_ROLES as readonly string[]).includes(value);

/** The stored flags (CHECK results_own_child_flags_check: an array of { userId, role }). */
function toFlags(value: Prisma.JsonValue): OwnChildFlag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const { userId, role } = entry;
    return typeof userId === 'string' && isRole(role) ? [{ userId: BigInt(userId), role }] : [];
  });
}

const toRecord = ({ ownChildFlags, ...row }: Row): ResultRecord => ({
  ...row,
  ownChildFlags: toFlags(ownChildFlags),
});

@Injectable()
export class ResultRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * A sheet version's full row set (§0.25, R269): the results in one statement, their subjects in
   * a second. The sheet must be approved or published (trigger results_insert_guard). Returns the
   * new ids by enrolment.
   */
  async insertSet(
    schoolId: SchoolId,
    sheetId: bigint,
    rows: readonly NewResult[],
  ): Promise<Map<bigint, bigint>> {
    if (rows.length === 0) return new Map();
    const created = await this.txHost.tx.result.createManyAndReturn({
      data: rows.map(({ subjects: _subjects, classId: _classId, ownChildFlags, ...row }) => ({
        schoolId,
        ...row,
        sheetId,
        ownChildFlags: ownChildFlags.map((f) => ({ userId: f.userId.toString(), role: f.role })),
      })),
      select: { id: true, enrolmentId: true },
    });
    const ids = new Map(created.map((row) => [row.enrolmentId, row.id]));
    const subjects = rows.flatMap((row) => {
      const resultId = ids.get(row.enrolmentId);
      if (resultId === undefined) throw new Error('a result row was not returned by its insert');
      return row.subjects.map((subject) => ({
        schoolId,
        resultId,
        classId: row.classId,
        ...subject,
      }));
    });
    if (subjects.length > 0) await this.txHost.tx.resultSubject.createMany({ data: subjects });
    return ids;
  }

  /** The sheet's rows (live only, or every version's row with `includeSuperseded`), with subjects. */
  async forSheet(
    schoolId: SchoolId,
    scope: MarksScope,
    sheetId: bigint,
    includeSuperseded = false,
  ): Promise<ResultRecord[]> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return [];
    const rows = await this.txHost.tx.result.findMany({
      where: {
        schoolId,
        sheetId,
        ...(includeSuperseded ? {} : { supersededAt: null }),
        sheet: { is: scoped },
      },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toRecord);
  }

  /** A return from approved supersedes that version's stored rows (R269). */
  async supersedeSheetRows(schoolId: SchoolId, sheetId: bigint, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.result.updateMany({
      where: { schoolId, sheetId, supersededAt: null },
      data: { supersededAt: at },
    });
    return count;
  }

  /** Publication stamps the sheet's live rows (R272). */
  async publishSheetRows(schoolId: SchoolId, sheetId: bigint, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.result.updateMany({
      where: { schoolId, sheetId, supersededAt: null, publishedAt: null },
      data: { publishedAt: at },
    });
    return count;
  }

  /**
   * The final sheet's inputs (R275, A6): the published, live term results of `studentIds` in the
   * class and year (a class change starts from the join, A14), with subjects.
   */
  async publishedTermResults(
    schoolId: SchoolId,
    query: { academicYearId: bigint; classId: bigint; studentIds: readonly bigint[] },
  ): Promise<ResultRecord[]> {
    if (query.studentIds.length === 0) return [];
    const rows = await this.txHost.tx.result.findMany({
      where: {
        schoolId,
        academicYearId: query.academicYearId,
        studentId: { in: [...query.studentIds] },
        termId: { not: null },
        supersededAt: null,
        publishedAt: { not: null },
        sheet: { is: { classId: query.classId } },
      },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toRecord);
  }

  /**
   * The result-notify job's claim (§3.6, R105): stamps notified_at on the target's rows that are
   * published, live and not yet notified, and returns them. A replay, a superseded or an
   * unpublished row claims nothing.
   */
  async claimForNotify(
    schoolId: SchoolId,
    target: { sheetId: bigint } | { resultId: bigint },
    now: Date,
  ): Promise<ClaimedResult[]> {
    return this.txHost.tx.result.updateManyAndReturn({
      where: {
        schoolId,
        ...('sheetId' in target ? { sheetId: target.sheetId } : { id: target.resultId }),
        publishedAt: { not: null },
        supersededAt: null,
        notifiedAt: null,
      },
      data: { notifiedAt: now },
      select: {
        id: true,
        studentId: true,
        termId: true,
        percentBp: true,
        grade: true,
        revised: true,
      },
    });
  }

  /**
   * The result messages' recipients per student (§1.1 "Notification", R273): the receipt rule —
   * the fee-payer guardians on a live link, else the primary contacts, else every live guardian
   * (not merged away) — and the student's own login when student logins are on and it is active.
   * With the student's name. Reads no result: the students are those the job just claimed.
   */
  async notifyRecipients(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    studentLoginEnabled: boolean,
  ): Promise<Map<bigint, { fullName: string; guardianIds: bigint[]; student: boolean }>> {
    const ids = [...new Set(studentIds)];
    if (ids.length === 0) return new Map();
    const students = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: ids } },
      select: {
        id: true,
        fullName: true,
        status: true,
        user: { select: { status: true } },
      },
    });
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        endedAt: null,
        studentId: { in: ids },
        guardian: { is: { mergedIntoId: null } },
      },
      select: { studentId: true, guardianId: true, isFeePayer: true, isPrimaryContact: true },
      orderBy: [{ studentId: 'asc' }, { guardianId: 'asc' }],
    });
    const result = new Map<bigint, { fullName: string; guardianIds: bigint[]; student: boolean }>();
    for (const student of students) {
      const own = links.filter((l) => l.studentId === student.id);
      const pick = (keep: (l: (typeof own)[number]) => boolean) => [
        ...new Set(own.filter(keep).map((l) => l.guardianId)),
      ];
      const payers = pick((l) => l.isFeePayer);
      const primary = pick((l) => l.isPrimaryContact);
      result.set(student.id, {
        fullName: student.fullName,
        guardianIds: payers.length > 0 ? payers : primary.length > 0 ? primary : pick(() => true),
        student:
          studentLoginEnabled && student.status === 'active' && student.user?.status === 'active',
      });
    }
    return result;
  }

  /**
   * The sweep's source (§3.6): sheets with a published live row still unnotified since before
   * `before` (a job lost after commit), oldest first.
   */
  async unnotifiedSheetIds(schoolId: SchoolId, before: Date, limit: number): Promise<bigint[]> {
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, publishedAt: { lt: before }, supersededAt: null, notifiedAt: null },
      select: { sheetId: true },
      distinct: ['sheetId'],
      orderBy: { sheetId: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.sheetId);
  }
}
