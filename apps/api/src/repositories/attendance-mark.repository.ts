import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ATTENDANCE_MODES,
  ATTENDANCE_STATUSES,
  type AttendanceMode,
  type AttendanceStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { oneOf, sqlDate, sqlTime, studentInScopeSql, timeText } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-11.md §4, §9.1: attendance_marks, their history (attendance_mark_changes, written
// only by the §4.6 trigger) and the gate's arrivals. Raw SQL for the one-statement register
// upsert (INSERT ... ON CONFLICT ON CONSTRAINT attendance_marks_natural_key DO UPDATE ... WHERE
// ... IS DISTINCT FROM), the row locks and the time columns; every statement filters school_id on
// every table it reads (test/attendance/repositories.e2e-spec.ts). Listed in RAW_SQL_FILES.

/** A mark as the services see it. Times are `HH:MM` in the school's time zone. */
export interface MarkRecord {
  id: bigint;
  registerId: bigint;
  /** The register's section and mode. */
  sectionId: bigint;
  mode: AttendanceMode;
  enrolmentId: bigint;
  studentId: bigint;
  date: Date;
  period: number;
  status: AttendanceStatus;
  arrivedAt: string | null;
  note: string | null;
  /** At least one attendance_mark_changes row exists. */
  amended: boolean;
}

/** The complete intended mark of one submit item (decision 7). */
export interface MarkWrite {
  enrolmentId: bigint;
  status: AttendanceStatus;
  note: string | null;
  arrivedAt: string | null;
}

/** One recorded period of a child's day, across every register and enrolment of the date. */
export interface ChildPeriod {
  markId: bigint;
  registerId: bigint;
  enrolmentId: bigint;
  sectionId: bigint;
  period: number;
  status: AttendanceStatus;
  arrivedAt: string | null;
}

export interface MarkChangeRecord {
  id: bigint;
  markId: bigint;
  fromStatus: AttendanceStatus;
  toStatus: AttendanceStatus;
  noteChanged: boolean;
  fromArrivedAt: string | null;
  toArrivedAt: string | null;
  changedBy: bigint;
  changedByName: string | null;
  changedAt: Date;
  reason: string;
}

interface RawMark {
  id: bigint;
  register_id: bigint;
  section_id: bigint;
  mode: string;
  enrolment_id: bigint;
  student_id: bigint;
  date: Date;
  period: number;
  status: string;
  arrived_at: string | null;
  note: string | null;
  amended: boolean;
}

const MARK_COLUMNS = Prisma.sql`m.id, m.register_id, r.section_id, r.mode::text AS mode, m.enrolment_id, e.student_id, m.date, m.period,
  m.status::text AS status, ${timeText(Prisma.sql`m.arrived_at`)} AS arrived_at, m.note,
  EXISTS (SELECT 1 FROM attendance_mark_changes c
           WHERE c.school_id = m.school_id AND c.mark_id = m.id) AS amended`;

const MARK_FROM = Prisma.sql`attendance_marks m
  JOIN attendance_registers r ON r.school_id = m.school_id AND r.id = m.register_id
  JOIN enrolments e ON e.school_id = m.school_id AND e.id = m.enrolment_id`;

const toMark = (r: RawMark): MarkRecord => ({
  id: r.id,
  registerId: r.register_id,
  sectionId: r.section_id,
  mode: oneOf(ATTENDANCE_MODES, r.mode),
  enrolmentId: r.enrolment_id,
  studentId: r.student_id,
  date: r.date,
  period: Number(r.period),
  status: oneOf(ATTENDANCE_STATUSES, r.status),
  arrivedAt: r.arrived_at,
  note: r.note,
  amended: r.amended,
});

export type MarkChangeSort = '-changedAt' | 'changedAt';

@Injectable()
export class AttendanceMarkRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Every mark of a register, by enrolment id. */
  async listForRegister(schoolId: SchoolId, registerId: bigint): Promise<MarkRecord[]> {
    const rows = await this.txHost.tx.$queryRaw<RawMark[]>`
      SELECT ${MARK_COLUMNS} FROM ${MARK_FROM}
       WHERE m.school_id = ${schoolId} AND m.register_id = ${registerId}
       ORDER BY m.enrolment_id`;
    return rows.map(toMark);
  }

  /** One mark by id; null when not in the school. */
  async findById(schoolId: SchoolId, id: bigint): Promise<MarkRecord | null> {
    const rows = await this.txHost.tx.$queryRaw<RawMark[]>`
      SELECT ${MARK_COLUMNS} FROM ${MARK_FROM} WHERE m.school_id = ${schoolId} AND m.id = ${id}`;
    const row = rows[0];
    return row ? toMark(row) : null;
  }

  /** One mark, locked FOR UPDATE (after its register, §1.6). */
  async lock(schoolId: SchoolId, id: bigint): Promise<MarkRecord | null> {
    const rows = await this.txHost.tx.$queryRaw<RawMark[]>`
      SELECT ${MARK_COLUMNS} FROM ${MARK_FROM}
       WHERE m.school_id = ${schoolId} AND m.id = ${id}
         FOR UPDATE OF m`;
    const row = rows[0];
    return row ? toMark(row) : null;
  }

  /**
   * §4.2 step 9: one statement over the items, ordered by enrolment id. A row whose status, note
   * and arrival are unchanged is not updated, so the history trigger writes only real changes and
   * the summary trigger bumps once per statement. The register must be locked by the caller.
   */
  async upsertForRegister(
    schoolId: SchoolId,
    register: { id: bigint; date: Date; period: number },
    items: readonly MarkWrite[],
  ): Promise<void> {
    if (items.length === 0) return;
    const ordered = [...items].sort((a, b) =>
      a.enrolmentId < b.enrolmentId ? -1 : a.enrolmentId > b.enrolmentId ? 1 : 0,
    );
    const d = sqlDate(register.date);
    const values = ordered.map(
      (item) => Prisma.sql`(${schoolId}, ${register.id}, ${item.enrolmentId}, ${d}, ${register.period},
        ${item.status}::attendance_status, ${item.note}::varchar, ${sqlTime(item.arrivedAt)})`,
    );
    await this.txHost.tx.$executeRaw`
      INSERT INTO attendance_marks AS m
        (school_id, register_id, enrolment_id, date, period, status, note, arrived_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT ON CONSTRAINT attendance_marks_natural_key DO UPDATE
        SET status = EXCLUDED.status, note = EXCLUDED.note, arrived_at = EXCLUDED.arrived_at
      WHERE (m.status, m.note, m.arrived_at)
            IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.note, EXCLUDED.arrived_at)`;
  }

  /** §4.3, §4.4: one mark's status, note and arrival (the trigger records the change). */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: { status: AttendanceStatus; note: string | null; arrivedAt: string | null },
  ): Promise<void> {
    await this.txHost.tx.$executeRaw`
      UPDATE attendance_marks
         SET status = ${data.status}::attendance_status, note = ${data.note}::varchar,
             arrived_at = ${sqlTime(data.arrivedAt)}
       WHERE school_id = ${schoolId} AND id = ${id}`;
  }

  /**
   * Every recorded period of each child on a date, across every register and enrolment of that
   * date (§6.2 step 2, §4.4), ascending by period. Children with nothing recorded are absent.
   */
  async childDays(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    date: Date,
  ): Promise<Map<bigint, ChildPeriod[]>> {
    const days = new Map<bigint, ChildPeriod[]>();
    if (studentIds.length === 0) return days;
    const rows = await this.txHost.tx.$queryRaw<
      {
        id: bigint;
        register_id: bigint;
        enrolment_id: bigint;
        student_id: bigint;
        section_id: bigint;
        period: number;
        status: string;
        arrived_at: string | null;
      }[]
    >`
      SELECT m.id, m.register_id, m.enrolment_id, e.student_id, e.section_id, m.period,
             m.status::text AS status, ${timeText(Prisma.sql`m.arrived_at`)} AS arrived_at
        FROM ${MARK_FROM}
       WHERE m.school_id = ${schoolId} AND e.student_id IN (${Prisma.join([...studentIds])})
         AND m.date = ${sqlDate(date)}
       ORDER BY e.student_id ASC, m.period ASC, m.id ASC`;
    for (const r of rows) {
      const list = days.get(r.student_id) ?? [];
      list.push({
        markId: r.id,
        registerId: r.register_id,
        enrolmentId: r.enrolment_id,
        sectionId: r.section_id,
        period: Number(r.period),
        status: oneOf(ATTENDANCE_STATUSES, r.status),
        arrivedAt: r.arrived_at,
      });
      days.set(r.student_id, list);
    }
    return days;
  }

  /**
   * Every recorded period of a student in a date range (the student attendance `days[].periods`);
   * none when the student is outside the caller's scope.
   */
  async periodsForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    from: Date,
    to: Date,
  ): Promise<{ date: Date; period: number; status: AttendanceStatus; arrivedAt: string | null }[]> {
    const rows = await this.txHost.tx.$queryRaw<
      { date: Date; period: number; status: string; arrived_at: string | null }[]
    >`
      SELECT m.date, m.period, m.status::text AS status,
             ${timeText(Prisma.sql`m.arrived_at`)} AS arrived_at
        FROM ${MARK_FROM}
       WHERE m.school_id = ${schoolId} AND e.student_id = ${studentId}
         AND ${studentInScopeSql(scope, Prisma.sql`e.school_id`, Prisma.sql`e.student_id`)}
         AND m.date BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
       ORDER BY m.date ASC, m.period ASC, m.id ASC`;
    return rows.map((r) => ({
      date: r.date,
      period: Number(r.period),
      status: oneOf(ATTENDANCE_STATUSES, r.status),
      arrivedAt: r.arrived_at,
    }));
  }

  /** The gate's record (R168): append-only. */
  async insertArrival(
    schoolId: SchoolId,
    markId: bigint,
    arrivedAt: string,
    recordedBy: bigint,
    recordedAt: Date,
  ): Promise<void> {
    await this.txHost.tx.$executeRaw`
      INSERT INTO attendance_arrivals (school_id, mark_id, arrived_at, recorded_by, recorded_at)
      VALUES (${schoolId}, ${markId}, ${sqlTime(arrivedAt)}, ${recordedBy}, ${recordedAt})`;
  }

  /** An arrival row for the mark at exactly this time exists (the arrival replay, §4.4). */
  async hasArrival(schoolId: SchoolId, markId: bigint, arrivedAt: string): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM attendance_arrivals
       WHERE school_id = ${schoolId} AND mark_id = ${markId} AND arrived_at = ${sqlTime(arrivedAt)}
       LIMIT 1`;
    return rows.length > 0;
  }

  /** §4.5: a page of a mark's history with the changer's staff name, and the total. */
  async changes(
    schoolId: SchoolId,
    markId: bigint,
    sort: MarkChangeSort,
    skip: number,
    take: number,
  ): Promise<{ rows: MarkChangeRecord[]; total: number }> {
    const order =
      sort === 'changedAt'
        ? Prisma.sql`c.changed_at ASC, c.id ASC`
        : Prisma.sql`c.changed_at DESC, c.id DESC`;
    const rows = await this.txHost.tx.$queryRaw<
      {
        id: bigint;
        mark_id: bigint;
        old_status: string;
        new_status: string;
        note_changed: boolean;
        old_arrived_at: string | null;
        new_arrived_at: string | null;
        changed_by: bigint;
        changed_by_name: string | null;
        changed_at: Date;
        reason: string;
      }[]
    >`
      SELECT c.id, c.mark_id, c.old_status::text AS old_status, c.new_status::text AS new_status,
             (c.old_note IS DISTINCT FROM c.new_note) AS note_changed,
             ${timeText(Prisma.sql`c.old_arrived_at`)} AS old_arrived_at,
             ${timeText(Prisma.sql`c.new_arrived_at`)} AS new_arrived_at,
             c.changed_by,
             (SELECT sf.full_name FROM users u
                JOIN staff sf ON sf.school_id = u.school_id AND sf.id = u.staff_id
               WHERE u.school_id = c.school_id AND u.id = c.changed_by) AS changed_by_name,
             c.changed_at, c.reason
        FROM attendance_mark_changes c
       WHERE c.school_id = ${schoolId} AND c.mark_id = ${markId}
       ORDER BY ${order}
       LIMIT ${take} OFFSET ${skip}`;
    const total = await this.txHost.tx.attendanceMarkChange.count({ where: { schoolId, markId } });
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        markId: r.mark_id,
        fromStatus: oneOf(ATTENDANCE_STATUSES, r.old_status),
        toStatus: oneOf(ATTENDANCE_STATUSES, r.new_status),
        noteChanged: r.note_changed,
        fromArrivedAt: r.old_arrived_at,
        toArrivedAt: r.new_arrived_at,
        changedBy: r.changed_by,
        changedByName: r.changed_by_name,
        changedAt: r.changed_at,
        reason: r.reason,
      })),
    };
  }

  /** §9.1: the latest date with a recorded mark on the enrolment (the natural key serves it). */
  async lastRecordedOn(schoolId: SchoolId, enrolmentId: bigint): Promise<Date | null> {
    const row = await this.txHost.tx.attendanceMark.aggregate({
      where: { schoolId, enrolmentId },
      _max: { date: true },
    });
    return row._max.date;
  }
}
