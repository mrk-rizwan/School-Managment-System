import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PromotionOutcome, PromotionSheetStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { Prisma, type AcademicYearStatus, type ClassStatus, type StudentStatus, type EnrolmentStatus } from './generated/prisma/client';
import { userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-35.md (phase-4-academic.md §3.2 "Promotion", §5 slice 35): the tenant tables
// promotion_sheets and promotion_decisions, and the reads that open a sheet (the section's
// roster, its held terms, the source sheet's status, the live results). Every sheet read and
// write takes the caller's Scope (tenancy control 7: a decision is student-linked) and applies it
// on the sheet's section. The promotion module writes enrolments and statuses only through
// EnrolmentsService and StudentsService (§5.1); this repository writes only its own two tables.

export interface PromotionSheetRecord {
  id: bigint;
  academicYearId: bigint;
  academicYearName: string;
  classId: bigint;
  className: string;
  /** The class is its school's final class: only its rows may complete (R295). */
  classIsFinal: boolean;
  sectionId: bigint;
  sectionName: string;
  targetYearId: bigint;
  targetYearName: string;
  status: PromotionSheetStatus;
  openedBy: bigint;
  openedAt: Date;
  appliedBy: bigint | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromotionSheetListRecord extends PromotionSheetRecord {
  rows: number;
  undecided: number;
}

export interface PromotionDecisionRecord {
  id: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  studentName: string;
  admissionNo: string;
  studentStatus: StudentStatus;
  rollNo: number | null;
  enrolmentStatus: EnrolmentStatus;
  /** UTC midnight of the enrolment's first day: one starting after the year's end cannot close at it. */
  enrolmentStartedOn: Date;
  resultId: bigint | null;
  /** The result was superseded after the row read it (a correction or a return). */
  resultSuperseded: boolean;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  proposed: PromotionOutcome | null;
  decision: PromotionOutcome | null;
  reason: string | null;
  targetClassId: bigint | null;
  targetClassName: string | null;
  targetSectionId: bigint | null;
  targetSectionName: string | null;
  newEnrolmentId: bigint | null;
  arrearsFlag: boolean;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  revisedAfterApply: boolean;
}

export interface DecisionCreate {
  enrolmentId: bigint;
  studentId: bigint;
  resultId: bigint | null;
  proposed: PromotionOutcome | null;
  decision: PromotionOutcome | null;
  targetClassId: bigint | null;
  targetSectionId: bigint | null;
  arrearsFlag: boolean;
}

export interface DecisionChange {
  resultId: bigint | null;
  proposed: PromotionOutcome | null;
  decision: PromotionOutcome;
  reason: string | null;
  targetClassId: bigint | null;
  targetSectionId: bigint | null;
  decidedBy: bigint;
  decidedAt: Date;
}

/** The section a sheet is opened for, with its class (the promotion links). */
export interface PromotionSection {
  id: bigint;
  name: string;
  deletedAt: Date | null;
  classId: bigint;
  className: string;
  academicYearId: bigint;
  isFinal: boolean;
  nextClassId: bigint | null;
}

export interface PromotionYear {
  id: bigint;
  name: string;
  startsOn: Date;
  endsOn: Date;
  status: AcademicYearStatus;
}

/** A class of the target year with its live sections (the target lookup). */
export interface TargetClass {
  id: bigint;
  name: string;
  academicYearId: bigint;
  status: ClassStatus;
  sections: { id: bigint; name: string }[];
}

export interface RosterRow {
  enrolmentId: bigint;
  studentId: bigint;
  studentStatus: StudentStatus;
}

export interface LiveResult {
  id: bigint;
  enrolmentId: bigint;
  passed: boolean | null;
}

const SHEET_SELECT = {
  id: true,
  academicYearId: true,
  classId: true,
  sectionId: true,
  targetYearId: true,
  status: true,
  openedBy: true,
  openedAt: true,
  appliedBy: true,
  appliedAt: true,
  createdAt: true,
  updatedAt: true,
  academicYear: { select: { name: true } },
  targetYear: { select: { name: true } },
  class: { select: { name: true, isFinal: true } },
  section: { select: { name: true } },
} satisfies Prisma.PromotionSheetSelect;

type SheetRow = Prisma.PromotionSheetGetPayload<{ select: typeof SHEET_SELECT }>;

const toSheet = ({ academicYear, targetYear, class: klass, section, ...row }: SheetRow): PromotionSheetRecord => ({
  ...row,
  academicYearName: academicYear.name,
  targetYearName: targetYear.name,
  className: klass.name,
  classIsFinal: klass.isFinal,
  sectionName: section.name,
});

const DECISION_SELECT = {
  id: true,
  enrolmentId: true,
  studentId: true,
  resultId: true,
  proposed: true,
  decision: true,
  reason: true,
  targetClassId: true,
  targetSectionId: true,
  newEnrolmentId: true,
  arrearsFlag: true,
  decidedBy: true,
  decidedAt: true,
  appliedAt: true,
  revisedAfterApply: true,
  enrolment: {
    select: {
      rollNo: true,
      status: true,
      startedOn: true,
      student: { select: { fullName: true, admissionNo: true, status: true } },
    },
  },
  result: { select: { percentBp: true, grade: true, passed: true, supersededAt: true } },
  targetClass: { select: { name: true } },
  targetSection: { select: { name: true } },
} satisfies Prisma.PromotionDecisionSelect;

type DecisionRow = Prisma.PromotionDecisionGetPayload<{ select: typeof DECISION_SELECT }>;

const toDecision = ({ enrolment, result, targetClass, targetSection, ...row }: DecisionRow): PromotionDecisionRecord => ({
  ...row,
  studentName: enrolment.student.fullName,
  admissionNo: enrolment.student.admissionNo,
  studentStatus: enrolment.student.status,
  rollNo: enrolment.rollNo,
  enrolmentStatus: enrolment.status,
  enrolmentStartedOn: enrolment.startedOn,
  resultSuperseded: result !== null && result.supersededAt !== null,
  percentBp: result?.percentBp ?? null,
  grade: result?.grade ?? null,
  passed: result?.passed ?? null,
  targetClassName: targetClass?.name ?? null,
  targetSectionName: targetSection?.name ?? null,
});

/** The caller's scope on a sheet's section: a section scope reads its sections; a capacity scope none. */
function sheetInScope(scope: Scope): Prisma.PromotionSheetWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'sections':
      return { sectionId: { in: [...scope.ids] } };
    case 'students':
      return { id: { in: [] } };
  }
}

