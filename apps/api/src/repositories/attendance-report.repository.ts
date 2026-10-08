import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ATTENDANCE_MODES,
  DAY_STATUSES,
  type AttendanceMode,
  type AttendanceValueSettings,
  type DayStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { sectionInScope } from './attendance-register.repository';
import { oneOf, sqlDate, sqlTime, studentInScopeSql, timeText } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-11.md §10 (R128, R131): the attendance reads over the materialised tables —
// the section summaries, the absentee and late lists, a student's days and the percentage report.
// Nothing here reads raw marks except where a day's periods are listed. The calendar is applied at
// read (§7): the caller passes the weekly-off days, and published holidays are read here. Raw SQL;
// every statement filters school_id on every table it reads (test/attendance/repositories.e2e-spec.ts).
// Listed in RAW_SQL_FILES.

export type DailySummarySort = '-date' | 'date' | 'className';

export interface DailySummaryRow {
  sectionId: bigint;
  sectionName: string;
  classId: bigint;
  className: string;
  date: Date;
  mode: AttendanceMode;
  registersExpected: number;
  registersRecorded: number;
  rosterCount: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  partial: number;
  computedAt: Date | null;
  stale: boolean;
}

export type DayListSort = 'className' | 'rollNo' | 'fullName';

export interface DayListRow {
  studentId: bigint;
  fullName: string;
  rollNo: number | null;
  enrolmentId: bigint;
  classId: bigint;
  className: string;
  sectionId: bigint;
  sectionName: string;
  date: Date;
  status: DayStatus;
  arrivedAt: string | null;
}

export interface StudentDayRow {
  date: Date;
  status: DayStatus;
  recorded: number;
  present: number;
  late: number;
  absent: number;
  leave: number;
  firstLateArrivedAt: string | null;
}

export type PercentageSort = 'percentage' | '-percentage' | 'fullName' | 'className';

export interface PercentageQuery {
  from: Date;
  to: Date;
  weeklyOffDays: readonly number[];
  settings: AttendanceValueSettings;
  classId?: bigint;
  sectionId?: bigint;
  below?: number;
  sort: PercentageSort;
  skip: number;
  take: number;
}

export interface PercentageRow {
  studentId: bigint;
  fullName: string;
  rollNo: number | null;
  classId: bigint | null;
  className: string | null;
  sectionId: bigint | null;
  sectionName: string | null;
  percentage: number | null;
  countedDays: number;
  teachingDays: number;
}

interface Page<T> {
  rows: T[];
  total: number;
}

function summaryOrder(sort: DailySummarySort): Prisma.Sql {
  switch (sort) {
    case 'date':
      return Prisma.sql`ds.date ASC, s.name ASC, ds.section_id ASC`;
    case 'className':
      return Prisma.sql`c.name ASC, ds.date DESC, s.name ASC, ds.section_id ASC`;
    case '-date':
      return Prisma.sql`ds.date DESC, s.name ASC, ds.section_id ASC`;
  }
}

function dayListOrder(sort: DayListSort): Prisma.Sql {
  switch (sort) {
    case 'rollNo':
      return Prisma.sql`e.roll_no ASC NULLS LAST, st.full_name ASC, e.id ASC`;
    case 'fullName':
      return Prisma.sql`st.full_name ASC, e.id ASC`;
    case 'className':
      return Prisma.sql`c.name ASC, s.name ASC, e.roll_no ASC NULLS LAST, st.full_name ASC, e.id ASC`;
  }
}

function percentageOrder(sort: PercentageSort): Prisma.Sql {
  switch (sort) {
    case 'percentage':
      return Prisma.sql`percentage ASC NULLS LAST, student_id ASC`;
    case '-percentage':
      return Prisma.sql`percentage DESC NULLS LAST, student_id ASC`;
    case 'fullName':
      return Prisma.sql`full_name ASC, student_id ASC`;
    case 'className':
      return Prisma.sql`class_name ASC NULLS LAST, section_name ASC NULLS LAST, roll_no ASC NULLS LAST, student_id ASC`;
  }
}

