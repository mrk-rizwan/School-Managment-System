// Pieces shared by the diary and remark services (contracts/slice-13.md).
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';
import { addDays, assertRange, todayIn } from '../../common/school-clock';
import type { DiaryEntryView } from '../../repositories/diary-entry.repository';
import type { RemarkView } from '../../repositories/remark.repository';
import type { SubjectRecord, SubjectRepository } from '../../repositories/subject.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { fromDateString, toDateString } from '../academics/academics.shared';
import {
  ATTACHMENT_MIMES,
  type AttachmentMime,
  type DiaryEntryDto,
  type DiaryRangeQueryDto,
  type MyDiaryEntryDto,
  type MyRemarkDto,
  type RemarkDto,
} from './diary.dto';

/** Both bounds given: at most 366 days inclusive (§4.1, §5.1, §6.2). */
const MAX_RANGE_DAYS = 365;

/** The validated range and sort of a list query; `dateTo < dateFrom` or > 366 days is 422 on dateTo. */
export function rangeOf(query: DiaryRangeQueryDto): {
  dateFrom?: Date;
  dateTo?: Date;
  descending: boolean;
  skip: number;
  take: number;
} {
  const dateFrom = query.dateFrom === undefined ? undefined : fromDateString(query.dateFrom);
  const dateTo = query.dateTo === undefined ? undefined : fromDateString(query.dateTo);
  if (dateFrom !== undefined && dateTo !== undefined) assertRange(dateFrom, dateTo, MAX_RANGE_DAYS);
  return {
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
    descending: (query.sort ?? '-date') === '-date',
    skip: (query.page - 1) * query.limit,
    take: query.limit,
  };
}

/** A diary or remark writer always has a staff record (the capability needs staff capacity, R59). */
export function requireStaffId(session: SchoolSessionContext): bigint {
  const staffId = session.access.staffId;
  if (staffId === null) {
    throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');
  }
  return staffId;
}

/** The subject a diary entry or remark names: 422 when absent, 409 when archived (§4.3, §5.2). */
export async function usableSubject(
  subjects: SubjectRepository,
  schoolId: SchoolId,
  subjectId: bigint,
): Promise<SubjectRecord> {
  const subject = await subjects.findById(schoolId, subjectId);
  if (!subject) {
    throw fieldRefused('subjectId', ErrorCode.REFERENCE_NOT_FOUND, 'The subject does not exist.');
  }
  if (subject.deletedAt !== null) {
    throw new ApiException(409, ErrorCode.SUBJECT_ARCHIVED, 'This subject is archived.');
  }
  return subject;
}

/** Today's staff scope covers the section (§1.1). A capacity scope never covers one. */
export function sectionInScope(scope: Scope, sectionId: bigint): boolean {
  if (scope.kind === 'all') return true;
  return scope.kind === 'sections' && scope.ids.includes(sectionId);
}

/** The student is one of a capacity scope's students (§1.2): `/me/children/:id` and `/me/student`. */
export function studentInCapacityScope(scope: Scope, studentId: bigint): boolean {
  return scope.kind === 'students' && scope.ids.includes(studentId);
}

/** The settings the diary and remark services read, with the schema defaults when absent. */
export interface DiarySettings {
  timezone: string;
  /** `attendanceAmendWindowDays`: registers and the diary (decision 5). */
  amendWindowDays: number;
}

/**
 * The last day the author may edit without a reason (§4.4): the creation day in the school's
 * time zone plus the amendment window. Measured from creation, not from the entry's date.
 */
export const editWindowEndsOn = (createdAt: Date, settings: DiarySettings): Date =>
  addDays(todayIn(settings.timezone, createdAt), settings.amendWindowDays);

const attachmentMime = (mime: string | null): AttachmentMime | null =>
  ATTACHMENT_MIMES.find((known) => known === mime) ?? null;

function baseEntry(row: DiaryEntryView) {
  return {
    id: row.id.toString(),
    sectionId: row.sectionId.toString(),
    classId: row.classId.toString(),
    date: toDateString(row.date),
    subjectId: row.subjectId.toString(),
    subjectName: row.subjectName,
    authorName: row.authorName,
    topic: row.topic,
    assignment: row.assignment,
    learningOutcome: row.learningOutcome,
    dueOn: row.dueOn === null ? null : toDateString(row.dueOn),
    hasAttachment: row.attachmentObjectKey !== null,
    attachmentMime: attachmentMime(row.attachmentMime),
    attachmentSizeBytes: row.attachmentSizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const toDiaryEntryDto = (row: DiaryEntryView, settings: DiarySettings): DiaryEntryDto => ({
  ...baseEntry(row),
  academicYearId: row.academicYearId.toString(),
  authorStaffId: row.authorStaffId.toString(),
  editWindowEndsOn: toDateString(editWindowEndsOn(row.createdAt, settings)),
});

/** R165: the author by name only, and the labels of the row's own section. */
export const toMyDiaryEntryDto = (row: DiaryEntryView): MyDiaryEntryDto => ({
  ...baseEntry(row),
  className: row.className,
  sectionName: row.sectionName,
});

function baseRemark(row: RemarkView) {
  return {
    id: row.id.toString(),
    studentId: row.studentId.toString(),
    date: toDateString(row.date),
    category: row.category,
    text: row.text,
    subjectId: row.subjectId?.toString() ?? null,
    subjectName: row.subjectName,
    authorName: row.authorName,
    supersedesId: row.supersedesId?.toString() ?? null,
    supersededAt: row.supersededAt,
    supersededById: row.supersededById?.toString() ?? null,
    createdAt: row.createdAt,
  };
}

export const toRemarkDto = (row: RemarkView): RemarkDto => ({
  ...baseRemark(row),
  enrolmentId: row.enrolmentId.toString(),
  visibility: row.visibility,
  authorStaffId: row.authorStaffId.toString(),
  correctionReason: row.correctionReason,
});

/** R165: no author staff id, enrolment, visibility or correction reason. */
export const toMyRemarkDto = (row: RemarkView): MyRemarkDto => baseRemark(row);
