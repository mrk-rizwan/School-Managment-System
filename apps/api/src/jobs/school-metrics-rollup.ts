import { Injectable } from '@nestjs/common';
import { todayIn } from '../common/school-clock';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
// Named exception 6, widened in Phase 3 (phase-3-financial.md §3.7): the only writer of
// platform_school_metrics, run per school inside runAsSchool. eslint.config.mjs lets this file
// import the metrics repository and no other billing or platform repository.
import { SchoolMetricsRepository } from '../repositories/platform/school-metrics.repository';
import { StudentRepository } from '../repositories/student.repository';
import type { SchoolId } from '../tenancy/school-id';

/**
 * The per-school body of `school-metrics-rollup` (daily 00:30 school time): the school's students
 * on the roll, one integer for the day, the platform's only view of a school's size (R222). A
 * re-run of the same day rewrites the count.
 */
@Injectable()
export class SchoolMetricsRollup {
  constructor(
    private readonly school: OwnSchoolRepository,
    private readonly students: StudentRepository,
    private readonly metrics: SchoolMetricsRepository,
  ) {}

  async run(schoolId: SchoolId, now: Date = new Date()): Promise<number | null> {
    const own = await this.school.find(schoolId);
    if (!own) return null;
    const count = await this.students.countOnRoll(schoolId);
    await this.metrics.upsert(schoolId, todayIn(own.timezone, now), count, now);
    return count;
  }
}

/** The rollup with its repositories, so only this file imports the metrics repository. */
export const SCHOOL_METRICS_ROLLUP_PROVIDERS = [SchoolMetricsRollup, SchoolMetricsRepository, StudentRepository];
