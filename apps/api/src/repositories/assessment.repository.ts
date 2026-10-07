import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope } from '../tenancy/scope';
import type { AssessmentKind, Prisma, TestType } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-30.md §2 (phase-4-academic.md §0.27, §3.2, §7.1). The tenant table assessments:
// a teacher's class test, or a term's exam (one per section, class-subject and term). Every read
// and write takes the subject-aware MarksScope and applies it **in the predicate**: a section in
// the scope and, for a read, a subject taught there or the section's class teacher (or cover);
// for a write, a subject taught there only. The one read without a scope is scopeDateOf, which
// returns the held_on date the scope is minted for and nothing else.

export interface AssessmentRecord {
  id: bigint;
  academicYearId: bigint;
  termId: bigint;
  termName: string;
  classId: bigint;
  className: string;
  sectionId: bigint;
  sectionName: string;
  classSubjectId: bigint;
  /** The class-subject's subject (subjects.id): what a teacher's assignment names. */
  subjectId: bigint;
  subjectName: string;
  kind: AssessmentKind;
  testType: TestType | null;
  name: string;
  maxMarks: number;
  /** UTC midnight of the calendar date (a `date` column). */
  heldOn: Date;
  createdBy: bigint;
  lockedAt: Date | null;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  academicYearId: true,
  termId: true,
  classId: true,
  sectionId: true,
  classSubjectId: true,
  kind: true,
  testType: true,
  name: true,
  maxMarks: true,
  heldOn: true,
  createdBy: true,
  lockedAt: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  createdAt: true,
  updatedAt: true,
  // Same school by the composite foreign keys (school_id, term_id, ...), (school_id, class_id, ...).
  term: { select: { name: true } },
  class: { select: { name: true } },
  section: { select: { name: true } },
  classSubject: { select: { subjectId: true, subject: { select: { name: true } } } },
} satisfies Prisma.AssessmentSelect;

type Row = Prisma.AssessmentGetPayload<{ select: typeof SELECT }>;

const toRecord = ({
  term,
  class: klass,
  section,
  classSubject,
  ...row
}: Row): AssessmentRecord => ({
  ...row,
  termName: term.name,
  className: klass.name,
  sectionName: section.name,
  subjectId: classSubject.subjectId,
  subjectName: classSubject.subject.name,
});

// ------------------------------------------------------------------------------------ scope

/**
 * Whether `scope` reaches a section and subject (§0.27): a read needs the section and either the
 * subject or the section's class teacher / cover role; a write needs the subject. `mode` is what
 * the caller does, not the scope's own mode, so a write scope can be used to read.
 */
export function scopeReaches(
  scope: MarksScope,
  mode: 'read' | 'write',
  sectionId: bigint,
  subjectId: bigint,
): boolean {
  if (scope.kind === 'all') return true;
  const roles = scope.sections.get(sectionId);
  if (!roles) return false;
  if (roles.subjectIds.includes(subjectId)) return true;
  return mode === 'read' && (roles.classTeacher || roles.cover);
}

/**
 * The scope as an assessments predicate, or null when it reaches nothing (an empty scope means no
 * rows, never no filter). `all` adds no condition.
 */
export function assessmentScopeWhere(
  scope: MarksScope,
  mode: 'read' | 'write',
): Prisma.AssessmentWhereInput | null {
  if (scope.kind === 'all') return {};
  const branches: Prisma.AssessmentWhereInput[] = [];
  for (const [sectionId, roles] of scope.sections) {
    if (mode === 'read' && (roles.classTeacher || roles.cover)) {
      branches.push({ sectionId });
    } else if (roles.subjectIds.length > 0) {
      branches.push({
        sectionId,
        classSubject: { is: { subjectId: { in: [...roles.subjectIds] } } },
      });
    }
  }
  return branches.length === 0 ? null : { OR: branches };
}

export interface AssessmentListFilter {
  termId?: bigint;
  classId?: bigint;
  sectionId?: bigint;
  classSubjectId?: bigint;
  kind?: AssessmentKind;
  includeVoided: boolean;
}

export interface NewAssessment {
  academicYearId: bigint;
  termId: bigint;
  classId: bigint;
  sectionId: bigint;
  classSubjectId: bigint;
  /** The class-subject's subject, checked against the scope before the insert. */
  subjectId: bigint;
  kind: AssessmentKind;
  testType: TestType | null;
  name: string;
  maxMarks: number;
  heldOn: Date;
  createdBy: bigint;
}

/** One exam of a term's set-up (§5 slice 29, moved to slice 30). */
export interface NewExam {
  academicYearId: bigint;
  termId: bigint;
  classId: bigint;
  sectionId: bigint;
  classSubjectId: bigint;
  subjectId: bigint;
  name: string;
  maxMarks: number;
  heldOn: Date;
  createdBy: bigint;
}

