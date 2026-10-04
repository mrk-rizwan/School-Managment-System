import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ATTENDANCE_STATUSES,
  type AttendanceMode,
  type AttendanceStatus,
  type DayStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { oneOf, sqlDate, sqlTime, timeText } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-11.md §8 (R131): the rollup's side of attendance_day_status and
// attendance_daily_summary. The summary row and its `version` are written only by the
// statement-level triggers; the rollup reads `version`, recomputes, and sets computed_version
// only if no write landed meanwhile. Rows are recomputed in place, never deleted. Raw SQL for the
// day-status upsert and the stale-row scans (partial index attendance_daily_summary_stale_idx);
// every statement filters school_id (test/attendance/repositories.e2e-spec.ts). Listed in
// RAW_SQL_FILES.

/** One mark of a section-day, for the recompute. */
export interface SectionDayMark {
  enrolmentId: bigint;
  studentId: bigint;
  period: number;
  status: AttendanceStatus;
  arrivedAt: string | null;
}

export interface DayStatusWrite {
  enrolmentId: bigint;
  studentId: bigint;
  status: DayStatus;
  recorded: number;
  present: number;
  late: number;
  absent: number;
  leave: number;
  firstLateArrivedAt: string | null;
}

export interface SummaryCounts {
  rosterCount: number;
  registersRecorded: number;
  /** Written only while the row's registers_expected is still 0 (frozen at first computation). */
  registersExpected: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  partial: number;
}

export interface SectionDayKey {
  sectionId: bigint;
  date: Date;
  version: bigint;
}

@Injectable()
export class AttendanceSummaryRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The summary row's current version and mode (the first register's, §8.2 step 1); null when
   * the section-day has none.
   */
  async version(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
  ): Promise<{ version: bigint; mode: AttendanceMode } | null> {
    return this.txHost.tx.attendanceDailySummary.findFirst({
      where: { schoolId, sectionId, date },
      select: { version: true, mode: true },
    });
  }

  /** Every mark of every register of the section-day (§8.2 step 2). */
  async marksOfSectionDay(schoolId: SchoolId, sectionId: bigint, date: Date): Promise<SectionDayMark[]> {
    const rows = await this.txHost.tx.$queryRaw<
      { enrolment_id: bigint; student_id: bigint; period: number; status: string; arrived_at: string | null }[]
    >`
      SELECT m.enrolment_id, e.student_id, m.period, m.status::text AS status,
             ${timeText(Prisma.sql`m.arrived_at`)} AS arrived_at
        FROM attendance_marks m
        JOIN attendance_registers r ON r.school_id = m.school_id AND r.id = m.register_id
        JOIN enrolments e ON e.school_id = m.school_id AND e.id = m.enrolment_id
       WHERE m.school_id = ${schoolId} AND r.section_id = ${sectionId} AND r.date = ${sqlDate(date)}
       ORDER BY m.enrolment_id, m.period`;
    return rows.map((r) => ({
      enrolmentId: r.enrolment_id,
      studentId: r.student_id,
      period: Number(r.period),
      status: oneOf(ATTENDANCE_STATUSES, r.status),
      arrivedAt: r.arrived_at,
    }));
  }

  /** §8.2 step 2: upsert the enrolment-days on attendance_day_status_natural_key, one statement. */
  async upsertDayStatus(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
    rows: readonly DayStatusWrite[],
    now: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    const d = sqlDate(date);
    const values = rows.map(
      (r) => Prisma.sql`(${schoolId}, ${r.enrolmentId}, ${r.studentId}, ${sectionId}, ${d},
        ${r.status}::day_status, ${r.recorded}::smallint, ${r.present}::smallint, ${r.late}::smallint,
        ${r.absent}::smallint, ${r.leave}::smallint, ${sqlTime(r.firstLateArrivedAt)}, ${now})`,
    );
    await this.txHost.tx.$executeRaw`
      INSERT INTO attendance_day_status AS ds
        (school_id, enrolment_id, student_id, section_id, date, status, periods_recorded,
         periods_present, periods_late, periods_absent, periods_leave, first_late_arrived_at,
         computed_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (school_id, enrolment_id, date) DO UPDATE
        SET status = EXCLUDED.status, periods_recorded = EXCLUDED.periods_recorded,
            periods_present = EXCLUDED.periods_present, periods_late = EXCLUDED.periods_late,
            periods_absent = EXCLUDED.periods_absent, periods_leave = EXCLUDED.periods_leave,
            first_late_arrived_at = EXCLUDED.first_late_arrived_at,
            computed_at = EXCLUDED.computed_at`;
  }

  /**
   * §8.2 step 4: the counts, and computed_version = v, only while the row is still at version v.
   * False when a write landed meanwhile (its own job recomputes).
   */
  async complete(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
    version: bigint,
    counts: SummaryCounts,
    now: Date,
  ): Promise<boolean> {
    const changed = await this.txHost.tx.$executeRaw`
      UPDATE attendance_daily_summary
         SET roster_count = ${counts.rosterCount}, registers_recorded = ${counts.registersRecorded},
             registers_expected = CASE WHEN registers_expected = 0 THEN ${counts.registersExpected}::smallint
                                       ELSE registers_expected END,
             present = ${counts.present}, absent = ${counts.absent}, late = ${counts.late},
             on_leave = ${counts.onLeave}, partial = ${counts.partial},
             computed_version = ${version}, computed_at = ${now}
       WHERE school_id = ${schoolId} AND section_id = ${sectionId} AND date = ${sqlDate(date)}
         AND version = ${version}`;
    return changed === 1;
  }

  /** §8.3: stale section-days (computed_version <> version), oldest date first. */
  async listStale(schoolId: SchoolId, limit: number): Promise<SectionDayKey[]> {
    const rows = await this.txHost.tx.$queryRaw<{ section_id: bigint; date: Date; version: bigint }[]>`
      SELECT section_id, date, version FROM attendance_daily_summary
       WHERE school_id = ${schoolId} AND computed_version <> version
       ORDER BY date ASC, section_id ASC
       LIMIT ${limit}`;
    return rows.map((r) => ({ sectionId: r.section_id, date: r.date, version: r.version }));
  }

  /** §8.3, the nightly net: every section-day with a summary row dated from `from` on. */
  async listSince(schoolId: SchoolId, from: Date, limit: number): Promise<SectionDayKey[]> {
    const rows = await this.txHost.tx.attendanceDailySummary.findMany({
      where: { schoolId, date: { gte: from } },
      select: { sectionId: true, date: true, version: true },
      orderBy: [{ date: 'asc' }, { sectionId: 'asc' }],
      take: limit,
    });
    return rows;
  }
}
