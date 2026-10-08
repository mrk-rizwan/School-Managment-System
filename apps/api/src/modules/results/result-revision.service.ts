import { Injectable } from '@nestjs/common';
import { ErrorCode, positions } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, concurrentUpdate, notFound } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import {
  ResultSheetRepository,
  type ResultSheetRecord,
} from '../../repositories/result-sheet.repository';
import {
  ResultRepository,
  type NewResult,
  type OwnChildFlag,
  type ResultRecord,
} from '../../repositories/result.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import { PermissionsService } from '../access/permissions.service';
import {
  ResultComposer,
  type ComposedRow,
  type Composition,
  type SubjectHeader,
} from './result-composer';
import { snapshotSettings, ResultSheetsService } from './result-sheets.service';
import { selfDecision } from './results.shared';

// contracts/slice-32.md §4 (phase-4-academic.md §0.25, §1.1 "Correction cascade", R280): what an
// approved correction (or an excusal after publication) does to the stored results. Under the
// published version's lock: the term sheet is re-composed from the live marks with its own
// snapshot, as version n+1 born published with the FULL row set (each row naming the one it
// supersedes, `revised` where its figures changed, the section re-ranked); the old rows stay
// readable, superseded. The student's published final result is re-composed the same way from
// the new term rows. Only the corrected student is told (`result-notify { resultId }`), once, and
// only when their figures changed. An applied promotion decision that named a superseded row is
// flagged `revised_after_apply` by the database (trigger results_promotion_revised, slice 35); an
// open promotion sheet re-checks its rows at apply.

/** A refusal: a sheet of the section is approved and not published, so a change would leave its rows stale. */
const versionOpen = (sheetId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_VERSION_OPEN,
    'The result sheet is approved but not published: publish or return the sheet first.',
    { sheetId: sheetId.toString() },
  );

/** A refusal: the student is no longer on the version's re-composed roster, so nothing can be revised. */
const offRoster = (sheetId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.CONCURRENT_UPDATE,
    "The student is no longer on this result sheet's roster: the result cannot be re-composed.",
    { sheetId: sheetId.toString() },
  );

export interface Revision {
  /** The corrected student's new term row. */
  resultId: bigint;
  /** Its figures changed (so it is told `result_revised`). */
  revised: boolean;
  termSheetId: bigint;
  finalSheetId: bigint | null;
  /** The decider submitted the term sheet: allowed only to the sole principal (R281), recorded on the version. */
  selfApproved: boolean;
}

@Injectable()
export class ResultRevisionService {
  constructor(
    private readonly sheetsService: ResultSheetsService,
    private readonly sheets: ResultSheetRepository,
    private readonly results: ResultRepository,
    private readonly composer: ResultComposer,
    private readonly terms: AcademicTermRepository,
    private readonly years: AcademicYearRepository,
    private readonly outbox: OutboxDispatcher,
    private readonly permissions: PermissionsService,
    private readonly clock: SchoolClock,
  ) {}

  /**
   * The student's published, live term result of the assessment's class and term (a correction
   * is allowed only then: MARK_CORRECTION_SHEET_NOT_PUBLISHED otherwise).
   */
  publishedTermResultOf(
    schoolId: SchoolId,
    query: { studentId: bigint; classId: bigint; termId: bigint },
  ): Promise<{ id: bigint; sheetId: bigint } | null> {
    return this.results.livePublishedOf(schoolId, query);
  }

  /**
   * An excusal with no published term row (contracts/slice-32.md §4): refused while the student's
   * term row is stored on an approved, unpublished version (its rows would go stale) — publish or
   * return the sheet first. Before approval nothing is stored, and the excusal simply counts.
   */
  async refuseIfApprovedUnpublished(
    schoolId: SchoolId,
    target: { studentId: bigint; classId: bigint; termId: bigint },
  ): Promise<void> {
    const stored = await this.results.liveUnpublishedOf(schoolId, target);
    if (stored) throw versionOpen(stored.sheetId);
  }

