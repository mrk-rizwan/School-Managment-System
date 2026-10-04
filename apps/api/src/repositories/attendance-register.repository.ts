import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ATTENDANCE_MODES, REGISTER_SOURCES, type AttendanceMode, type RegisterSource } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { enrolmentOnRoster, oneOf, sqlDate } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope, studentInScopeOn } from './student.repository';

// contracts/slice-11.md §3, §4, §10.1: attendance_registers, the roster of a section-day and the
// registers console. Raw SQL for the natural-key insert, the row locks (FOR SHARE on students,
// FOR UPDATE on the register) and the console's live join; every statement filters school_id on
// every table it reads (test/attendance/repositories.e2e-spec.ts). Listed in RAW_SQL_FILES.

/** The section a register belongs to, with its class and year (archived sections included). */
export interface RegisterSection {
  id: bigint;
  name: string;
  classId: bigint;
  className: string;
  academicYearId: bigint;
  attendanceMode: AttendanceMode;
  yearStartsOn: Date;
  yearEndsOn: Date;
}

export interface RosterRow {
  enrolmentId: bigint;
  studentId: bigint;
  fullName: string;
  rollNo: number | null;
  /** False for a row kept only because the register already marks it (R174). */
  onRoster: boolean;
}

export interface RegisterRecord {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  date: Date;
  period: number;
  mode: AttendanceMode;
  submittedBy: bigint;
  submittedAt: Date;
  lastAmendedBy: bigint | null;
  lastAmendedAt: Date | null;
  source: RegisterSource;
}

export interface RegisterView extends RegisterRecord {
  submittedByName: string | null;
  lastAmendedByName: string | null;
}

export interface NewRegister {
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  date: Date;
  period: number;
  mode: AttendanceMode;
  submittedBy: bigint;
  submittedAt: Date;
  source: RegisterSource;
}

export type SectionDaySort = 'className' | 'sectionName' | '-registersRecorded';

export interface SectionDayQuery {
  date: Date;
  classId?: bigint;
  sectionId?: bigint;
  recorded?: boolean;
  sort: SectionDaySort;
  skip: number;
  take: number;
}

/** One section's day on the console (§10.1): live register count, roster size, teachers. */
export interface SectionDayRow {
  sectionId: bigint;
  sectionName: string;
  classId: bigint;
  className: string;
  academicYearId: bigint;
  mode: AttendanceMode;
  rosterCount: number;
  registersRecorded: number;
  submittedBy: bigint | null;
  submittedByName: string | null;
  submittedAt: Date | null;
  classTeacherStaffId: bigint | null;
  classTeacherName: string | null;
  /** Every cover active on the date, by assignment id. */
  coverStaffIds: bigint[];
  coverStaffName: string | null;
}

interface RawRegister {
  id: bigint;
  section_id: bigint;
  class_id: bigint;
  academic_year_id: bigint;
  date: Date;
  period: number;
  mode: string;
  submitted_by: bigint;
  submitted_at: Date;
  last_amended_by: bigint | null;
  last_amended_at: Date | null;
  source: string;
  submitted_by_name?: string | null;
  last_amended_by_name?: string | null;
}

const REGISTER_COLUMNS = Prisma.sql`r.id, r.section_id, r.class_id, r.academic_year_id, r.date, r.period,
  r.mode::text AS mode, r.submitted_by, r.submitted_at, r.last_amended_by, r.last_amended_at,
  r.source::text AS source`;

/** The staff name of a user (`users.staff_id`), or null. */
const staffNameOf = (userColumn: Prisma.Sql): Prisma.Sql => Prisma.sql`(
  SELECT sf.full_name FROM users u JOIN staff sf ON sf.school_id = u.school_id AND sf.id = u.staff_id
   WHERE u.school_id = r.school_id AND u.id = ${userColumn})`;

const toRegister = (row: RawRegister): RegisterRecord => ({
  id: row.id,
  sectionId: row.section_id,
  classId: row.class_id,
  academicYearId: row.academic_year_id,
  date: row.date,
  period: Number(row.period),
  mode: oneOf(ATTENDANCE_MODES, row.mode),
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  lastAmendedBy: row.last_amended_by,
  lastAmendedAt: row.last_amended_at,
  source: oneOf(REGISTER_SOURCES, row.source),
});

