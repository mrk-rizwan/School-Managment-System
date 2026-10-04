import { Injectable } from '@nestjs/common';
import { AttendanceMarkRepository } from '../../repositories/attendance-mark.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { AttendanceHistoryProbe } from '../people/students/attendance-history-probe';

/**
 * The real seam of a section or class change (contracts/slice-11.md §9.1, slice-10.md §8.2 step
 * 5): the latest date with a mark on the enrolment. It runs under the student lock the change
 * holds, and a submit shares that student row (§1.6), so the answer is exact.
 */
@Injectable()
export class MarkHistoryProbe extends AttendanceHistoryProbe {
  constructor(private readonly marks: AttendanceMarkRepository) {
    super();
  }

  lastRecordedOn(schoolId: SchoolId, enrolmentId: bigint): Promise<Date | null> {
    return this.marks.lastRecordedOn(schoolId, enrolmentId);
  }
}
