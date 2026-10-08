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
  notifiedAt: Date | null;
  supersedesId: bigint | null;
  createdAt: Date;
  subjects: ResultSubjectRecord[];
}

export type NewResult = Omit<
  ResultRecord,
  'id' | 'publishedAt' | 'supersededAt' | 'notifiedAt' | 'supersedesId' | 'createdAt' | 'subjects'
> & {
  classId: bigint;
  publishedAt: Date | null;
  /** A correction's version (slice 32): the row it replaces, and whether it is already told. */
  supersedesId?: bigint | null;
  notifiedAt?: Date | null;
  subjects: ResultSubjectRecord[];
};

/** A stored result with what its report card prints around the figures (§3.4). */
export interface ResultCardRecord extends ResultRecord {
  sheetVersion: number;
  classId: bigint;
  className: string;
  sectionId: bigint;
  sectionName: string;
  academicYearName: string;
  termName: string | null;
  studentName: string;
  admissionNo: string;
  rollNo: number | null;
  /** The year's display toggles (§3.7); all on when the settings row is missing. */
  show: { position: boolean; attendance: boolean; remark: boolean };
}

/** What the result-notify job sends for one claimed row (§3.5). */
export interface ClaimedResult {
  id: bigint;
  studentId: bigint;
  termId: bigint | null;
  percentBp: number | null;
  grade: string | null;
  revised: boolean;
  /** The row it replaces (a correction's version), whose chain decides result_revised vs result_published. */
  supersedesId: bigint | null;
}

