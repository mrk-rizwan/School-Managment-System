import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import {
  ADMISSION_NO_COLUMN,
  Capability,
  ErrorCode,
  IMPORT_ERRORS_SHOWN,
  headerKey,
  parseOpeningBalances,
  parsePastResults,
  readCsv,
  type CsvReadProblem,
  type ImportKind,
  type ImportRowError,
  type ImportRowErrorCode,
} from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  IMPORT_EXPIRED_ERROR,
  IMPORT_PREVIEW_TTL_MS,
  ImportRepository,
  type ImportRecord,
  type ImportSummary,
} from '../../repositories/import.repository';
import type { MarksScope } from '../../tenancy/scope';
import { classArchived, fromDateString, toDateString } from '../academics/academics.shared';
import { defaultPasswordActionBlocks } from '../access/access.errors';
import { isPrincipal, principalRequired } from '../access/money-gates';
import { PermissionsService } from '../access/permissions.service';
import { AssessmentsService } from '../assessments/assessments.service';
import { ChargesService } from '../fees/charges.service';
import { ResultImportService, type PastResultsTarget } from '../results/result-import.service';
import type { ImportFile } from './import-upload';
import {
  IMPORT_ROW_ERROR_CODES,
  type ImportDetailDto,
  type ImportDto,
  type ImportRowDto,
  type ListImportsQueryDto,
  type OpeningBalancesImportDto,
  type PastResultsImportDto,
} from './imports.dto';

// Phase 5 slice 43 (contracts/slice-43.md; rule 39, §0.34, R339-R343): commencement imports. A
// preview parses the CSV with the shared parsers, validates every row and writes the `imports`
// row only (rows ≤ 5,000, row errors ≤ 100 with the full count; no cell text of a refused row and
// never an identity number). A commit, keyed, is one transaction: the children are written while
// the import is still previewed (the triggers insist), then it is stamped committed. A past-results
// file becomes the section-term's exams, marks and a sheet born published with provenance
// `imported` and no message; an opening-balances file becomes one manual charge per row under the
// seeded head. A preview expires after 24 hours (the staged-upload sweep, or the commit itself).

const ENDPOINT = 'imports';
const SUBJECT = 'import';

/** Stored rows (the `imports.rows` JSON): ids as strings, never a refused cell. */
interface StoredPastRow {
  row: number;
  admissionNo: string;
  studentId: string;
  enrolmentId: string;
  /** classSubjectId → obtained, null for "Ab". */
  marks: Record<string, number | null>;
}
interface StoredBalanceRow {
  row: number;
  admissionNo: string;
  studentId: string;
  enrolmentId: string;
  amount: number;
  note: string | null;
  /** The child's advance in the year at preview. */
  advance: number;
}

const importError = (status: number, code: ErrorCode, message: string, importId: bigint | null, extra: object = {}) =>
  new ApiException(status, code, message, { importId: importId?.toString() ?? null, ...extra });

const yearClosed = (importId: bigint | null) =>
  importError(409, ErrorCode.IMPORT_YEAR_CLOSED, 'Imports go into an open academic year.', importId);
const sheetExists = (importId: bigint | null) =>
  importError(409, ErrorCode.IMPORT_SHEET_EXISTS, 'This section already has a result sheet for the term.', importId);
const marksExist = (importId: bigint | null) =>
  importError(409, ErrorCode.IMPORT_MARKS_EXIST, 'Marks have already been entered for this section and term.', importId);
const duplicateFile = (committedId: bigint) =>
  importError(409, ErrorCode.IMPORT_DUPLICATE_FILE, 'This file has already been imported.', committedId);
const notPreviewed = (importId: bigint) =>
  importError(409, ErrorCode.IMPORT_NOT_PREVIEWED, 'The import is no longer awaiting commit.', importId);
const expired = (importId: bigint) =>
  importError(409, ErrorCode.IMPORT_EXPIRED, 'The preview has expired; upload the file again.', importId);
const changedSincePreview = (importId: bigint) =>
  importError(409, ErrorCode.STALE_STATUS, 'The class or its students changed since the preview; upload the file again.', importId);