@Injectable()
export class AssessmentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The assessment's held_on and nothing else: the date the caller's MarksScope is minted for
   * (§0.27). Not a read of the row: a caller outside the scope learns nothing from it, because
   * every answer is then read through a scoped method.
   */
  async scopeDateOf(schoolId: SchoolId, id: bigint): Promise<Date | null> {
    const row = await this.txHost.tx.assessment.findFirst({
      where: { schoolId, id },
      select: { heldOn: true },
    });
    return row?.heldOn ?? null;
  }

  /** The assessment if `scope` reads it (voided included), else null. */
  async find(schoolId: SchoolId, scope: MarksScope, id: bigint): Promise<AssessmentRecord | null> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null) return null;
    const row = await this.txHost.tx.assessment.findFirst({
      where: { schoolId, id, ...scoped },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** The assessment if `scope` writes it (voided included), else null. */
  async findWritable(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    id: bigint,
  ): Promise<AssessmentRecord | null> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null) return null;
    const row = await this.txHost.tx.assessment.findFirst({
      where: { schoolId, id, ...scoped },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /**
   * The row lock (schema notes: lock the assessment FOR UPDATE before submit-marks, an excusal or
   * a PATCH): a compare-and-set UPDATE on updated_at that holds the row to the end of the
   * transaction. False when the row changed since it was read, or is outside the write scope.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    row: Pick<AssessmentRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null) return false;
    const { count } = await this.txHost.tx.assessment.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, ...scoped },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** A page of the assessments `scope` reads, newest held first (or oldest with `ascending`). */
  async list(
    schoolId: SchoolId,
    scope: MarksScope,
    filter: AssessmentListFilter,
    page: { skip: number; take: number; ascending: boolean },
  ): Promise<{ rows: AssessmentRecord[]; total: number }> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null) return { rows: [], total: 0 };
    const where: Prisma.AssessmentWhereInput = {
      schoolId,
      ...scoped,
      ...(filter.termId === undefined ? {} : { termId: filter.termId }),
      ...(filter.classId === undefined ? {} : { classId: filter.classId }),
      ...(filter.sectionId === undefined ? {} : { sectionId: filter.sectionId }),
      ...(filter.classSubjectId === undefined ? {} : { classSubjectId: filter.classSubjectId }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.includeVoided ? {} : { voidedAt: null }),
    };
    const direction = page.ascending ? 'asc' : 'desc';
    const rows = await this.txHost.tx.assessment.findMany({
      where,
      select: SELECT,
      orderBy: [{ heldOn: direction }, { id: direction }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.assessment.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /**
   * A test (or an exam row) inside `scope`'s write reach; null when the scope does not reach the
   * section and subject (nothing written). held_on outside the term fails on the trigger
   * assessments_held_on_in_term.
   */
  async create(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    data: NewAssessment,
  ): Promise<AssessmentRecord | null> {
    const { subjectId, ...columns } = data;
    if (!scopeReaches(scope, 'write', data.sectionId, subjectId)) return null;
    const row = await this.txHost.tx.assessment.create({
      data: { schoolId, ...columns },
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * name, held_on, max_marks under the caller's row lock. A change once any mark exists fails on
   * the trigger (assessments_has_marks), held_on outside the term on assessments_held_on_in_term.
   */
  async update(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    id: bigint,
    data: { name?: string; heldOn?: Date; maxMarks?: number },
  ): Promise<AssessmentRecord | null> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null) return null;
    const { count } = await this.txHost.tx.assessment.updateMany({
      where: { schoolId, id, ...scoped },
      data,
    });
    return count === 1 ? this.findWritable(schoolId, scope, id) : null;
  }

  /** Sets the void trio once (assessments_voided_frozen), under the caller's row lock. */
  async void(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    id: bigint,
    data: { voidedBy: bigint; voidReason: string },
  ): Promise<AssessmentRecord | null> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null) return null;
    const { count } = await this.txHost.tx.assessment.updateMany({
      where: { schoolId, id, voidedAt: null, ...scoped },
      data: { voidedAt: new Date(), ...data },
    });
    return count === 1 ? this.findWritable(schoolId, scope, id) : null;
  }

  /**
   * The live (non-voided) exams of a term among `classIds`, as `section:classSubject` pairs; only
   * those the write scope reaches.
   */
  async liveExamKeys(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    termId: bigint,
    classIds: readonly bigint[],
  ): Promise<Set<string>> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null || classIds.length === 0) return new Set();
    const rows = await this.txHost.tx.assessment.findMany({
      where: {
        schoolId,
        termId,
        kind: 'exam',
        voidedAt: null,
        classId: { in: [...classIds] },
        ...scoped,
      },
      select: { sectionId: true, classSubjectId: true },
    });
    return new Set(rows.map((row) => examKey(row.sectionId, row.classSubjectId)));
  }

  /**
   * The exams of a set-up, those the write scope reaches; a pair that already has a live exam is
   * skipped by assessments_exam_key (ON CONFLICT DO NOTHING), so a concurrent set-up cannot
   * duplicate one. Returns the number inserted.
   */
  async createExams(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    exams: readonly NewExam[],
  ): Promise<number> {
    const rows = exams
      .filter((exam) => scopeReaches(scope, 'write', exam.sectionId, exam.subjectId))
      .map(({ subjectId: _subjectId, ...exam }) => ({
        schoolId,
        kind: 'exam' as const,
        testType: null,
        ...exam,
      }));
    if (rows.length === 0) return 0;
    const { count } = await this.txHost.tx.assessment.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }
}

/** The set-up's key of one exam: a section and a class-subject. */
export const examKey = (sectionId: bigint, classSubjectId: bigint): string =>
  `${sectionId}:${classSubjectId}`;