  /**
   * The cascade (R280), inside the caller's transaction, after the mark has changed. `approver`
   * is the deciding user (the new versions' decider and publisher, and the `approver` of the
   * own-child flags). Enqueues the corrected student's message after commit.
   */
  async revise(
    session: SchoolSessionContext,
    target: { studentId: bigint; classId: bigint; termId: bigint },
    approver: bigint,
  ): Promise<Revision> {
    const schoolId = session.schoolId;
    const scope = await this.sheetsService.scopeOf(session);
    if (!scope) throw notFound();
    const now = this.clock.now();

    // The term sheet: the version holding the student's live published row, locked.
    const termSheet = await this.lockVersion(schoolId, scope, target, now);
    // R281: the version is decided by the approver, never its submitter (the sole principal may,
    // recorded self_approved; trigger result_sheets_not_self holds the same on INSERT).
    const selfApproved = await this.notSubmitter(schoolId, termSheet, approver);
    const yearTerms = await this.terms.allForYear(schoolId, termSheet.academicYearId);
    const term = yearTerms.find((t) => t.id === termSheet.termId);
    const settings = snapshotSettings(termSheet);
    if (!term || !settings) throw notFound();
    const contributors = { remarks: [], submittedBy: termSheet.submittedBy, approver };
    // The subjects the version was approved with (not today's list: a subject added since is not
    // on this term's cards).
    const termOld = await this.results.forSheet(schoolId, scope, termSheet.id);
    const termComposition = await this.composer.term(
      schoolId,
      scope,
      termSheet,
      term,
      settings,
      contributors,
      { attendance: false, subjects: storedSubjects(termOld) },
    );
    if (!termComposition.rows.some((row) => row.studentId === target.studentId)) {
      throw offRoster(termSheet.id);
    }
    const termIds = await this.writeVersion(schoolId, termSheet, termOld, termComposition, {
      approver,
      now,
      toldStudentId: target.studentId,
      selfApproved,
    });
    const own = termIds.get(target.studentId);
    if (!own) throw concurrentUpdate();

    // The final sheet: the student's published final, re-composed from the new term rows.
    let finalSheetId: bigint | null = null;
    const finalRow = await this.results.livePublishedOf(schoolId, { ...target, termId: null });
    if (finalRow) {
      const finalSheet = await this.lockVersion(schoolId, scope, { ...target, termId: null }, now);
      const finalSettings = snapshotSettings(finalSheet);
      const weights = finalSheet.snapshot.termWeights;
      const year = await this.years.findById(schoolId, finalSheet.academicYearId);
      if (!finalSettings || !weights || !year) throw notFound();
      const finalComposition = await this.composer.final(
        schoolId,
        scope,
        finalSheet,
        yearTerms,
        weights,
        year,
        finalSettings,
        { remarks: [], submittedBy: null, approver },
      );
      // Nobody is told about the final again: the term message carries the correction (A15).
      const finalOld = await this.results.forSheet(schoolId, scope, finalSheet.id);
      await this.writeVersion(schoolId, finalSheet, finalOld, finalComposition, {
        approver,
        now,
        toldStudentId: null,
        selfApproved: false,
      });
      finalSheetId = finalSheet.id;
    } else {
      // A final sheet being approved or published concurrently: lock its open version (lock order
      // assessment → term sheet → final sheet) before reading its status, so the two serialise —
      // the loser re-reads (CONCURRENT_UPDATE) and finds it approved (refused) or published.
      const open = await this.sheets.findOpen(schoolId, scope, termSheet.sectionId, null);
      if (open) {
        if (!(await this.sheets.lockIfUnchanged(schoolId, scope, open))) throw concurrentUpdate();
        if (open.status === 'approved') throw versionOpen(open.id);
      }
    }

    if (own.revised) this.outbox.resultRevisedNotifyAfterCommit(schoolId, own.id);
    return {
      resultId: own.id,
      revised: own.revised,
      termSheetId: termSheet.id,
      finalSheetId,
      selfApproved,
    };
  }

  /** R281: true when the approver submitted the sheet and is the sole principal; refused otherwise. */
  private async notSubmitter(
    schoolId: SchoolId,
    sheet: ResultSheetRecord,
    approver: bigint,
  ): Promise<boolean> {
    if (sheet.submittedBy === null || sheet.submittedBy !== approver) return false;
    if (await this.permissions.isSolePrincipal(schoolId, approver)) return true;
    throw selfDecision();
  }

  /**
   * The version holding the student's live published row (term or final), under a lock that
   * moves its updated_at: a second correction racing on the same version fails its own lock,
   * re-reads, and finds the row moved to a newer version (CONCURRENT_UPDATE, retryable).
   */
  private async lockVersion(
    schoolId: SchoolId,
    scope: MarksScope,
    target: { studentId: bigint; classId: bigint; termId: bigint | null },
    now: Date,
  ): Promise<ResultSheetRecord> {
    const live = await this.results.livePublishedOf(schoolId, target);
    const sheet = live && (await this.sheets.find(schoolId, scope, live.sheetId));
    if (!live || !sheet) throw notFound();
    if ((await this.sheets.bumpPublished(schoolId, scope, sheet, now)) !== 1) throw concurrentUpdate();
    const again = await this.results.livePublishedOf(schoolId, target);
    if (again?.sheetId !== sheet.id) throw concurrentUpdate();
    return sheet;
  }

