// Pieces shared by the assessment and marks services (contracts/slice-30.md).
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import type { AssessmentRecord, ScopeDates } from '../../repositories/assessment.repository';
import type { MarkRecord } from '../../repositories/mark.repository';
import { toDateString } from '../academics/academics.shared';
import type { AssessmentDto, AssessmentMarkDto } from './assessments.dto';

const idOrNull = (id: bigint | null): string | null => (id === null ? null : id.toString());

export const assessmentLocked = (id: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.ASSESSMENT_LOCKED,
    'This assessment is locked: its result sheet has been submitted.',
    {
      assessmentId: id.toString(),
    },
  );

export const assessmentVoided = (id: bigint): ApiException =>
  new ApiException(409, ErrorCode.ASSESSMENT_VOIDED, 'This assessment has been voided.', {
    assessmentId: id.toString(),
  });

export const assessmentHasMarks = (id: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.ASSESSMENT_HAS_MARKS,
    'Marks have been entered: the name, date and maximum marks can no longer change.',
    { assessmentId: id.toString() },
  );

/** A date outside every term of the year (create), or outside the assessment's term (edit). */
export const assessmentOutsideTerm = (id: bigint | null): ApiException =>
  new ApiException(
    409,
    ErrorCode.ASSESSMENT_OUTSIDE_TERM,
    id === null
      ? 'The date is not inside a term of the academic year.'
      : 'The date must stay inside the assessment’s term.',
    { assessmentId: idOrNull(id) },
  );

/**
 * The date a marks scope is minted for (§0.27, slice 36): an exam's marks are entered after the
 * exam by whoever teaches the subject then, so an exam's scope is the day of entry (`today`, school
 * time) while it lies inside the exam's term, else its held_on; a test's is always its held_on.
 */
export const marksDateOf = (dates: ScopeDates, today: Date): Date =>
  dates.kind === 'exam' && dates.termStartsOn <= today && today <= dates.termEndsOn
    ? today
    : dates.heldOn;

export const subjectNotAssigned = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.SUBJECT_NOT_ASSIGNED,
    'You do not teach this subject in this section on that date.',
  );

export interface AssessmentView {
  createdByMe: boolean;
  markedCount: number;
  canEnterMarks: boolean;
  /** lockedAt set, or the section-term sheet submitted or later (R265). */
  locked: boolean;
}

export const resultSheetNotDraft = (sheetId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.RESULT_SHEET_NOT_DRAFT,
    'The section’s result sheet for this term has been submitted: no new test can be added.',
    { sheetId: sheetId.toString() },
  );

export function toAssessmentDto(row: AssessmentRecord, view: AssessmentView): AssessmentDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    termId: row.termId.toString(),
    termName: row.termName,
    classId: row.classId.toString(),
    className: row.className,
    sectionId: row.sectionId.toString(),
    sectionName: row.sectionName,
    classSubjectId: row.classSubjectId.toString(),
    subjectId: row.subjectId.toString(),
    subjectName: row.subjectName,
    kind: row.kind,
    testType: row.testType,
    name: row.name,
    maxMarks: row.maxMarks,
    heldOn: toDateString(row.heldOn),
    createdByMe: view.createdByMe,
    markedCount: view.markedCount,
    canEnterMarks: view.canEnterMarks,
    lockedAt: row.lockedAt,
    locked: view.locked,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAssessmentMarkDto(mark: MarkRecord): AssessmentMarkDto {
  return {
    id: mark.id.toString(),
    assessmentId: mark.assessmentId.toString(),
    enrolmentId: mark.enrolmentId.toString(),
    studentId: mark.studentId.toString(),
    obtained: mark.obtained,
    maxMarks: mark.maxMarks,
    absent: mark.absent,
    excused: mark.excused,
    status: mark.status,
    supersedesId: idOrNull(mark.supersedesId),
    correctionReason: mark.correctionReason,
    enteredAt: mark.enteredAt,
  };
}
