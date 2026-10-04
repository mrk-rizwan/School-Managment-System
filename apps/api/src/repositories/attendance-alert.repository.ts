import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ATTENDANCE_ALERT_CANCEL_REASONS,
  ATTENDANCE_ALERT_KINDS,
  ATTENDANCE_ALERT_STATUSES,
  type AttendanceAlertCancelReason,
  type AttendanceAlertKind,
  type AttendanceAlertStatus,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { oneOf, sqlDate } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScopeOn } from './student.repository';

// contracts/slice-11.md §6, §7: attendance_alerts, the subject of every outbound attendance
// message. The writer creates and cancels rows; the processor claims one and marks it sent or
// cancelled; the holiday listener cancels pending rows. Locks are FOR UPDATE in id order (raw
// SQL); every statement filters school_id (test/attendance/repositories.e2e-spec.ts). Listed in
// RAW_SQL_FILES.

export interface AlertRecord {
  id: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  date: Date;
  kind: AttendanceAlertKind;
  seq: number;
  dueAt: Date;
  status: AttendanceAlertStatus;
  cancelReason: AttendanceAlertCancelReason | null;
  updatedAt: Date;
  /** Set when a fourth row of this kind for the child-day was due and refused (§6.2). */
  cappedAt: Date | null;
}

export interface NewAlert {
  enrolmentId: bigint;
  studentId: bigint;
  date: Date;
  kind: AttendanceAlertKind;
  seq: number;
  dueAt: Date;
  /** `pending`, or `cancelled` with a reason (a backdated row, or the processor's late advice as `sent`). */
  status: AttendanceAlertStatus;
  cancelReason: AttendanceAlertCancelReason | null;
}

interface RawAlert {
  id: bigint;
  enrolment_id: bigint;
  student_id: bigint;
  date: Date;
  kind: string;
  seq: number;
  due_at: Date;
  status: string;
  cancel_reason: string | null;
  updated_at: Date;
  capped_at: Date | null;
}

const ALERT_COLUMNS = Prisma.sql`a.id, a.enrolment_id, a.student_id, a.date, a.kind::text AS kind, a.seq,
  a.due_at, a.status::text AS status, a.cancel_reason::text AS cancel_reason, a.updated_at, a.capped_at`;

const toAlert = (r: RawAlert): AlertRecord => ({
  id: r.id,
  enrolmentId: r.enrolment_id,
  studentId: r.student_id,
  date: r.date,
  kind: oneOf(ATTENDANCE_ALERT_KINDS, r.kind),
  seq: Number(r.seq),
  dueAt: r.due_at,
  status: oneOf(ATTENDANCE_ALERT_STATUSES, r.status),
  cancelReason:
    r.cancel_reason === null ? null : oneOf(ATTENDANCE_ALERT_CANCEL_REASONS, r.cancel_reason),
  updatedAt: r.updated_at,
  cappedAt: r.capped_at,
});

const SELECT = {
  id: true,
  enrolmentId: true,
  studentId: true,
  date: true,
  kind: true,
  seq: true,
  dueAt: true,
  status: true,
  cancelReason: true,
  updatedAt: true,
  cappedAt: true,
} as const satisfies Prisma.AttendanceAlertSelect;

/** What the processor needs to address and word a message about a child. */
export interface AlertSubject {
  studentName: string;
  className: string;
  sectionName: string;
}