const CSV_PROBLEMS: Readonly<Record<CsvReadProblem, string>> = {
  too_large: 'The file is larger than 2 MB',
  not_utf8: 'The file is not UTF-8 text; save it as "CSV UTF-8"',
  empty: 'The file is empty',
  unterminated_quote: 'A quoted cell is not closed',
  too_many_rows: 'The file has more than 5,000 rows',
  too_many_columns: 'The file has more than 64 columns',
  cell_too_long: 'A cell is longer than 64 characters',
  ragged_row: 'A row has a different number of cells from the header',
};

const csvUnreadable = (problem: CsvReadProblem, line: number | null) =>
  fieldRefused('file', ErrorCode.INVALID_VALUE, line === null ? CSV_PROBLEMS[problem] : `${CSV_PROBLEMS[problem]} (line ${line})`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const whole = (value: unknown): number => (typeof value === 'number' ? value : 0);
const objects = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The stored rows of a past-results import, read back field by field (the JSON is ours). */
function pastRows(record: Pick<ImportRecord, 'rows'>): StoredPastRow[] {
  return objects(record.rows).map((r) => ({
    row: whole(r.row),
    admissionNo: text(r.admissionNo),
    studentId: text(r.studentId),
    enrolmentId: text(r.enrolmentId),
    marks: Object.fromEntries(
      Object.entries(isRecord(r.marks) ? r.marks : {}).map(([id, obtained]) => [id, typeof obtained === 'number' ? obtained : null]),
    ),
  }));
}

/** The stored rows of an opening-balances import. */
function balanceRows(record: Pick<ImportRecord, 'rows'>): StoredBalanceRow[] {
  return objects(record.rows).map((r) => ({
    row: whole(r.row),
    admissionNo: text(r.admissionNo),
    studentId: text(r.studentId),
    enrolmentId: text(r.enrolmentId),
    amount: whole(r.amount),
    note: typeof r.note === 'string' ? r.note : null,
    advance: whole(r.advance),
  }));
}

const ERROR_CODES: ReadonlySet<unknown> = new Set(IMPORT_ROW_ERROR_CODES);
const isErrorCode = (value: unknown): value is ImportRowErrorCode => ERROR_CODES.has(value);

function storedErrors(record: Pick<ImportRecord, 'errors'>): ImportRowError[] {
  return objects(record.errors).flatMap((e) =>
    isErrorCode(e.code)
      ? [{ row: whole(e.row), field: text(e.field), code: e.code, ...(typeof e.admissionNo === 'string' ? { admissionNo: e.admissionNo } : {}) }]
      : [],
  );
}

export interface ImportOutcome {
  replayed: boolean;
  import: ImportDetailDto;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly imports: ImportRepository,
    private readonly years: AcademicYearRepository,
    private readonly results: ResultImportService,
    private readonly assessments: AssessmentsService,
    private readonly charges: ChargesService,
    private readonly permissions: PermissionsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------- who may

  /** The kinds the caller may import (and read): §3.1's two key pairs. */
  private kindsOf(session: SchoolSessionContext): ImportKind[] {
    const holds = (key: Capability) => this.permissions.holds(session.access, key);
    return [
      ...(holds(Capability.RESULT_PUBLISH) && holds(Capability.ASSESSMENT_DEFINE) ? (['past_results'] as const) : []),
      ...(holds(Capability.CHARGE_CREATE) && isPrincipal(session) ? (['opening_balances'] as const) : []),
    ];
  }

  private requireKind(session: SchoolSessionContext, kind: ImportKind): void {
    if (this.kindsOf(session).includes(kind)) return;
    if (kind === 'opening_balances') throw principalRequired();
    throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.', {
      reason: 'assessment_define_required',
    });
  }

  /** The school-wide marks scope a past-results import writes under (R340). */
  private async importScope(session: SchoolSessionContext, on: Date): Promise<MarksScope<'write'>> {
    const scope = await this.permissions.marksImportScopeOf(session, on);
    if (scope?.kind !== 'all') {
      throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.', {
        reason: 'school_wide_required',
      });
    }
    return scope;
  }

  // ------------------------------------------------------------------------------- preview

  /** R339: POST /imports/past-results. Keyed (endpoint imports, no path id; the file's hash is in the request hash). */
  async previewPastResults(
    session: SchoolSessionContext,
    dto: PastResultsImportDto,
    file: ImportFile,
    rawKey: string | undefined,
  ): Promise<ImportOutcome> {
    this.requireKind(session, 'past_results');
    return this.keyed(session, rawKey, 0n, { kind: 'past_results', ...dto, file: hashOf(file.bytes) }, (actor, claim) =>
      this.previewPastResultsTx(session, actor, claim, dto, file),
    );
  }

  /** R339: POST /imports/opening-balances (a principal holding charge.create; rule-24 inert on the route). */
  async previewOpeningBalances(
    session: SchoolSessionContext,
    dto: OpeningBalancesImportDto,
    file: ImportFile,
    rawKey: string | undefined,
  ): Promise<ImportOutcome> {
    this.requireKind(session, 'opening_balances');
    return this.keyed(session, rawKey, 0n, { kind: 'opening_balances', ...dto, file: hashOf(file.bytes) }, (actor, claim) =>
      this.previewOpeningBalancesTx(actor, claim, dto, file),
    );
  }

  private async keyed(
    session: SchoolSessionContext,
    rawKey: string | undefined,
    pathId: bigint,
    body: object,
    run: (actor: Actor, claim: IdempotencyClaim) => Promise<bigint>,
  ): Promise<ImportOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, pathId, body, rawKey, (claim) =>
      run(actor, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, import: await this.detailOf(session, id) };
  }

  @Transactional()
  private async previewPastResultsTx(
    session: SchoolSessionContext,
    actor: Actor,
    claim: IdempotencyClaim,
    dto: PastResultsImportDto,
    file: ImportFile,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const scope = await this.importScope(session, await this.clock.today(schoolId));
    const target = await this.results.target(schoolId, scope, BigInt(dto.sectionId), BigInt(dto.termId));
    this.assertImportable(target, null);
    const fileHash = hashOf(file.bytes);
    await this.refuseCommitted(schoolId, 'past_results', fileHash);
    const csv = this.readable(file.bytes);
    const parse = parsePastResults(file.bytes, {
      subjects: target.subjects.map((s) => ({
        classSubjectId: s.classSubjectId.toString(),
        name: s.name,
        examMaxMarks: s.examMaxMarks,
      })),
      roster: target.roster,
      knownAdmissionNos: await this.imports.knownAdmissionNos(schoolId, admissionCells(csv)),
    });
    if (!parse.ok) throw csvUnreadable(parse.problem, parse.line);
    const rows: StoredPastRow[] = parse.rows.map((r) => ({
      row: r.row,
      admissionNo: r.admissionNo,
      studentId: r.studentId,
      enrolmentId: r.enrolmentId,
      marks: Object.fromEntries(r.marks.map((m) => [m.classSubjectId, m.obtained])),
    }));
    const created = await this.imports.create(schoolId, {
      kind: 'past_results',
      fileHash,
      fileName: file.fileName,
      rowCount: csv.rows.length,
      rows: rows.map((r) => ({ ...r })),
      errors: parse.errors.slice(0, IMPORT_ERRORS_SHOWN),
      errorCount: parse.errors.length,
      academicYearId: target.year.id,
      sectionId: target.section.id,
      classId: target.klass.id,
      termId: target.term.id,
      dueOn: null,
      createdBy: userId,
    });
    await this.recordPreviewed(actor, created);
    await recordSubject(created.id);
    return created.id;
  }

  @Transactional()
  private async previewOpeningBalancesTx(
    actor: Actor,
    claim: IdempotencyClaim,
    dto: OpeningBalancesImportDto,
    file: ImportFile,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const year = await this.years.findById(schoolId, BigInt(dto.academicYearId));
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw yearClosed(null);
    const dueOn = fromDateString(dto.dueOn);
    if (dueOn < (await this.clock.today(schoolId))) {
      throw fieldRefused('dueOn', ErrorCode.INVALID_VALUE, 'dueOn must be today or later');
    }
    // The head must be usable now, not only at commit.
    await this.charges.openingBalanceHead(schoolId);
    const fileHash = hashOf(file.bytes);
    await this.refuseCommitted(schoolId, 'opening_balances', fileHash);
    const csv = this.readable(file.bytes);
    const parse = parseOpeningBalances(file.bytes, {
      roster: await this.imports.openingBalanceRoster(schoolId, year.id),
      knownAdmissionNos: await this.imports.knownAdmissionNos(schoolId, admissionCells(csv)),
    });
    if (!parse.ok) throw csvUnreadable(parse.problem, parse.line);
    const advances = await this.charges.openingBalanceAdvances(
      schoolId,
      year.id,
      parse.rows.map((r) => BigInt(r.studentId)),
    );
    const rows: StoredBalanceRow[] = parse.rows.map((r) => ({
      row: r.row,
      admissionNo: r.admissionNo,
      studentId: r.studentId,
      enrolmentId: r.enrolmentId,
      amount: r.amount,
      note: r.note,
      advance: Math.min(advances.get(BigInt(r.studentId)) ?? 0, r.amount),
    }));
    const created = await this.imports.create(schoolId, {
      kind: 'opening_balances',
      fileHash,
      fileName: file.fileName,
      rowCount: csv.rows.length,
      rows: rows.map((r) => ({ ...r })),
      errors: parse.errors.slice(0, IMPORT_ERRORS_SHOWN),
      errorCount: parse.errors.length,
      academicYearId: year.id,
      sectionId: null,
      classId: null,
      termId: null,
      dueOn,
      createdBy: userId,
    });
    await this.recordPreviewed(actor, created);
    await recordSubject(created.id);
    return created.id;
  }

  /** The file as CSV, or 422 on `file` saying why it cannot be read (nothing is written). */
  private readable(bytes: Buffer) {
    const csv = readCsv(bytes);
    if (!csv.ok) throw csvUnreadable(csv.problem, csv.line);
    return csv;
  }

  private async refuseCommitted(schoolId: Actor['schoolId'], kind: ImportKind, fileHash: string): Promise<void> {
    const committed = await this.imports.committedWithHash(schoolId, kind, fileHash);
    if (committed !== null) throw duplicateFile(committed);
  }

  /** R340's refusals and the section-term's own state, at preview and again at commit. */
  private assertImportable(target: PastResultsTarget, importId: bigint | null): void {
    if (target.year.status === 'closed') throw yearClosed(importId);
    if (target.section.deletedAt !== null) {
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'This section is archived.');
    }
    if (target.klass.status === 'archived') throw classArchived();
    if (!target.held) throw fieldRefused('termId', ErrorCode.INVALID_VALUE, 'This term is not held for the class');
    if (target.subjects.length === 0) {
      throw fieldRefused('sectionId', ErrorCode.INVALID_VALUE, 'The class has no subjects for the year');
    }
    if (target.sheetExists) throw sheetExists(importId);
    if (target.marksExist) throw marksExist(importId);
  }

  private async recordPreviewed(actor: Actor, row: ImportRecord): Promise<void> {
    await this.audit.record(actor.schoolId, {
      actorUserId: actor.userId,
      action: 'import.previewed',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: {
        kind: row.kind,
        rowCount: row.rowCount,
        errorCount: row.errorCount,
        academicYearId: row.academicYearId.toString(),
        sectionId: row.sectionId?.toString() ?? null,
        termId: row.termId?.toString() ?? null,
        dueOn: row.dueOn === null ? null : toDateString(row.dueOn),
      },
    });
  }

  // -------------------------------------------------------------------------------- commit

  /**
   * R340-R342: POST /imports/:id/commit, keyed (path id the import). An expired preview is failed
   * "expired" first, in its own transaction, and answered IMPORT_EXPIRED.
   */
  async commit(session: SchoolSessionContext, id: bigint, rawKey: string | undefined): Promise<ImportOutcome> {
    const { schoolId } = session;
    const found = await this.visible(session, id);
    this.requireKind(session, found.kind);
    // Rule 24's reach (R355) covers the commit too: the preview route is marked, and a colleague
    // on a default password must not commit someone else's opening-balances preview.
    if (found.kind === 'opening_balances' && session.access.passwordIsDefault) throw defaultPasswordActionBlocks();
    if (found.status === 'previewed' && this.isExpired(found)) {
      await this.expireOne(found);
      throw expired(id);
    }
    return this.keyed(session, rawKey, id, {}, (actor, claim) => this.commitTx(session, actor, claim, id)).catch(
      async (error: unknown) => {
        // A commit refused for an expired preview (it lapsed while queued) leaves nothing behind.
        const now = await this.imports.find(schoolId, id);
        if (now?.status === 'previewed' && this.isExpired(now)) await this.expireOne(now);
        throw error;
      },
    );
  }

  private isExpired(row: Pick<ImportRecord, 'createdAt'>): boolean {
    return row.createdAt.getTime() + IMPORT_PREVIEW_TTL_MS <= this.clock.now().getTime();
  }

  @Transactional()
  private async expireOne(row: Pick<ImportRecord, 'id' | 'createdAt' | 'kind'>): Promise<void> {
    const { schoolId, userId } = this.context.actor();
    const now = this.clock.now();
    const ids = await this.imports.expire(schoolId, new Date(now.getTime() - IMPORT_PREVIEW_TTL_MS + 1), now, row.id);
    if (ids.length === 0) return;
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'import.failed',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { kind: row.kind, reason: IMPORT_EXPIRED_ERROR },
    });
  }

  @Transactional()
  private async commitTx(
    session: SchoolSessionContext,
    actor: Actor,
    claim: IdempotencyClaim,
    id: bigint,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    if (!(await this.imports.lockPreviewed(schoolId, id))) {
      const row = await this.imports.find(schoolId, id);
      if (!row) throw notFound();
      throw row.status === 'failed' && row.error === IMPORT_EXPIRED_ERROR ? expired(id) : notPreviewed(id);
    }
    const row = await this.imports.find(schoolId, id);
    if (!row) throw notFound();
    if (this.isExpired(row)) throw expired(id);
    if (row.errorCount > 0) {
      throw new ApiException(422, ErrorCode.IMPORT_ROWS_INVALID, 'The file has row errors; correct them and upload it again.', {
        importId: id.toString(),
        rows: storedErrors(row).map((e) => ({ row: e.row, field: e.field, code: e.code })),
        errorCount: row.errorCount,
      });
    }
    await this.refuseCommitted(schoolId, row.kind, row.fileHash);
    const now = this.clock.now();
    const metadata =
      row.kind === 'past_results'
        ? await this.commitPastResults(session, actor, row, now)
        : await this.commitOpeningBalances(actor, row);
    if ((await this.imports.markCommitted(schoolId, id, userId, now)) !== 1) throw notPreviewed(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'import.committed',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { kind: row.kind, rows: Array.isArray(row.rows) ? row.rows.length : 0, ...metadata },
    });
    await recordSubject(id);
    return id;
  }

  /** R340: exams if missing, marks, the imported sheet and its results; no message. */
  private async commitPastResults(
    session: SchoolSessionContext,
    actor: Actor,
    row: ImportRecord,
    now: Date,
  ): Promise<Record<string, string | number>> {
    const { schoolId, userId } = actor;
    if (row.sectionId === null || row.termId === null) throw notFound();
    const scope = await this.importScope(session, await this.clock.today(schoolId));
    const target = await this.results.target(schoolId, scope, row.sectionId, row.termId);
    this.assertImportable(target, row.id);
    const rows = pastRows(row);
    // The roster and the subjects must be those the preview validated against.
    const roster = new Map(target.roster.map((s) => [s.enrolmentId, s]));
    const maxOf = new Map(target.subjects.map((s) => [s.classSubjectId.toString(), s.examMaxMarks]));
    const sameRoster =
      rows.length === target.roster.length &&
      rows.every((r) => roster.get(r.enrolmentId)?.studentId === r.studentId);
    const sameSubjects = rows.every(
      (r) =>
        Object.keys(r.marks).length === maxOf.size &&
        Object.entries(r.marks).every(([csId, obtained]) => {
          const max = maxOf.get(csId);
          return max !== undefined && (obtained === null || obtained <= max);
        }),
    );
    if (!sameRoster || !sameSubjects) throw changedSincePreview(row.id);
    const marks = await this.assessments.importExamMarks(schoolId, scope, {
      academicYearId: target.year.id,
      termId: target.term.id,
      termName: target.term.name,
      classId: target.klass.id,
      sectionId: target.section.id,
      heldOn: target.term.endsOn,
      enteredBy: userId,
      subjects: target.subjects.map((s) => ({
        classSubjectId: s.classSubjectId,
        subjectId: s.subjectId,
        maxMarks: s.examMaxMarks,
      })),
      rows: rows.map((r) => ({
        enrolmentId: BigInt(r.enrolmentId),
        studentId: BigInt(r.studentId),
        marks: Object.entries(r.marks).map(([csId, obtained]) => ({ classSubjectId: BigInt(csId), obtained })),
      })),
    });
    const sheet = await this.results.importSheet(schoolId, scope, {
      target,
      importId: row.id,
      importedBy: userId,
      at: now,
    });
    return {
      sheetId: sheet.sheetId.toString(),
      rankingId: sheet.rankingId?.toString() ?? 'none',
      results: sheet.results,
      examsCreated: marks.examsCreated,
      marks: marks.marks,
    };
  }

  /** R342: one manual charge per row under the seeded head; an existing advance applies. */
  private async commitOpeningBalances(actor: Actor, row: ImportRecord): Promise<Record<string, string | number>> {
    const { schoolId, userId } = actor;
    if (row.dueOn === null) throw notFound();
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed(row.id);
    if (row.dueOn < (await this.clock.today(schoolId))) {
      throw fieldRefused('dueOn', ErrorCode.INVALID_VALUE, 'The due date has passed; upload the file again with a new date');
    }
    const rows = balanceRows(row);
    const roster = new Map((await this.imports.openingBalanceRoster(schoolId, year.id)).map((s) => [s.enrolmentId, s]));
    if (!rows.every((r) => roster.get(r.enrolmentId)?.studentId === r.studentId)) throw changedSincePreview(row.id);
    const written = await this.charges.createOpeningBalances(schoolId, {
      importId: row.id,
      academicYearId: year.id,
      dueOn: row.dueOn,
      createdBy: userId,
      rows: rows.map((r) => ({
        enrolmentId: BigInt(r.enrolmentId),
        studentId: BigInt(r.studentId),
        amount: r.amount,
        note: r.note,
      })),
    });
    return { charges: written.charges, amount: written.amount, advanceApplied: written.advanceApplied };
  }

  // --------------------------------------------------------------------------------- reads

  /** GET /imports: the kinds the caller may import, newest first. */
  async list(session: SchoolSessionContext, query: ListImportsQueryDto): Promise<Page<ImportDto>> {
    const kinds = this.kindsOf(session);
    if (query.kind !== undefined && !kinds.includes(query.kind)) return toPage([], query, 0);
    if (kinds.length === 0) return toPage([], query, 0);
    const kind = query.kind ?? (kinds.length === 1 ? kinds[0] : undefined);
    const { rows, total } = await this.imports.list(
      session.schoolId,
      { ...(kind === undefined ? {} : { kind }), ...(query.status === undefined ? {} : { status: query.status }) },
      { skip: (query.page - 1) * query.limit, take: query.limit },
    );
    const names = await this.imports.names(
      session.schoolId,
      rows.flatMap((r) => [r.createdBy, ...(r.committedBy === null ? [] : [r.committedBy])]),
    );
    return toPage(
      rows.map((r) => this.toDto(r, names)),
      query,
      total,
    );
  }

  /** GET /imports/:id: 404 for another school's import or a kind the caller may not import. */
  async get(session: SchoolSessionContext, id: bigint): Promise<ImportDetailDto> {
    await this.visible(session, id);
    return this.detailOf(session, id);
  }

  private async visible(session: SchoolSessionContext, id: bigint): Promise<ImportRecord> {
    const row = await this.imports.find(session.schoolId, id);
    if (!row || !this.kindsOf(session).includes(row.kind)) throw notFound();
    return row;
  }

  private async detailOf(session: SchoolSessionContext, id: bigint): Promise<ImportDetailDto> {
    const { schoolId } = session;
    const row = await this.imports.find(schoolId, id);
    if (!row) throw notFound();
    const names = await this.imports.names(schoolId, [row.createdBy, ...(row.committedBy === null ? [] : [row.committedBy])]);
    const base = this.toDto(row, names);
    if (row.kind === 'past_results') {
      const stored = pastRows(row);
      const students = await this.imports.studentNames(schoolId, stored.map((r) => BigInt(r.studentId)));
      const subjects = await this.subjectsOf(session, row);
      return {
        ...base,
        subjects: subjects.map((s) => ({ classSubjectId: s.classSubjectId.toString(), name: s.name, maxMarks: s.examMaxMarks })),
        rows: stored.map(
          (r): ImportRowDto => ({
            row: r.row,
            studentId: r.studentId,
            admissionNo: r.admissionNo,
            studentName: students.get(BigInt(r.studentId))?.fullName ?? '',
            marks: subjects.map((s) => ({
              classSubjectId: s.classSubjectId.toString(),
              obtained: r.marks[s.classSubjectId.toString()] ?? null,
            })),
            amount: null,
            note: null,
            advance: null,
          }),
        ),
        totalAmount: null,
        totalAdvance: null,
        resultSheetId:
          row.status === 'committed' ? ((await this.results.sheetIdOf(schoolId, row.id))?.toString() ?? null) : null,
      };
    }
    const stored = balanceRows(row);
    const students = await this.imports.studentNames(schoolId, stored.map((r) => BigInt(r.studentId)));
    return {
      ...base,
      subjects: [],
      rows: stored.map(
        (r): ImportRowDto => ({
          row: r.row,
          studentId: r.studentId,
          admissionNo: r.admissionNo,
          studentName: students.get(BigInt(r.studentId))?.fullName ?? '',
          marks: null,
          amount: r.amount,
          note: r.note,
          advance: r.advance,
        }),
      ),
      totalAmount: stored.reduce((sum, r) => sum + r.amount, 0),
      totalAdvance: stored.reduce((sum, r) => sum + r.advance, 0),
      resultSheetId: null,
    };
  }

  /** A past-results import's columns: the class's live subjects with each exam's max. */
  private async subjectsOf(session: SchoolSessionContext, row: ImportRecord) {
    if (row.sectionId === null || row.termId === null) return [];
    const scope = await this.permissions.marksImportScopeOf(session, await this.clock.today(session.schoolId));
    if (scope === null) return [];
    return (await this.results.target(session.schoolId, scope, row.sectionId, row.termId)).subjects;
  }

  private toDto(row: ImportSummary, names: ReadonlyMap<bigint, string>): ImportDto {
    return {
      id: row.id.toString(),
      kind: row.kind,
      status: row.status,
      fileName: row.fileName,
      rowCount: row.rowCount,
      academicYearId: row.academicYearId.toString(),
      academicYearName: row.academicYear.name,
      classId: row.classId?.toString() ?? null,
      className: row.class?.name ?? null,
      sectionId: row.sectionId?.toString() ?? null,
      sectionName: row.section?.name ?? null,
      termId: row.termId?.toString() ?? null,
      termName: row.term?.name ?? null,
      dueOn: row.dueOn === null ? null : toDateString(row.dueOn),
      createdByName: names.get(row.createdBy) ?? '',
      createdAt: row.createdAt,
      expiresAt: new Date(row.createdAt.getTime() + IMPORT_PREVIEW_TTL_MS),
      committedByName: row.committedBy === null ? null : (names.get(row.committedBy) ?? ''),
      committedAt: row.committedAt,
      failedAt: row.failedAt,
      error: row.error,
      errorCount: row.errorCount,
      errors: storedErrors(row).map((e) => ({
        row: e.row,
        field: e.field,
        code: e.code,
        ...(e.admissionNo === undefined ? {} : { admissionNo: e.admissionNo }),
      })),
    };
  }
}

/** The cells of the admission-number column (the header named it, else the first column). */
function admissionCells(csv: { header: readonly string[]; rows: readonly { cells: readonly string[] }[] }): string[] {
  const at = csv.header.map(headerKey).indexOf(ADMISSION_NO_COLUMN);
  const index = at < 0 ? 0 : at;
  return csv.rows.map((r) => r.cells[index] ?? '');
}

/** Lower-case sha-256 hex of the uploaded bytes (R341's committed-file key). */
function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