const SUBJECT_SELECT = {
  resultId: true,
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
  notifiedAt: true,
  supersedesId: true,
  createdAt: true,
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

const toRecord = (
  { ownChildFlags, ...row }: Row,
  subjects: ReadonlyMap<bigint, ResultSubjectRecord[]>,
): ResultRecord => ({
  ...row,
  ownChildFlags: toFlags(ownChildFlags),
  subjects: subjects.get(row.id) ?? [],
});

const CARD_SELECT = {
  ...SELECT,
  // Same school by the composite foreign keys (school_id, sheet_id), (school_id, enrolment_id, …).
  sheet: {
    select: {
      version: true,
      classId: true,
      sectionId: true,
      class: { select: { name: true } },
      section: { select: { name: true } },
      term: { select: { name: true } },
      academicYear: {
        select: {
          name: true,
          resultSettings: { select: { showPosition: true, showAttendance: true, showRemark: true } },
        },
      },
    },
  },
  enrolment: { select: { rollNo: true, student: { select: { fullName: true, admissionNo: true } } } },
} satisfies Prisma.ResultSelect;

type CardRow = Prisma.ResultGetPayload<{ select: typeof CARD_SELECT }>;

const toCard = (
  { sheet, enrolment, ...row }: CardRow,
  subjects: ReadonlyMap<bigint, ResultSubjectRecord[]>,
): ResultCardRecord => {
  const show = sheet.academicYear.resultSettings;
  return {
    ...toRecord(row, subjects),
    sheetVersion: sheet.version,
    classId: sheet.classId,
    className: sheet.class.name,
    sectionId: sheet.sectionId,
    sectionName: sheet.section.name,
    academicYearName: sheet.academicYear.name,
    termName: sheet.term?.name ?? null,
    studentName: enrolment.student.fullName,
    admissionNo: enrolment.student.admissionNo,
    rollNo: enrolment.rollNo,
    show: {
      position: show?.showPosition ?? true,
      attendance: show?.showAttendance ?? true,
      remark: show?.showRemark ?? true,
    },
  };
};

@Injectable()
export class ResultRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The subjects of `resultIds` by result, in print order: one statement keyed on
   * (school_id, result_id) — never a nested relation read, which the planner answers with a scan
   * of result_subjects (performance review, slice 36).
   */
  private async subjectsOf(
    schoolId: SchoolId,
    resultIds: readonly bigint[],
  ): Promise<Map<bigint, ResultSubjectRecord[]>> {
    const byResult = new Map<bigint, ResultSubjectRecord[]>();
    if (resultIds.length === 0) return byResult;
    const rows = await this.txHost.tx.resultSubject.findMany({
      where: { schoolId, resultId: { in: [...new Set(resultIds)] } },
      select: SUBJECT_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { classSubjectId: 'asc' }],
    });
    for (const { resultId, ...subject } of rows) {
      const list = byResult.get(resultId) ?? [];
      list.push(subject);
      byResult.set(resultId, list);
    }
    return byResult;
  }

  /** Rows read with SELECT, with their subjects. */
  private async records(schoolId: SchoolId, rows: readonly Row[]): Promise<ResultRecord[]> {
    const subjects = await this.subjectsOf(
      schoolId,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toRecord(row, subjects));
  }

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
    return this.records(schoolId, rows);
  }

  /**
   * Report cards by id (§3.4), in the order given, missing ids omitted. Tenant-scoped only: the
   * caller has already resolved the ids inside its own scope (a staff key, a guardian's child, the
   * session's student).
   */
  async cards(schoolId: SchoolId, ids: readonly bigint[]): Promise<ResultCardRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: CARD_SELECT,
    });
    const subjects = await this.subjectsOf(
      schoolId,
      rows.map((r) => r.id),
    );
    const byId = new Map(rows.map((row) => [row.id, toCard(row, subjects)]));
    return ids.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    });
  }

  /**
   * Whether a staff reader's sheet scope reaches the result and it is a card (published, or
   * superseded after being stored): GET /results/:id and its print (§3.4). An approved, not yet
   * published row is read through its sheet's detail instead.
   */
  async staffVisible(schoolId: SchoolId, scope: MarksScope, id: bigint): Promise<boolean> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return false;
    const row = await this.txHost.tx.result.findFirst({
      where: {
        schoolId,
        id,
        OR: [{ publishedAt: { not: null } }, { supersededAt: { not: null } }],
        sheet: { is: scoped },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The student's published, live result of a class's term (or, `termId` null, its final) — the
   * row a correction revises (contracts/slice-32.md §4). The class, not the section: a student who
   * changed section mid-term holds it on the new section's sheet (§0.25).
   */
  async livePublishedOf(
    schoolId: SchoolId,
    query: { studentId: bigint; classId: bigint; termId: bigint | null },
  ): Promise<{ id: bigint; sheetId: bigint } | null> {
    return this.txHost.tx.result.findFirst({
      where: {
        schoolId,
        studentId: query.studentId,
        termId: query.termId,
        publishedAt: { not: null },
        supersededAt: null,
        sheet: { is: { classId: query.classId } },
      },
      select: { id: true, sheetId: true },
    });
  }

  /**
   * The student's stored, live but unpublished result of a class's term (an approved version
   * waiting for publication): an excusal then would leave its rows stale, so it is refused
   * (contracts/slice-32.md §4). Returns the version holding it.
   */
  async liveUnpublishedOf(
    schoolId: SchoolId,
    query: { studentId: bigint; classId: bigint; termId: bigint | null },
  ): Promise<{ sheetId: bigint } | null> {
    return this.txHost.tx.result.findFirst({
      where: {
        schoolId,
        studentId: query.studentId,
        termId: query.termId,
        publishedAt: null,
        supersededAt: null,
        sheet: { is: { classId: query.classId } },
      },
      select: { sheetId: true },
    });
  }

  /**
   * A11 (certificates): the student's published, live result of a year to print — the final
   * result, else the last term's (by the term's rank in the year). Null when none is published.
   */
  async certificateResultOf(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
  ): Promise<bigint | null> {
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, studentId, academicYearId, publishedAt: { not: null }, supersededAt: null },
      select: { id: true, termId: true, term: { select: { sortOrder: true } } },
    });
    const final = rows.find((r) => r.termId === null);
    if (final) return final.id;
    const last = [...rows].sort((a, b) => (b.term?.sortOrder ?? 0) - (a.term?.sortOrder ?? 0))[0];
    return last?.id ?? null;
  }

  /** The academic year of the student's newest enrolment (the withholding rule's default year). */
  async newestEnrolmentYear(schoolId: SchoolId, studentId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId },
      select: { academicYearId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    return row?.academicYearId ?? null;
  }

  /** The live cards of a sheet (every version's rows of that sheet row), print order by roll then name. */
  async sheetCardIds(schoolId: SchoolId, scope: MarksScope, sheetId: bigint): Promise<bigint[]> {
    const scoped = sheetScopeWhere(scope);
    if (scoped === null) return [];
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, sheetId, supersededAt: null, sheet: { is: scoped } },
      select: { id: true, enrolment: { select: { rollNo: true, student: { select: { fullName: true } } } } },
    });
    return rows
      .sort(
        (a, b) =>
          (a.enrolment.rollNo ?? Number.MAX_SAFE_INTEGER) - (b.enrolment.rollNo ?? Number.MAX_SAFE_INTEGER) ||
          a.enrolment.student.fullName.localeCompare(b.enrolment.student.fullName) ||
          (a.id < b.id ? -1 : 1),
      )
      .map((row) => row.id);
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
    return this.records(schoolId, rows);
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
        supersedesId: true,
      },
    });
  }

  /**
   * Whether the family was ever told a row of this chain (the row or one it supersedes, slice 32
   * fix round): a revised row is `result_revised` only then, else it is their first
   * `result_published`. Chains are a few corrections long.
   */
  async chainTold(schoolId: SchoolId, resultId: bigint): Promise<boolean> {
    let id: bigint | null = resultId;
    while (id !== null) {
      const row: { notifiedAt: Date | null; supersedesId: bigint | null } | null =
        await this.txHost.tx.result.findFirst({
          where: { schoolId, id },
          select: { notifiedAt: true, supersedesId: true },
        });
      if (!row) return false;
      if (row.notifiedAt !== null) return true;
      id = row.supersedesId;
    }
    return false;
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