@Injectable()
export class AttendanceAlertRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * §6.2 step 1 for several children of one date: every alert row of each child-day, FOR UPDATE
   * in (student id, id) order — the per-child id order of the contract, children ascending.
   */
  async lockChildDays(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    date: Date,
  ): Promise<AlertRecord[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<RawAlert[]>`
      SELECT ${ALERT_COLUMNS} FROM attendance_alerts a
       WHERE a.school_id = ${schoolId} AND a.student_id IN (${Prisma.join([...studentIds])})
         AND a.date = ${sqlDate(date)}
       ORDER BY a.student_id, a.id
         FOR UPDATE`;
    return rows.map(toAlert);
  }

  /** One alert, unlocked (the processor then locks its whole child-day, §6.4 step 1). */
  async findById(schoolId: SchoolId, id: bigint): Promise<AlertRecord | null> {
    return this.txHost.tx.attendanceAlert.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  async insert(schoolId: SchoolId, data: NewAlert, now: Date): Promise<AlertRecord> {
    return this.txHost.tx.attendanceAlert.create({
      data: { schoolId, ...data, createdAt: now, updatedAt: now },
      select: SELECT,
    });
  }

  /** pending → sent or cancelled (both final by trigger). The row is locked by the caller. */
  async resolve(
    schoolId: SchoolId,
    id: bigint,
    to: { status: 'sent' } | { status: 'cancelled'; reason: AttendanceAlertCancelReason },
    now: Date,
  ): Promise<void> {
    await this.txHost.tx.attendanceAlert.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: {
        status: to.status,
        cancelReason: to.status === 'cancelled' ? to.reason : null,
        updatedAt: now,
      },
    });
  }

  /**
   * §6.2: a fourth row of this row's kind was due and refused. Written once (the trigger refuses
   * a second value), the one change a sent or cancelled row accepts. The row is locked by the
   * caller.
   */
  async markCapped(schoolId: SchoolId, id: bigint, now: Date): Promise<void> {
    await this.txHost.tx.attendanceAlert.updateMany({
      where: { schoolId, id, cappedAt: null },
      data: { cappedAt: now },
    });
  }

  /**
   * §7: every pending alert dated inside the range, locked in id order and cancelled as
   * `holiday`. Returns how many.
   */
  async cancelPendingForHoliday(schoolId: SchoolId, from: Date, to: Date, now: Date): Promise<number> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT a.id FROM attendance_alerts a
       WHERE a.school_id = ${schoolId} AND a.status = 'pending'
         AND a.date BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
       ORDER BY a.id
         FOR UPDATE`;
    if (rows.length === 0) return 0;
    const { count } = await this.txHost.tx.attendanceAlert.updateMany({
      where: { schoolId, id: { in: rows.map((r) => r.id) }, status: 'pending' },
      data: { status: 'cancelled', cancelReason: 'holiday', updatedAt: now },
    });
    return count;
  }

  /** §8.3: pending rows due before `before`, oldest first (the outbox sweep's attendance source). */
  async listDue(schoolId: SchoolId, before: Date, limit: number): Promise<bigint[]> {
    const rows = await this.txHost.tx.attendanceAlert.findMany({
      where: { schoolId, status: 'pending', dueAt: { lte: before } },
      select: { id: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  /**
   * Every alert row of the given children on the date (the roster and the reports), for the
   * children inside `scope` on that date: `rowScope` of the register's dated scope, or the
   * reports' school-wide scope.
   */
  async listForChildDays(
    schoolId: SchoolId,
    scope: Scope,
    studentIds: readonly bigint[],
    date: Date,
  ): Promise<AlertRecord[]> {
    if (studentIds.length === 0) return [];
    return this.txHost.tx.attendanceAlert.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        date,
        enrolment: { is: { student: { is: studentInScopeOn(scope, date) } } },
      },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /**
   * §6.3, resolved at send time: guardians of the child through live links, not merged; the
   * primary contacts, else every one with a login or a phone. Ascending ids.
   */
  async recipients(schoolId: SchoolId, studentId: bigint): Promise<bigint[]> {
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, studentId, endedAt: null },
      select: { guardianId: true, isPrimaryContact: true, canLogin: true },
      orderBy: { guardianId: 'asc' },
    });
    if (links.length === 0) return [];
    const guardians = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: links.map((l) => l.guardianId) }, mergedIntoId: null },
      select: { id: true, phone: true },
    });
    const live = new Map(guardians.map((g) => [g.id, g]));
    const eligible = links.filter((l) => live.has(l.guardianId));
    const primary = eligible.filter((l) => l.isPrimaryContact);
    const chosen =
      primary.length > 0
        ? primary
        : eligible.filter((l) => l.canLogin || (live.get(l.guardianId)?.phone ?? null) !== null);
    return [...new Set(chosen.map((l) => l.guardianId))];
  }

  /** The child's name and the enrolment's class and section names (template vars). */
  async subject(schoolId: SchoolId, enrolmentId: bigint): Promise<AlertSubject | null> {
    const rows = await this.txHost.tx.$queryRaw<
      { full_name: string; class_name: string; section_name: string }[]
    >`
      SELECT st.full_name, c.name AS class_name, s.name AS section_name
        FROM enrolments e
        JOIN students st ON st.school_id = e.school_id AND st.id = e.student_id
        JOIN classes c ON c.school_id = e.school_id AND c.id = e.class_id
        JOIN sections s ON s.school_id = e.school_id AND s.id = e.section_id
       WHERE e.school_id = ${schoolId} AND e.id = ${enrolmentId}`;
    const row = rows[0];
    return row
      ? { studentName: row.full_name, className: row.class_name, sectionName: row.section_name }
      : null;
  }
}