/** The scope as a predicate on a section id column; an empty or non-section scope matches nothing. */
export function sectionInScope(scope: Scope, column: Prisma.Sql): Prisma.Sql {
  if (scope.kind === 'all') return Prisma.sql`TRUE`;
  if (scope.kind === 'sections' && scope.ids.length > 0) {
    return Prisma.sql`${column} IN (${Prisma.join([...scope.ids])})`;
  }
  return Prisma.sql`FALSE`;
}

function sectionDayOrder(sort: SectionDaySort): Prisma.Sql {
  switch (sort) {
    case 'sectionName':
      return Prisma.sql`section_name ASC, class_name ASC, section_id ASC`;
    case '-registersRecorded':
      return Prisma.sql`registers_recorded DESC, class_name ASC, section_name ASC, section_id ASC`;
    case 'className':
      return Prisma.sql`class_name ASC, section_name ASC, section_id ASC`;
  }
}

@Injectable()
export class AttendanceRegisterRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The section, archived included, with its class and year; null when not in the school. */
  async findSection(schoolId: SchoolId, sectionId: bigint): Promise<RegisterSection | null> {
    const rows = await this.txHost.tx.$queryRaw<
      {
        id: bigint;
        name: string;
        class_id: bigint;
        class_name: string;
        academic_year_id: bigint;
        attendance_mode: string;
        starts_on: Date;
        ends_on: Date;
      }[]
    >`
      SELECT s.id, s.name, c.id AS class_id, c.name AS class_name, c.academic_year_id,
             c.attendance_mode::text AS attendance_mode, y.starts_on, y.ends_on
        FROM sections s
        JOIN classes c ON c.school_id = s.school_id AND c.id = s.class_id
        JOIN academic_years y ON y.school_id = c.school_id AND y.id = c.academic_year_id
       WHERE s.school_id = ${schoolId} AND s.id = ${sectionId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      classId: row.class_id,
      className: row.class_name,
      academicYearId: row.academic_year_id,
      attendanceMode: oneOf(ATTENDANCE_MODES, row.attendance_mode),
      yearStartsOn: row.starts_on,
      yearEndsOn: row.ends_on,
    };
  }

  /**
   * §3.1: onRoster(S, d) ∪ the enrolments the register already marks, ordered by roll number
   * (nulls last), name, enrolment id. No lock.
   */
  async roster(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
    registerId: bigint | null,
  ): Promise<RosterRow[]> {
    const d = sqlDate(date);
    const marked =
      registerId === null
        ? Prisma.sql`FALSE`
        : Prisma.sql`EXISTS (SELECT 1 FROM attendance_marks m
                              WHERE m.school_id = e.school_id AND m.register_id = ${registerId}
                                AND m.enrolment_id = e.id)`;
    const rows = await this.txHost.tx.$queryRaw<
      { enrolment_id: bigint; student_id: bigint; full_name: string; roll_no: number | null; on_roster: boolean }[]
    >`
      SELECT e.id AS enrolment_id, e.student_id, st.full_name, e.roll_no,
             ${enrolmentOnRoster(d)} AS on_roster
        FROM enrolments e
        JOIN students st ON st.school_id = e.school_id AND st.id = e.student_id
       WHERE e.school_id = ${schoolId} AND e.section_id = ${sectionId}
         AND (${enrolmentOnRoster(d)} OR ${marked})
       ORDER BY e.roll_no ASC NULLS LAST, st.full_name ASC, e.id ASC`;
    return rows.map((r) => ({
      enrolmentId: r.enrolment_id,
      studentId: r.student_id,
      fullName: r.full_name,
      rollNo: r.roll_no === null ? null : Number(r.roll_no),
      onRoster: r.on_roster,
    }));
  }

  /** |onRoster(S, d)| (§3.1, without the union). */
  async rosterCount(schoolId: SchoolId, sectionId: bigint, date: Date): Promise<number> {
    const d = sqlDate(date);
    const [row] = await this.txHost.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM enrolments e
       WHERE e.school_id = ${schoolId} AND e.section_id = ${sectionId} AND ${enrolmentOnRoster(d)}`;
    return row?.n ?? 0;
  }

  /**
   * §1.6: the students of every enrolment of the section in force on the date, FOR SHARE in id
   * order, before the roster is read for a write. A section or class change locks the student and
   * then probes the last mark, so it waits for this submit (or this submit waits for it and then
   * reads the new roster).
   */
  async shareRosterStudents(schoolId: SchoolId, sectionId: bigint, date: Date): Promise<void> {
    const d = sqlDate(date);
    await this.txHost.tx.$queryRaw`
      SELECT st.id FROM students st
       WHERE st.school_id = ${schoolId}
         AND st.id IN (SELECT e.student_id FROM enrolments e
                        WHERE e.school_id = ${schoolId} AND e.section_id = ${sectionId}
                          AND e.started_on <= ${d} AND (e.ended_on IS NULL OR e.ended_on >= ${d}))
       ORDER BY st.id
         FOR SHARE OF st`;
  }

  /** The students of the given ids, FOR SHARE in id order (the arrival's one child, §1.6). */
  async shareStudents(schoolId: SchoolId, studentIds: readonly bigint[]): Promise<void> {
    if (studentIds.length === 0) return;
    await this.txHost.tx.$queryRaw`
      SELECT st.id FROM students st
       WHERE st.school_id = ${schoolId} AND st.id IN (${Prisma.join([...studentIds])})
       ORDER BY st.id
         FOR SHARE OF st`;
  }

  /**
   * A student's enrolments in force on the date (the arrival's visibility, §4.4); none when the
   * student is outside `scope` on that date (the caller's mark scope of the date, `rowScope`).
   */
  async enrolmentsInForce(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    date: Date,
  ): Promise<{ id: bigint; sectionId: bigint }[]> {
    return this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        studentId,
        startedOn: { lte: date },
        OR: [{ endedOn: null }, { endedOn: { gte: date } }],
        student: { is: studentInScopeOn(scope, date) },
      },
      select: { id: true, sectionId: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * A student's enrolments overlapping the range (the student attendance `enrolled` flag); none
   * when the student is outside the caller's scope.
   */
  async enrolmentsOverlapping(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    from: Date,
    to: Date,
  ): Promise<{ startedOn: Date; endedOn: Date | null }[]> {
    return this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        studentId,
        startedOn: { lte: to },
        OR: [{ endedOn: null }, { endedOn: { gte: from } }],
        student: { is: studentInScope(scope) },
      },
      select: { startedOn: true, endedOn: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * §4.2 step 6: inserts the register unless its natural key exists. True when this call created
   * it. A concurrent first insert blocks this one until it commits; this one then inserts nothing.
   */
  async insertIfAbsent(schoolId: SchoolId, data: NewRegister): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      INSERT INTO attendance_registers
        (school_id, section_id, class_id, academic_year_id, date, period, mode, submitted_by,
         submitted_at, source)
      VALUES (${schoolId}, ${data.sectionId}, ${data.classId}, ${data.academicYearId},
              ${sqlDate(data.date)}, ${data.period}, ${data.mode}::attendance_mode,
              ${data.submittedBy}, ${data.submittedAt}, ${data.source}::register_source)
      ON CONFLICT (school_id, section_id, date, period) DO NOTHING
      RETURNING id`;
    return rows.length === 1;
  }

  /** The register by its natural key, locked FOR UPDATE (§4.2 step 6). */
  async lockByNaturalKey(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
    period: number,
  ): Promise<RegisterRecord | null> {
    const rows = await this.txHost.tx.$queryRaw<RawRegister[]>`
      SELECT ${REGISTER_COLUMNS} FROM attendance_registers r
       WHERE r.school_id = ${schoolId} AND r.section_id = ${sectionId}
         AND r.date = ${sqlDate(date)} AND r.period = ${period}
         FOR UPDATE`;
    const row = rows[0];
    return row ? toRegister(row) : null;
  }

  /** A register by id, locked FOR UPDATE (the amend and arrival paths, §4.3, §4.4). */
  async lock(schoolId: SchoolId, id: bigint): Promise<RegisterRecord | null> {
    const rows = await this.txHost.tx.$queryRaw<RawRegister[]>`
      SELECT ${REGISTER_COLUMNS} FROM attendance_registers r
       WHERE r.school_id = ${schoolId} AND r.id = ${id}
         FOR UPDATE`;
    const row = rows[0];
    return row ? toRegister(row) : null;
  }

  /** The register of a section-day-period with the submitter's and amender's names; no lock. */
  async findView(
    schoolId: SchoolId,
    sectionId: bigint,
    date: Date,
    period: number,
  ): Promise<RegisterView | null> {
    const rows = await this.txHost.tx.$queryRaw<RawRegister[]>`
      SELECT ${REGISTER_COLUMNS},
             ${staffNameOf(Prisma.sql`r.submitted_by`)} AS submitted_by_name,
             ${staffNameOf(Prisma.sql`r.last_amended_by`)} AS last_amended_by_name
        FROM attendance_registers r
       WHERE r.school_id = ${schoolId} AND r.section_id = ${sectionId}
         AND r.date = ${sqlDate(date)} AND r.period = ${period}`;
    const row = rows[0];
    if (!row) return null;
    return {
      ...toRegister(row),
      submittedByName: row.submitted_by_name ?? null,
      lastAmendedByName: row.last_amended_by_name ?? null,
    };
  }

  /** A later submit or an amendment: who and when (§4.2 step 9). */
  async setAmended(schoolId: SchoolId, id: bigint, userId: bigint, at: Date): Promise<void> {
    await this.txHost.tx.attendanceRegister.updateMany({
      where: { schoolId, id },
      data: { lastAmendedBy: userId, lastAmendedAt: at },
    });
  }

  /** Registers recorded for a section-day (live; the rollup's registers_recorded). */
  async countForSectionDay(schoolId: SchoolId, sectionId: bigint, date: Date): Promise<number> {
    return this.txHost.tx.attendanceRegister.count({ where: { schoolId, sectionId, date } });
  }

  /**
   * §10.1 (and R129's unrecorded set): every section of a class whose academic year covers the
   * date, with a non-empty roster, inside the scope, with the live register count and the day's
   * earliest register, the class teacher and a cover active on the date. One page and its total.
   */
  sectionDays(
    schoolId: SchoolId,
    scope: Scope,
    query: SectionDayQuery,
  ): Promise<{ rows: SectionDayRow[]; total: number }> {
    return this.sectionDayPage(schoolId, sectionInScope(scope, Prisma.sql`s.id`), query);
  }

  /**
   * R129's unrecorded set for the deadline job (§8.4): every section of the school with a
   * non-empty roster on the date and no register at all. Sections and registers only, no student
   * row, so the worker asks it without a caller's scope.
   */
  async unrecordedForDeadline(schoolId: SchoolId, date: Date): Promise<SectionDayRow[]> {
    const { rows } = await this.sectionDayPage(schoolId, Prisma.sql`TRUE`, {
      date,
      recorded: false,
      sort: 'className',
      skip: 0,
      take: 10_000,
    });
    return rows;
  }

  private async sectionDayPage(
    schoolId: SchoolId,
    inScope: Prisma.Sql,
    query: SectionDayQuery,
  ): Promise<{ rows: SectionDayRow[]; total: number }> {
    const d = sqlDate(query.date);
    const filters: Prisma.Sql[] = [inScope];
    if (query.classId !== undefined) filters.push(Prisma.sql`s.class_id = ${query.classId}`);
    if (query.sectionId !== undefined) filters.push(Prisma.sql`s.id = ${query.sectionId}`);
    const recorded =
      query.recorded === undefined
        ? Prisma.sql`TRUE`
        : query.recorded
          ? Prisma.sql`registers_recorded > 0`
          : Prisma.sql`registers_recorded = 0`;
    const activeOn = Prisma.sql`ta.voided_at IS NULL AND ta.starts_on <= ${d}
        AND (ta.ends_on IS NULL OR ta.ends_on >= ${d})`;
    const rows = await this.txHost.tx.$queryRaw<
      {
        section_id: bigint;
        section_name: string;
        class_id: bigint;
        class_name: string;
        academic_year_id: bigint;
        mode: string;
        roster_count: number;
        registers_recorded: number;
        submitted_by: bigint | null;
        submitted_by_name: string | null;
        submitted_at: Date | null;
        class_teacher_staff_id: bigint | null;
        class_teacher_name: string | null;
        cover_staff_ids: bigint[];
        cover_staff_name: string | null;
        total: number;
      }[]
    >`
      WITH days AS (
        SELECT s.id AS section_id, s.name AS section_name, c.id AS class_id, c.name AS class_name,
               c.academic_year_id, c.attendance_mode::text AS mode,
               (SELECT count(*)::int FROM enrolments e
                 WHERE e.school_id = s.school_id AND e.section_id = s.id AND ${enrolmentOnRoster(d)})
                 AS roster_count,
               (SELECT count(*)::int FROM attendance_registers r
                 WHERE r.school_id = s.school_id AND r.section_id = s.id AND r.date = ${d})
                 AS registers_recorded
          FROM sections s
          JOIN classes c ON c.school_id = s.school_id AND c.id = s.class_id
          JOIN academic_years y ON y.school_id = c.school_id AND y.id = c.academic_year_id
         WHERE s.school_id = ${schoolId} AND y.starts_on <= ${d} AND y.ends_on >= ${d}
           AND ${Prisma.join(filters, ' AND ')}
      )
      SELECT days.*, first.submitted_by, first.submitted_at, first.submitted_by_name,
             ct.staff_id AS class_teacher_staff_id, ct.full_name AS class_teacher_name,
             COALESCE(cv.staff_ids, ARRAY[]::bigint[]) AS cover_staff_ids,
             cv.first_name AS cover_staff_name,
             count(*) OVER ()::int AS total
        FROM days
        -- The day's earliest register and its submitter's staff name.
        LEFT JOIN LATERAL (
          SELECT r.submitted_by, r.submitted_at, sf.full_name AS submitted_by_name
            FROM attendance_registers r
            LEFT JOIN users u ON u.school_id = r.school_id AND u.id = r.submitted_by
            LEFT JOIN staff sf ON sf.school_id = u.school_id AND sf.id = u.staff_id
           WHERE r.school_id = ${schoolId} AND r.section_id = days.section_id AND r.date = ${d}
           ORDER BY r.submitted_at ASC, r.id ASC LIMIT 1) first ON TRUE
        -- The class teacher active on the date (the first by id).
        LEFT JOIN LATERAL (
          SELECT ta.staff_id, sf.full_name FROM teacher_assignments ta
            JOIN staff sf ON sf.school_id = ta.school_id AND sf.id = ta.staff_id
           WHERE ta.school_id = ${schoolId} AND ta.section_id = days.section_id
             AND ta.role = 'class_teacher' AND ${activeOn}
           ORDER BY ta.id LIMIT 1) ct ON TRUE
        -- Every cover active on the date by assignment id, and the first one's name.
        LEFT JOIN LATERAL (
          SELECT array_agg(ta.staff_id ORDER BY ta.id) AS staff_ids,
                 (array_agg(sf.full_name ORDER BY ta.id))[1] AS first_name
            FROM teacher_assignments ta
            JOIN staff sf ON sf.school_id = ta.school_id AND sf.id = ta.staff_id
           WHERE ta.school_id = ${schoolId} AND ta.section_id = days.section_id
             AND ta.role = 'cover' AND ${activeOn}) cv ON TRUE
       WHERE days.roster_count > 0 AND ${recorded}
       ORDER BY ${sectionDayOrder(query.sort)}
       LIMIT ${query.take} OFFSET ${query.skip}`;
    return {
      total:
        rows[0]?.total ??
        (query.skip > 0
          ? (await this.sectionDayPage(schoolId, inScope, { ...query, skip: 0, take: 1 })).total
          : 0),
      rows: rows.map((r) => ({
        sectionId: r.section_id,
        sectionName: r.section_name,
        classId: r.class_id,
        className: r.class_name,
        academicYearId: r.academic_year_id,
        mode: oneOf(ATTENDANCE_MODES, r.mode),
        rosterCount: r.roster_count,
        registersRecorded: r.registers_recorded,
        submittedBy: r.submitted_by,
        submittedByName: r.submitted_by_name,
        submittedAt: r.submitted_at,
        classTeacherStaffId: r.class_teacher_staff_id,
        classTeacherName: r.class_teacher_name,
        coverStaffIds: r.cover_staff_ids.map((id) => BigInt(id)),
        coverStaffName: r.cover_staff_name,
      })),
    };
  }
}
