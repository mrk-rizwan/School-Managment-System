// Pieces shared by the assessment and marks services (contracts/slice-30.md).
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import type { AssessmentRecord } from '../../repositories/assessment.repository';
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
}

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