/** The teaching days of a range as a CTE body: not a weekly-off day and in no published holiday. */
function teachingDaysSql(schoolId: SchoolId, from: Date, to: Date, weeklyOffDays: readonly number[]): Prisma.Sql {
  const off =
    weeklyOffDays.length === 0
      ? Prisma.sql`FALSE`
      : Prisma.sql`EXTRACT(dow FROM g.d)::int IN (${Prisma.join([...weeklyOffDays])})`;
  return Prisma.sql`
    SELECT g.d::date AS date FROM generate_series(${sqlDate(from)}, ${sqlDate(to)}, interval '1 day') AS g(d)
     WHERE NOT (${off})
       AND NOT EXISTS (SELECT 1 FROM holidays h
                        WHERE h.school_id = ${schoolId} AND h.status = 'published'
                          AND g.d::date BETWEEN h.starts_on AND h.ends_on)`;
}

/** dayValue() (§5.2) as SQL over an attendance_day_status alias `ds`; null leaves the denominator. */
function dayValueSql(settings: AttendanceValueSettings): Prisma.Sql {
  return Prisma.sql`CASE ds.status
                 WHEN 'present' THEN 1::numeric
                 WHEN 'absent' THEN 0::numeric
                 WHEN 'late' THEN CASE ${settings.lateCountsAs}::text
                   WHEN 'present' THEN 1::numeric
                   WHEN 'half_day' THEN 0.5::numeric
                   ELSE CASE WHEN ds.first_late_arrived_at IS NOT NULL
                                  AND ${sqlTime(settings.lateCutoffTime)} IS NOT NULL
                                  AND ds.first_late_arrived_at > ${sqlTime(settings.lateCutoffTime)}
                             THEN 0::numeric ELSE 1::numeric END
                 END
                 WHEN 'on_leave' THEN CASE WHEN ${settings.leaveCountsAs}::text = 'absent'
                                           THEN 0::numeric ELSE NULL END
                 WHEN 'partial' THEN (ds.periods_present + ds.periods_late)::numeric / ds.periods_recorded
               END`;
}

