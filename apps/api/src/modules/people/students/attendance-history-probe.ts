import type { SchoolId } from '../../../tenancy/school-id';

/**
 * The attendance seam of a section or class change (contracts/slice-10.md §8.2 step 5): the last
 * date a mark was recorded on the enrolment, so a move is never dated on or before a mark (marks
 * are never moved or orphaned; `409 ATTENDANCE_RECORDED_AFTER`). Owned by the enrolments module;
 * attendance (slice 11) provides the implementation, MarkHistoryProbe.
 */
export abstract class AttendanceHistoryProbe {
  /** The latest date with a recorded mark on the enrolment, or null when there is none. */
  abstract lastRecordedOn(schoolId: SchoolId, enrolmentId: bigint): Promise<Date | null>;
}
