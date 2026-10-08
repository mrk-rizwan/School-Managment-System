// Pieces shared by the result-sheet services (contracts/slice-31.md).
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import type { ResultSheetRecord } from '../../repositories/result-sheet.repository';
import type { OwnChildFlag } from '../../repositories/result.repository';
import type { ComposedRow, Gap } from './result-composer';
import type {
  OwnChildFlagDto,
  ResultPreviewRowDto,
  ResultSheetDto,
  ResultSheetGapDto,
} from './results.dto';

/** At most this many gaps travel in MARKS_INCOMPLETE and the detail's flags (§5.1). */
export const MAX_GAPS = 100;

const sheetDetails = (sheet: Pick<ResultSheetRecord, 'id'>) => ({ sheetId: sheet.id.toString() });

export const sheetNotDraft = (sheet: Pick<ResultSheetRecord, 'id'>): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_NOT_DRAFT,
    'The sheet is no longer a draft.',
    sheetDetails(sheet),
  );

export const sheetNotSubmitted = (sheet: Pick<ResultSheetRecord, 'id'>): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_NOT_SUBMITTED,
    'The sheet is not waiting for a decision.',
    sheetDetails(sheet),
  );

export const sheetNotApproved = (sheet: Pick<ResultSheetRecord, 'id'>): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_NOT_APPROVED,
    'Only an approved sheet can be published.',
    sheetDetails(sheet),
  );

export const sheetPublished = (sheetId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_PUBLISHED,
    'The sheet is published; a change is a correction (slice 32).',
    { sheetId: sheetId.toString() },
  );

export const termsUnpublished = (missingTermIds: readonly bigint[]): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_TERMS_UNPUBLISHED,
    'Every held term of the year must be published for the section first.',
    { missingTermIds: missingTermIds.map((id) => id.toString()) },
  );

export const marksIncomplete = (gaps: readonly Gap[]): ApiException =>
  new ApiException(
    409,
    ErrorCode.MARKS_INCOMPLETE,
    'Some students have no mark or absence entered.',
    {
      missing: gaps.slice(0, MAX_GAPS).map((g) => ({
        enrolmentId: g.enrolmentId.toString(),
        assessmentId: g.assessmentId.toString(),
      })),
    },
  );

export const examNotSetUp = (
  classSubjectId: bigint,
  sectionId: bigint,
  termId: bigint,
): ApiException =>
  new ApiException(
    409,
    ErrorCode.EXAM_NOT_SET_UP,
    'The term exam is not set up for every subject of the section.',
    {
      classSubjectId: classSubjectId.toString(),
      sectionId: sectionId.toString(),
      termId: termId.toString(),
    },
  );

export const selfDecision = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'You cannot decide a sheet you submitted.',
    {
      reason: 'submitter',
    },
  );

export function flagDtos(
  flags: readonly OwnChildFlag[],
  names: ReadonlyMap<bigint, string>,
): OwnChildFlagDto[] {
  return flags.map((f) => ({
    userId: f.userId.toString(),
    role: f.role,
    userName: names.get(f.userId) ?? '',
  }));
}

/** Distinct by user and role, in the order first seen (the sheet's summary of its rows' flags). */
export function sheetFlags(
  rows: readonly { ownChildFlags: readonly OwnChildFlag[] }[],
): OwnChildFlag[] {
  const flags: OwnChildFlag[] = [];
  for (const row of rows) {
    for (const flag of row.ownChildFlags) {
      if (!flags.some((f) => f.userId === flag.userId && f.role === flag.role)) flags.push(flag);
    }
  }
  return flags;
}

/** As an audit metadata value (no arrays): `userId:role,…`. */
export const flagsText = (flags: readonly OwnChildFlag[]): string =>
  flags.map((f) => `${f.userId}:${f.role}`).join(',');

export function toSheetDto(
  sheet: ResultSheetRecord,
  view: {
    callerUserId: bigint;
    names: ReadonlyMap<bigint, string>;
    ownChildFlags: readonly OwnChildFlag[];
  },
): ResultSheetDto {
  const name = (id: bigint | null) => (id === null ? null : (view.names.get(id) ?? ''));
  return {
    id: sheet.id.toString(),
    academicYearId: sheet.academicYearId.toString(),
    termId: sheet.termId?.toString() ?? null,
    termName: sheet.termName,
    isFinal: sheet.termId === null,
    classId: sheet.classId.toString(),
    className: sheet.className,
    sectionId: sheet.sectionId.toString(),
    sectionName: sheet.sectionName,
    version: sheet.version,
    status: sheet.status,
    submittedAt: sheet.submittedAt,
    submittedByName: name(sheet.submittedBy),
    submittedByMe: sheet.submittedBy !== null && sheet.submittedBy === view.callerUserId,
    cover: sheet.submittedUnderAssignmentId !== null,
    decidedAt: sheet.decidedAt,
    decidedByName: name(sheet.decidedBy),
    selfApproved: sheet.selfApproved,
    returnReason: sheet.returnReason,
    publishedAt: sheet.publishedAt,
    publishedByName: name(sheet.publishedBy),
    ownChildFlags: flagDtos(view.ownChildFlags, view.names),
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
  };
}

export function toPreviewRow(
  row: ComposedRow,
  missing: number,
  names: ReadonlyMap<bigint, string>,
): ResultPreviewRowDto {
  return {
    enrolmentId: row.enrolmentId.toString(),
    studentId: row.studentId.toString(),
    fullName: row.fullName,
    admissionNo: row.admissionNo,
    rollNo: row.rollNo,
    totalObtained: row.totalObtained,
    totalMax: row.totalMax,
    percentBp: row.percentBp,
    grade: row.grade,
    passed: row.passed,
    failedSubjects: row.failedSubjects,
    position: row.position,
    positionOf: row.positionOf,
    attendanceBp: row.attendanceBp,
    remark: row.remark,
    ownChildFlags: flagDtos(row.ownChildFlags, names),
    missing,
    subjects: row.subjects.map((s) => ({
      classSubjectId: s.classSubjectId.toString(),
      subjectName: s.subjectName,
      testBp: s.testBp,
      examBp: s.examBp,
      examObtained: s.examObtained,
      examMax: s.examMax,
      examAbsent: s.examAbsent,
      examExcused: s.examExcused,
      percentBp: s.percentBp,
      obtained: s.obtained,
      max: s.max,
      grade: s.grade,
      status: s.status,
      ownChildOf: s.ownChildOf?.toString() ?? null,
    })),
  };
}

export const gapDto = (gap: Gap): ResultSheetGapDto => ({
  enrolmentId: gap.enrolmentId.toString(),
  assessmentId: gap.assessmentId.toString(),
});