@Injectable()
export class AttendanceReportRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** §10.2: summary rows in the range, inside the scope, a page and its total. */
  async dailySummaries(
    schoolId: SchoolId,
    scope: Scope,
    query: {
      from: Date;
      to: Date;
      classId?: bigint;
      sectionId?: bigint;
      sort: DailySummarySort;
      skip: number;
      take: number;
    },
  ): Promise<Page<DailySummaryRow>> {
    const filters: Prisma.Sql[] = [sectionInScope(scope, Prisma.sql`ds.section_id`)];
    if (query.classId !== undefined) filters.push(Prisma.sql`ds.class_id = ${query.classId}`);
    if (query.sectionId !== undefined) filters.push(Prisma.sql`ds.section_id = ${query.sectionId}`);
    const rows = await this.txHost.tx.$queryRaw<
      {
        section_id: bigint;
        section_name: string;
        class_id: bigint;
        class_name: string;
        date: Date;
        mode: string;
        registers_expected: number;
        registers_recorded: number;
        roster_count: number;
        present: number;
        absent: number;
        late: number;
        on_leave: number;
        partial: number;
        computed_at: Date | null;
        stale: boolean;
        total: number;
      }[]
    >`
      SELECT ds.section_id, s.name AS section_name, ds.class_id, c.name AS class_name, ds.date,
             ds.mode::text AS mode, ds.registers_expected, ds.registers_recorded, ds.roster_count,
             ds.present, ds.absent, ds.late, ds.on_leave, ds.partial, ds.computed_at,
             (ds.computed_version <> ds.version) AS stale, count(*) OVER ()::int AS total
        FROM attendance_daily_summary ds
        JOIN sections s ON s.school_id = ds.school_id AND s.id = ds.section_id
        JOIN classes c ON c.school_id = ds.school_id AND c.id = ds.class_id
       WHERE ds.school_id = ${schoolId}
         AND ds.date BETWEEN ${sqlDate(query.from)} AND ${sqlDate(query.to)}
         AND ${Prisma.join(filters, ' AND ')}
       ORDER BY ${summaryOrder(query.sort)}
       LIMIT ${query.take} OFFSET ${query.skip}`;
    return {
      total: rows[0]?.total ?? 0,
      rows: rows.map((r) => ({
        sectionId: r.section_id,
        sectionName: r.section_name,
        classId: r.class_id,
        className: r.class_name,
        date: r.date,
        mode: oneOf(ATTENDANCE_MODES, r.mode),
        registersExpected: Number(r.registers_expected),
        registersRecorded: Number(r.registers_recorded),
        rosterCount: Number(r.roster_count),
        present: Number(r.present),
        absent: Number(r.absent),
        late: Number(r.late),
        onLeave: Number(r.on_leave),
        partial: Number(r.partial),
        computedAt: r.computed_at,
        stale: r.stale,
      })),
    };
  }

  /** §10.3: the enrolment-days of a date with one of `statuses`, a page and its total. */
  async dayList(
    schoolId: SchoolId,
    query: {
      date: Date;
      statuses: readonly DayStatus[];
      classId?: bigint;
      sectionId?: bigint;
      sort: DayListSort;
      skip: number;
      take: number;
    },
  ): Promise<Page<DayListRow>> {
    const filters: Prisma.Sql[] = [
      Prisma.sql`ds.status::text IN (${Prisma.join([...query.statuses])})`,
    ];
    if (query.classId !== undefined) filters.push(Prisma.sql`e.class_id = ${query.classId}`);
    if (query.sectionId !== undefined) filters.push(Prisma.sql`ds.section_id = ${query.sectionId}`);
    const rows = await this.txHost.tx.$queryRaw<
      {
        student_id: bigint;
        full_name: string;
        roll_no: number | null;
        enrolment_id: bigint;
        class_id: bigint;
        class_name: string;
        section_id: bigint;
        section_name: string;
        date: Date;
        status: string;
        arrived_at: string | null;
        total: number;
      }[]
    >`
      SELECT ds.student_id, st.full_name, e.roll_no, e.id AS enrolment_id, e.class_id,
             c.name AS class_name, ds.section_id, s.name AS section_name, ds.date,
             ds.status::text AS status, ${timeText(Prisma.sql`ds.first_late_arrived_at`)} AS arrived_at,
             count(*) OVER ()::int AS total
        FROM attendance_day_status ds
        JOIN enrolments e ON e.school_id = ds.school_id AND e.id = ds.enrolment_id
        JOIN students st ON st.school_id = ds.school_id AND st.id = ds.student_id
        JOIN classes c ON c.school_id = ds.school_id AND c.id = e.class_id
        JOIN sections s ON s.school_id = ds.school_id AND s.id = ds.section_id
       WHERE ds.school_id = ${schoolId} AND ds.date = ${sqlDate(query.date)}
         AND ${Prisma.join(filters, ' AND ')}
       ORDER BY ${dayListOrder(query.sort)}
       LIMIT ${query.take} OFFSET ${query.skip}`;
    return {
      total: rows[0]?.total ?? 0,
      rows: rows.map((r) => ({
        studentId: r.student_id,
        fullName: r.full_name,
        rollNo: r.roll_no === null ? null : Number(r.roll_no),
        enrolmentId: r.enrolment_id,
        classId: r.class_id,
        className: r.class_name,
        sectionId: r.section_id,
        sectionName: r.section_name,
        date: r.date,
        status: oneOf(DAY_STATUSES, r.status),
        arrivedAt: r.arrived_at,
      })),
    };
  }

  /**
   * §10.4: a student's materialised days in the range, one per date (the first enrolment's); none
   * when the student is outside the caller's scope.
   */
  async studentDays(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    from: Date,
    to: Date,
  ): Promise<StudentDayRow[]> {
    const rows = await this.txHost.tx.$queryRaw<
      {
        date: Date;
        status: string;
        periods_recorded: number;
        periods_present: number;
        periods_late: number;
        periods_absent: number;
        periods_leave: number;
        first_late_arrived_at: string | null;
      }[]
    >`
      SELECT DISTINCT ON (ds.date) ds.date, ds.status::text AS status, ds.periods_recorded,
             ds.periods_present, ds.periods_late, ds.periods_absent, ds.periods_leave,
             ${timeText(Prisma.sql`ds.first_late_arrived_at`)} AS first_late_arrived_at
        FROM attendance_day_status ds
       WHERE ds.school_id = ${schoolId} AND ds.student_id = ${studentId}
         AND ${studentInScopeSql(scope, Prisma.sql`ds.school_id`, Prisma.sql`ds.student_id`)}
         AND ds.date BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
       ORDER BY ds.date ASC, ds.id ASC`;
    return rows.map((r) => ({
      date: r.date,
      status: oneOf(DAY_STATUSES, r.status),
      recorded: Number(r.periods_recorded),
      present: Number(r.periods_present),
      late: Number(r.periods_late),
      absent: Number(r.periods_absent),
      leave: Number(r.periods_leave),
      firstLateArrivedAt: r.first_late_arrived_at,
    }));
  }

  /**
   * §10.5: §5.2-§5.3 in one statement per page. Students `active` or `suspended` now with an
   * active enrolment (filtered by class or section); teaching days are the range minus weekly-off
   * days and published holidays; a day counts when the student had an enrolment in force on it.
   * The values follow dayValue() exactly (test/attendance/percentage.e2e-spec.ts compares them).
   */
  async percentage(schoolId: SchoolId, query: PercentageQuery): Promise<Page<PercentageRow>> {
    const { settings } = query;
    const filters: Prisma.Sql[] = [];
    if (query.classId !== undefined) filters.push(Prisma.sql`e.class_id = ${query.classId}`);
    if (query.sectionId !== undefined) filters.push(Prisma.sql`e.section_id = ${query.sectionId}`);
    const below =
      query.below === undefined
        ? Prisma.sql`TRUE`
        : Prisma.sql`percentage IS NOT NULL AND percentage < ${query.below}`;
    const enrolledOn = (date: Prisma.Sql) => Prisma.sql`EXISTS (
      SELECT 1 FROM enrolments ee
       WHERE ee.school_id = ${schoolId} AND ee.student_id = cohort.student_id
         AND ee.started_on <= ${date} AND (ee.ended_on IS NULL OR ee.ended_on >= ${date}))`;
    const rows = await this.txHost.tx.$queryRaw<
      {
        student_id: bigint;
        full_name: string;
        roll_no: number | null;
        class_id: bigint | null;
        class_name: string | null;
        section_id: bigint | null;
        section_name: string | null;
        percentage: number | null;
        counted_days: number;
        teaching_days: number;
        total: number;
      }[]
    >`
      WITH teaching AS (${teachingDaysSql(schoolId, query.from, query.to, query.weeklyOffDays)}),
      cohort AS (
        SELECT st.id AS student_id, st.full_name, e.roll_no, e.class_id, c.name AS class_name,
               e.section_id, s.name AS section_name
          FROM students st
          JOIN enrolments e ON e.school_id = st.school_id AND e.student_id = st.id AND e.status = 'active'
          JOIN classes c ON c.school_id = e.school_id AND c.id = e.class_id
          JOIN sections s ON s.school_id = e.school_id AND s.id = e.section_id
         WHERE st.school_id = ${schoolId} AND st.status IN ('active', 'suspended')
           ${filters.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(filters, ' AND ')}`}
      ),
      valued AS (
        SELECT DISTINCT ON (ds.student_id, ds.date) ds.student_id, ds.date,
               ${dayValueSql(settings)} AS value
          FROM attendance_day_status ds
          JOIN cohort ON cohort.student_id = ds.student_id
          JOIN teaching t ON t.date = ds.date
         WHERE ds.school_id = ${schoolId}
           AND ds.date BETWEEN ${sqlDate(query.from)} AND ${sqlDate(query.to)}
           AND ${enrolledOn(Prisma.sql`ds.date`)}
         ORDER BY ds.student_id, ds.date, ds.id
      ),
      sums AS (
        SELECT student_id, count(value)::int AS counted, sum(value) AS total_value
          FROM valued GROUP BY student_id
      ),
      result AS (
        SELECT cohort.*,
               (SELECT count(*)::int FROM teaching t WHERE ${enrolledOn(Prisma.sql`t.date`)}) AS teaching_days,
               COALESCE(sums.counted, 0) AS counted_days,
               CASE WHEN COALESCE(sums.counted, 0) = 0 THEN NULL
                    ELSE round(sums.total_value * 100 / sums.counted, 1)::float8 END AS percentage
          FROM cohort LEFT JOIN sums ON sums.student_id = cohort.student_id
      )
      SELECT result.*, count(*) OVER ()::int AS total
        FROM result
       WHERE ${below}
       ORDER BY ${percentageOrder(query.sort)}
       LIMIT ${query.take} OFFSET ${query.skip}`;
    return {
      total: rows[0]?.total ?? 0,
      rows: rows.map((r) => ({
        studentId: r.student_id,
        fullName: r.full_name,
        rollNo: r.roll_no === null ? null : Number(r.roll_no),
        classId: r.class_id,
        className: r.class_name,
        sectionId: r.section_id,
        sectionName: r.section_name,
        percentage: r.percentage === null ? null : Number(r.percentage),
        countedDays: r.counted_days,
        teachingDays: r.teaching_days,
      })),
    };
  }
  /**
   * Phase 4 slice 31 (R277): the attendance percentage of each of `studentIds` over [from, to] by
   * the rules of GET /students/:id/attendance (§5.3) in one statement: teaching days are the range
   * minus weekly-off days and published holidays; a day counts when the student had any enrolment
   * in force on it and something was recorded; the value is dayValue(). One decimal, half-up;
   * null when nothing counted. A student absent from the answer counted nothing.
   */
  async percentageForStudents(
    schoolId: SchoolId,
    query: {
      studentIds: readonly bigint[];
      from: Date;
      to: Date;
      weeklyOffDays: readonly number[];
      settings: AttendanceValueSettings;
    },
  ): Promise<Map<bigint, number | null>> {
    if (query.studentIds.length === 0) return new Map();
    const rows = await this.txHost.tx.$queryRaw<{ student_id: bigint; percentage: number | null }[]>`
      WITH teaching AS (${teachingDaysSql(schoolId, query.from, query.to, query.weeklyOffDays)}),
      valued AS (
        SELECT DISTINCT ON (ds.student_id, ds.date) ds.student_id, ds.date,
               ${dayValueSql(query.settings)} AS value
          FROM attendance_day_status ds
          JOIN teaching t ON t.date = ds.date
         WHERE ds.school_id = ${schoolId}
           AND ds.student_id IN (${Prisma.join([...query.studentIds])})
           AND ds.date BETWEEN ${sqlDate(query.from)} AND ${sqlDate(query.to)}
           AND EXISTS (SELECT 1 FROM enrolments ee
                        WHERE ee.school_id = ${schoolId} AND ee.student_id = ds.student_id
                          AND ee.started_on <= ds.date AND (ee.ended_on IS NULL OR ee.ended_on >= ds.date))
         ORDER BY ds.student_id, ds.date, ds.id
      )
      SELECT student_id,
             CASE WHEN count(value) = 0 THEN NULL
                  ELSE round(sum(value) * 100 / count(value), 1)::float8 END AS percentage
        FROM valued
       GROUP BY student_id`;
    return new Map(rows.map((r) => [r.student_id, r.percentage === null ? null : Number(r.percentage)]));
  }
}