function sectionInScope(scope: Scope): Prisma.SectionWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'sections':
      return { id: { in: [...scope.ids] } };
    case 'students':
      return { id: { in: [] } };
  }
}

/** A sheet whose result was approved: the rows of an approved or published version only. */
const DECIDED_SHEET = ['approved', 'published'] as const;

@Injectable()
export class PromotionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ------------------------------------------------------------------------------ sheets

  async list(
    schoolId: SchoolId,
    scope: Scope,
    query: {
      academicYearId?: bigint;
      sectionId?: bigint;
      status?: PromotionSheetStatus;
      descending: boolean;
      skip: number;
      take: number;
    },
  ): Promise<{ rows: PromotionSheetListRecord[]; total: number }> {
    const tx = this.txHost.tx;
    const where: Prisma.PromotionSheetWhereInput = {
      schoolId,
      ...sheetInScope(scope),
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const [rows, total] = [
      await tx.promotionSheet.findMany({
        where,
        select: SHEET_SELECT,
        orderBy: [{ openedAt: query.descending ? 'desc' : 'asc' }, { id: query.descending ? 'desc' : 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      await tx.promotionSheet.count({ where }),
    ];
    const ids = rows.map((r) => r.id);
    const counts =
      ids.length === 0
        ? []
        : await tx.promotionDecision.groupBy({
            by: ['sheetId'],
            where: { schoolId, sheetId: { in: ids } },
            _count: { _all: true, decision: true },
          });
    const bySheet = new Map(counts.map((c) => [c.sheetId, c._count]));
    return {
      rows: rows.map((row) => {
        const count = bySheet.get(row.id);
        const all = count?._all ?? 0;
        return { ...toSheet(row), rows: all, undecided: all - (count?.decision ?? 0) };
      }),
      total,
    };
  }

  async findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<PromotionSheetRecord | null> {
    const row = await this.txHost.tx.promotionSheet.findFirst({
      where: { schoolId, id, ...sheetInScope(scope) },
      select: SHEET_SELECT,
    });
    return row && toSheet(row);
  }

  /** The section's open sheet, if any (one by promotion_sheets_open_key). */
  async findOpenForSection(schoolId: SchoolId, sectionId: bigint): Promise<{ id: bigint } | null> {
    return this.txHost.tx.promotionSheet.findFirst({
      where: { schoolId, sectionId, status: 'open' },
      select: { id: true },
    });
  }

  /** Locks the sheet for the rest of the transaction if it is unchanged since `row` was read. */
  async lockIfUnchanged(
    schoolId: SchoolId,
    scope: Scope,
    row: Pick<PromotionSheetRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.promotionSheet.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, ...sheetInScope(scope) },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** A new open sheet with its rows (the rows' trigger requires the sheet open, so they follow it). */
  async create(
    schoolId: SchoolId,
    sheet: { academicYearId: bigint; classId: bigint; sectionId: bigint; targetYearId: bigint; openedBy: bigint },
    decisions: readonly DecisionCreate[],
  ): Promise<bigint> {
    const tx = this.txHost.tx;
    const { id } = await tx.promotionSheet.create({ data: { schoolId, ...sheet }, select: { id: true } });
    if (decisions.length > 0) {
      await tx.promotionDecision.createMany({
        data: decisions.map((d) => ({ schoolId, sheetId: id, targetYearId: sheet.targetYearId, ...d })),
      });
    }
    return id;
  }

  /** open → cancelled (contracts/slice-35.md §1): its rows stay, frozen; the section's open slot is freed. */
  async markCancelled(schoolId: SchoolId, id: bigint): Promise<number> {
    const { count } = await this.txHost.tx.promotionSheet.updateMany({
      where: { schoolId, id, status: 'open' },
      data: { status: 'cancelled' },
    });
    return count;
  }

  /** Marks the sheet applied (after its rows: they are written only while it is open). */
  async markApplied(schoolId: SchoolId, id: bigint, appliedBy: bigint, appliedAt: Date): Promise<number> {
    const { count } = await this.txHost.tx.promotionSheet.updateMany({
      where: { schoolId, id, status: 'open' },
      data: { status: 'applied', appliedBy, appliedAt },
    });
    return count;
  }

  // ---------------------------------------------------------------------------- decisions

  /** A sheet's rows, by roll number then name. The sheet was read in scope by the caller. */
  async decisions(schoolId: SchoolId, sheetId: bigint): Promise<PromotionDecisionRecord[]> {
    const rows = await this.txHost.tx.promotionDecision.findMany({
      where: { schoolId, sheetId },
      select: DECISION_SELECT,
      orderBy: [{ enrolment: { rollNo: { sort: 'asc', nulls: 'last' } } }, { enrolment: { student: { fullName: 'asc' } } }, { id: 'asc' }],
    });
    return rows.map(toDecision);
  }

  async updateDecision(schoolId: SchoolId, id: bigint, data: DecisionChange): Promise<number> {
    const { count } = await this.txHost.tx.promotionDecision.updateMany({ where: { schoolId, id, appliedAt: null }, data });
    return count;
  }

  /**
   * Apply's rows in one statement (§7.2): each marked applied with the enrolment it opened (or
   * none). Returns rows changed: fewer than given means one was applied meanwhile.
   */
  async markDecisionsApplied(
    schoolId: SchoolId,
    items: readonly { id: bigint; newEnrolmentId: bigint | null }[],
    appliedAt: Date,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const values = items.map((i) => Prisma.sql`(${i.id}::bigint, ${i.newEnrolmentId}::bigint)`);
    return this.txHost.tx.$executeRaw`
      UPDATE promotion_decisions AS d
         SET applied_at = ${appliedAt}, new_enrolment_id = v.new_enrolment_id, updated_at = ${appliedAt}
        FROM (VALUES ${Prisma.join(values)}) AS v (id, new_enrolment_id)
       WHERE d.school_id = ${schoolId} AND d.id = v.id AND d.applied_at IS NULL`;
  }

  /**
   * Apply's share lock on the results its rows name (R298), taken before it reads them: a
   * correction superseding one waits for apply to commit (its trigger then marks the applied row
   * revised_after_apply), and apply waits for a correction already under way (then reads the row
   * superseded and refuses). Either way no applied row names a superseded result unflagged.
   * Returns the result ids held.
   */
  async lockResults(schoolId: SchoolId, sheetId: bigint): Promise<bigint[]> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT r.id FROM promotion_decisions d
        JOIN results r ON r.school_id = d.school_id AND r.id = d.result_id
       WHERE d.school_id = ${schoolId} AND d.sheet_id = ${sheetId}
       ORDER BY r.id
         FOR SHARE OF r`;
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------- reads for opening

  /** The section in the caller's scope, with its class's promotion links; null outside it. */
  async section(schoolId: SchoolId, scope: Scope, id: bigint): Promise<PromotionSection | null> {
    const row = await this.txHost.tx.section.findFirst({
      where: { schoolId, id, AND: [sectionInScope(scope)] },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        class: { select: { id: true, name: true, academicYearId: true, isFinal: true, nextClassId: true } },
      },
    });
    if (!row) return null;
    const { class: klass, ...section } = row;
    return {
      ...section,
      classId: klass.id,
      className: klass.name,
      academicYearId: klass.academicYearId,
      isFinal: klass.isFinal,
      nextClassId: klass.nextClassId,
    };
  }

  year(schoolId: SchoolId, id: bigint): Promise<PromotionYear | null> {
    return this.txHost.tx.academicYear.findFirst({
      where: { schoolId, id },
      select: { id: true, name: true, startsOn: true, endsOn: true, status: true },
    });
  }

  /** The year's terms held for the class (no live skip), in order (A6, A7). */
  async heldTerms(schoolId: SchoolId, academicYearId: bigint, classId: bigint): Promise<bigint[]> {
    const terms = await this.txHost.tx.academicTerm.findMany({
      where: { schoolId, academicYearId },
      select: { id: true },
      orderBy: { sortOrder: 'asc' },
    });
    const skipped = new Set(
      (
        await this.txHost.tx.termSkip.findMany({
          where: { schoolId, academicYearId, classId, endedAt: null },
          select: { termId: true },
        })
      ).map((s) => s.termId),
    );
    return terms.map((t) => t.id).filter((id) => !skipped.has(id));
  }

  /** Whether the section's newest version of the term's (null: the final) sheet is approved or published. */
  async sourceSheetDecided(schoolId: SchoolId, sectionId: bigint, termId: bigint | null): Promise<boolean> {
    const newest = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, sectionId, termId },
      select: { status: true },
      orderBy: { version: 'desc' },
    });
    return newest !== null && (DECIDED_SHEET as readonly string[]).includes(newest.status);
  }

  /** The section's active enrolments in the year (the sheet's rows). */
  async roster(schoolId: SchoolId, sectionId: bigint, academicYearId: bigint): Promise<RosterRow[]> {
    const rows = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, sectionId, academicYearId, status: 'active' },
      select: { id: true, studentId: true, student: { select: { status: true } } },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({ enrolmentId: r.id, studentId: r.studentId, studentStatus: r.student.status }));
  }

  /**
   * The live results of the term (null: the final) for the given enrolments, on an approved or
   * published sheet version (R294).
   */
  async liveResults(
    schoolId: SchoolId,
    enrolmentIds: readonly bigint[],
    termId: bigint | null,
  ): Promise<LiveResult[]> {
    if (enrolmentIds.length === 0) return [];
    return this.txHost.tx.result.findMany({
      where: {
        schoolId,
        enrolmentId: { in: [...enrolmentIds] },
        termId,
        supersededAt: null,
        sheet: { is: { schoolId, status: { in: [...DECIDED_SHEET] } } },
      },
      select: { id: true, enrolmentId: true, passed: true },
    });
  }

  /** The target year's classes with their live sections, by name. */
  async classesOfYear(schoolId: SchoolId, academicYearId: bigint): Promise<TargetClass[]> {
    return this.txHost.tx.class.findMany({
      where: { schoolId, academicYearId },
      select: {
        id: true,
        name: true,
        academicYearId: true,
        status: true,
        sections: { where: { schoolId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** Display names for the opener and applier. */
  names(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, ids);
  }
}
