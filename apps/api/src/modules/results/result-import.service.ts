import { Injectable } from '@nestjs/common';
import type { ImportStudent } from '@asms/shared';
import { notFound } from '../../common/errors/api-exception';
import {
  AcademicTermRepository,
  type AcademicTermRecord,
} from '../../repositories/academic-term.repository';
import {
  AcademicYearRepository,
  type AcademicYearRecord,
} from '../../repositories/academic-year.repository';
import { ClassSubjectRepository } from '../../repositories/class-subject.repository';
import { ClassRepository, type ClassRecord } from '../../repositories/class.repository';
import { MarkReadsRepository } from '../../repositories/mark-reads.repository';
import { ResultSheetRepository } from '../../repositories/result-sheet.repository';
import { ResultRepository } from '../../repositories/result.repository';
import { SectionRepository, type SectionRecord } from '../../repositories/section.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import { ClassRankingService } from './class-ranking.service';
import { newResultOf, ResultComposer } from './result-composer';
import { ResultSheetsService } from './result-sheets.service';

// Phase 5 slice 43 (contracts/slice-43.md §3; rule 39, §0.34, R339, R340, R343): the results
// module's half of a past-results import — what a preview validates against (the section's
// roster on the term's last day, the class's subjects with each exam's max) and, at commit, the
// imported sheet: born published with provenance `imported`, its results composed by the shared
// functions from the exam marks alone (exam weight 100 %, the snapshot says so), no message.

/** A class subject as the file names it, with the max its exam takes or already has. */
export interface ImportSubject {
  classSubjectId: bigint;
  subjectId: bigint;
  name: string;
  sortOrder: number;
  /** The section-term's live exam's max, else the class-subject's exam max. */
  examMaxMarks: number;
}

/** What a past-results file is validated and committed against. */
export interface PastResultsTarget {
  section: SectionRecord;
  klass: ClassRecord;
  year: AcademicYearRecord;
  term: AcademicTermRecord;
  /** Whether the term is held for the class (A6). */
  held: boolean;
  subjects: ImportSubject[];
  /** The section's enrolments in force on the term's last day. */
  roster: ImportStudent[];
  /** Any sheet of the section-term, any status (IMPORT_SHEET_EXISTS). */
  sheetExists: boolean;
  /** Any live mark of the section-term or the roster in the class-term (IMPORT_MARKS_EXIST). */
  marksExist: boolean;
}

@Injectable()
export class ResultImportService {
  constructor(
    private readonly sheetsService: ResultSheetsService,
    private readonly sheets: ResultSheetRepository,
    private readonly results: ResultRepository,
    private readonly reads: MarkReadsRepository,
    private readonly composer: ResultComposer,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly terms: AcademicTermRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly ranking: ClassRankingService,
  ) {}

  /** The section and term as a past-results file sees them; 404 when either is not the school's or they differ in year. */
  async target(
    schoolId: SchoolId,
    scope: MarksScope,
    sectionId: bigint,
    termId: bigint,
  ): Promise<PastResultsTarget> {
    const section = await this.sections.findById(schoolId, sectionId);
    const klass = section && (await this.classes.findById(schoolId, section.classId));
    const year = klass && (await this.years.findById(schoolId, klass.academicYearId));
    const term = await this.terms.findById(schoolId, termId);
    if (!section || !klass || !year || !term || term.academicYearId !== year.id) throw notFound();
    const listed = await this.classSubjects.liveForClass(schoolId, klass.id);
    const { roster } = await this.reads.enrolmentsForSheet(schoolId, scope, {
      classId: klass.id,
      sectionId,
      on: term.endsOn,
    });
    const studentIds = roster.map((r) => r.studentId);
    const exams = (
      await this.reads.termAssessmentsWithMarks(schoolId, scope, {
        classId: klass.id,
        sectionId,
        termId,
        studentIds: [],
      })
    ).filter((a) => a.kind === 'exam' && a.sectionId === sectionId);
    return {
      section,
      klass,
      year,
      term,
      held: !term.skips.some((skip) => skip.classId === klass.id),
      subjects: [...listed]
        .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
        .map((cs) => ({
          classSubjectId: cs.id,
          subjectId: cs.subjectId,
          name: cs.subjectName,
          sortOrder: cs.sortOrder,
          examMaxMarks: exams.find((e) => e.classSubjectId === cs.id)?.maxMarks ?? cs.examMaxMarks,
        })),
      roster: roster.map((r) => ({
        admissionNo: r.admissionNo,
        studentId: r.studentId.toString(),
        enrolmentId: r.enrolmentId.toString(),
      })),
      sheetExists: await this.sheets.existsForSectionTerm(schoolId, sectionId, termId),
      marksExist: await this.reads.liveMarkExists(schoolId, scope, {
        classId: klass.id,
        sectionId,
        termId,
        studentIds,
      }),
    };
  }

  /** The sheet a committed past-results import made, if any. */
  sheetIdOf(schoolId: SchoolId, importId: bigint): Promise<bigint | null> {
    return this.sheets.idOfImport(schoolId, importId);
  }

  /**
   * R340: the imported sheet, after the import's exams and marks are written (the caller's
   * transaction). The year's live pass mark, rule and bands with exam weight 100 % are the
   * snapshot; the shared composition over the section-term's live marks gives the results, born
   * published and already told (`notified_at` set, so result-notify and its sweep send nothing);
   * then the class ranking (trigger `import`) when the class-term is complete.
   */
  async importSheet(
    schoolId: SchoolId,
    scope: MarksScope,
    input: { target: PastResultsTarget; importId: bigint; importedBy: bigint; at: Date },
  ): Promise<{ sheetId: bigint; results: number; rankingId: bigint | null }> {
    const { target, at } = input;
    const live = await this.sheetsService.liveSettings(schoolId, target.year.id);
    const settings = { ...live, testWeight: 0, examWeight: 100 };
    const sheet = await this.sheets.createImported(schoolId, {
      academicYearId: target.year.id,
      termId: target.term.id,
      classId: target.klass.id,
      sectionId: target.section.id,
      importId: input.importId,
      importedBy: input.importedBy,
      at,
      snapshot: {
        testWeight: 0,
        examWeight: 100,
        passPercent: live.passPercent,
        passRule: live.passRule,
        bands: [...live.bands],
      },
    });
    const composition = await this.composer.term(schoolId, scope, sheet, target.term, settings, {
      remarks: [],
      submittedBy: null,
      approver: input.importedBy,
    });
    await this.results.insertSet(
      schoolId,
      sheet.id,
      composition.rows.map((row) => ({ ...newResultOf(sheet, row), publishedAt: at, notifiedAt: at })),
    );
    // R333, R343: the class ranking after an import, when every section of the class-term is in.
    const rankingId = await this.ranking.recompute(schoolId, target.klass.id, target.term.id, 'import', input.importedBy);
    return { sheetId: sheet.id, results: composition.rows.length, rankingId };
  }
}