  /**
   * Version n+1 of `from` with the full row set: the composition's rows for the enrolments the
   * old version holds (the roster as approved; an enrolment the composition no longer finds keeps
   * its figures), re-ranked; attendance and the remark as stored (a correction changes marks
   * only); remark-author flags kept, the rest recomputed. `revised` where a figure changed.
   * Rows already told stay told, except the corrected student's revised row. Returns the new row
   * per student.
   */
  private async writeVersion(
    schoolId: SchoolId,
    from: ResultSheetRecord,
    old: readonly ResultRecord[],
    composition: Composition,
    opts: { approver: bigint; now: Date; toldStudentId: bigint | null; selfApproved: boolean },
  ): Promise<Map<bigint, { id: bigint; revised: boolean }>> {
    const composed = new Map(composition.rows.map((r) => [r.enrolmentId, r]));
    const merged = old.map((prev) => figuresOf(composed.get(prev.enrolmentId) ?? prev, prev));
    const ranks = positions(merged);
    const rows: NewResult[] = merged.map((row, i) => {
      const prev = old[i]!;
      const next = { ...row, position: ranks[i]?.position ?? null, positionOf: ranks[i]?.positionOf ?? null };
      const revised = changed(prev, next);
      const tellAgain = revised && prev.studentId === opts.toldStudentId;
      return {
        sheetId: 0n,
        enrolmentId: prev.enrolmentId,
        studentId: prev.studentId,
        academicYearId: prev.academicYearId,
        termId: prev.termId,
        classId: from.classId,
        totalObtained: next.totalObtained,
        totalMax: next.totalMax,
        percentBp: next.percentBp,
        grade: next.grade,
        passed: next.passed,
        failedSubjects: next.failedSubjects,
        position: next.position,
        positionOf: next.positionOf,
        attendanceBp: prev.attendanceBp,
        remark: prev.remark,
        ownChildFlags: next.ownChildFlags,
        revised,
        publishedAt: opts.now,
        supersedesId: prev.id,
        notifiedAt: tellAgain || prev.notifiedAt === null ? null : opts.now,
        subjects: next.subjects,
      };
    });
    // results_live_key: the old rows leave the live set before the new ones join it. (superseded_by
    // cannot be set afterwards: it freezes with superseded_at; the chain reads from supersedes_id.)
    await this.results.supersedeSheetRows(schoolId, from.id, opts.now);
    const version = await this.sheets.insertCorrectedVersion(schoolId, from, {
      by: opts.approver,
      at: opts.now,
      selfApproved: opts.selfApproved,
    });
    const ids = await this.results.insertSet(
      schoolId,
      version.id,
      rows.map((r) => ({ ...r, sheetId: version.id })),
    );
    const byStudent = new Map<bigint, { id: bigint; revised: boolean }>();
    for (const row of rows) {
      const id = ids.get(row.enrolmentId);
      if (id !== undefined) byStudent.set(row.studentId, { id, revised: row.revised });
    }
    return byStudent;
  }
}

type Figures = Pick<
  ComposedRow,
  | 'totalObtained'
  | 'totalMax'
  | 'percentBp'
  | 'grade'
  | 'passed'
  | 'failedSubjects'
  | 'position'
  | 'positionOf'
  | 'ownChildFlags'
  | 'subjects'
>;

/** The new figures of one row, with the old row's remark-author flags carried (the remark is unchanged). */
function figuresOf(source: Figures, prev: ResultRecord): Figures {
  const flags: OwnChildFlag[] = [...source.ownChildFlags];
  for (const flag of prev.ownChildFlags) {
    if (flag.role === 'remark_author' && !flags.some((f) => f.userId === flag.userId && f.role === flag.role))
      flags.push(flag);
  }
  return {
    totalObtained: source.totalObtained,
    totalMax: source.totalMax,
    percentBp: source.percentBp,
    grade: source.grade,
    passed: source.passed,
    failedSubjects: source.failedSubjects,
    position: source.position,
    positionOf: source.positionOf,
    ownChildFlags: flags,
    subjects: source.subjects,
  };
}

const SUBJECT_FIGURES = [
  'testBp',
  'examBp',
  'examObtained',
  'examMax',
  'examAbsent',
  'examExcused',
  'percentBp',
  'obtained',
  'max',
  'grade',
  'status',
] as const;

/** Whether a printed figure differs (R280's `revised`): the totals, the verdict, the position or a subject. */
export function changed(prev: Figures, next: Figures): boolean {
  if (
    prev.totalObtained !== next.totalObtained ||
    prev.totalMax !== next.totalMax ||
    prev.percentBp !== next.percentBp ||
    prev.grade !== next.grade ||
    prev.passed !== next.passed ||
    prev.failedSubjects !== next.failedSubjects ||
    prev.position !== next.position ||
    prev.positionOf !== next.positionOf ||
    prev.subjects.length !== next.subjects.length
  ) {
    return true;
  }
  // By class-subject, not by position: a print-order change is not a figure change.
  const after = new Map(next.subjects.map((s) => [s.classSubjectId, s]));
  return prev.subjects.some((s) => {
    const n = after.get(s.classSubjectId);
    return n === undefined || SUBJECT_FIGURES.some((key) => s[key] !== n[key]);
  });
}

/** The subjects a version's rows were composed over, with their snapshotted names and print order. */
function storedSubjects(rows: readonly ResultRecord[]): SubjectHeader[] {
  const seen = new Map<bigint, SubjectHeader>();
  for (const row of rows) {
    for (const s of row.subjects) {
      if (!seen.has(s.classSubjectId)) {
        seen.set(s.classSubjectId, {
          classSubjectId: s.classSubjectId,
          subjectName: s.subjectName,
          sortOrder: s.sortOrder,
        });
      }
    }
  }
  return [...seen.values()];
}
