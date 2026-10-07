import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ContactCapability, MessageChannel, MessagePriority } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { sqlDate } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import { userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// Slice 22 (phase-3-financial.md slice 22, §0.20, §7.2; R201-R205, R228, R250): the finance
// reports, the fee-reminder families and the dues clearance's reads. Read-only: nothing here
// writes. Outstanding is always `amount - allocated_amount - credited_amount` read from the
// counters the triggers keep (rule 0.22, R203); nothing re-sums allocations. Every statement
// filters school_id on every table it reads (test/finance-reports/isolation.e2e-spec.ts). Listed
// in RAW_SQL_FILES.

const OWED = Prisma.sql`(c.amount - c.allocated_amount - c.credited_amount)`;

// ------------------------------------------------------------------------------ defaulters

export type DefaulterSort = '-outstanding' | 'studentName' | 'className' | 'oldestDueOn' | '-oldestDueOn';

export interface DefaulterQuery {
  today: Date;
  classId?: bigint;
  sectionId?: bigint;
  minOutstanding?: number;
  overdueOnly: boolean;
  sort: DefaulterSort;
  skip: number;
  take: number;
}

export interface DefaulterRow {
  studentId: bigint;
  studentName: string;
  admissionNo: string;
  className: string | null;
  sectionName: string | null;
  outstanding: number;
  overdue: number;
  oldestDueOn: Date;
  openCharges: number;
}

export interface DefaulterExtras {
  studentId: bigint;
  feePayerName: string | null;
  feePayerCapability: ContactCapability | null;
  lastPaymentOn: Date | null;
  lastReminderAt: Date | null;
  pendingClaim: boolean;
}

function defaulterOrder(sort: DefaulterSort): Prisma.Sql {
  switch (sort) {
    case '-outstanding':
      return Prisma.sql`outstanding DESC, student_name ASC, student_id ASC`;
    case 'studentName':
      return Prisma.sql`student_name ASC, student_id ASC`;
    case 'className':
      return Prisma.sql`class_order ASC NULLS LAST, class_name ASC NULLS LAST, section_name ASC NULLS LAST, student_name ASC, student_id ASC`;
    case 'oldestDueOn':
      return Prisma.sql`oldest_due_on ASC, outstanding DESC, student_id ASC`;
    case '-oldestDueOn':
      return Prisma.sql`oldest_due_on DESC, outstanding DESC, student_id ASC`;
  }
}

// ----------------------------------------------------------------------------- collections

export type CollectionGroup = 'day' | 'method' | 'feeHead' | 'class' | 'collector';
export type CollectionBasis = 'received' | 'verified';

export interface CollectionWindow {
  basis: CollectionBasis;
  /** DATE values, inclusive. */
  from: Date;
  to: Date;
  /** The instants the window starts and ends (school time), for verified_at and created_at. */
  startsAt: Date;
  endsBefore: Date;
  timezone: string;
}

export interface GroupRow {
  key: string;
  label: string;
  amount: number;
  count: number;
}

export interface AmountCount {
  amount: number;
  count: number;
}

export interface CollectionTotals {
  total: AmountCount;
  voided: AmountCount;
  refunds: AmountCount;
  refundReversals: AmountCount;
  carriedForward: AmountCount;
}

// ------------------------------------------------------------------------------ daily cash

export interface DailyCashFacts {
  cashReceived: number;
  voidedBeforeHandover: number;
  voidedAfterHandover: number;
  withCollectors: { userId: bigint; amount: number; since: Date }[];
  handedOver: {
    handoverId: bigint;
    status: string;
    collectorUserId: bigint;
    confirmedBy: bigint | null;
    expected: number;
    counted: number | null;
    shortfall: number | null;
    surplus: number | null;
    shortfallResolution: string | null;
    fromDay: number;
  }[];
  refundsPaidCash: number;
  cashExpenses: number;
  shortfallWrittenOff: number;
  salariesPaidCash: number;
}

// ------------------------------------------------------------------------------- reminders

/** One fee-paying link of a child who owes something (the reminder's families, R201, R202). */
export interface ReminderLinkRow {
  guardianId: bigint;
  studentId: bigint;
  studentName: string;
  outstanding: number;
  overdue: number;
  oldestOverdue: Date | null;
  nextDue: Date | null;
  pendingClaims: number;
}

export interface ReminderMessageRow {
  guardianId: bigint;
  type: 'fee_due_reminder' | 'fee_overdue';
  subjectId: bigint;
  createdAt: Date;
}

@Injectable()
export class FinanceReportRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Users' display names (the collectors and confirmers of the daily cash, an override's actor). */
  userNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, ids);
  }

  // ---------------------------------------------------------------------------- defaulters

  /**
   * R203: one row per student with open charges, aggregated from charges_open_by_student_idx (the
   * covering partial index: amount, allocated, credited and due date are in it), with the
   * student's latest enrolment for the class columns and filters; a page of it, sorted.
   */
  async defaulters(schoolId: SchoolId, q: DefaulterQuery): Promise<{ rows: DefaulterRow[]; total: number }> {
    const filters: Prisma.Sql[] = [];
    if (q.classId !== undefined) filters.push(Prisma.sql`cur.class_id = ${q.classId}`);
    if (q.sectionId !== undefined) filters.push(Prisma.sql`cur.section_id = ${q.sectionId}`);
    if (q.minOutstanding !== undefined) filters.push(Prisma.sql`o.outstanding >= ${q.minOutstanding}`);
    if (q.overdueOnly) filters.push(Prisma.sql`o.overdue > 0`);
    const rows = await this.txHost.tx.$queryRaw<
      {
        student_id: bigint;
        student_name: string;
        admission_no: string;
        class_name: string | null;
        section_name: string | null;
        outstanding: number;
        overdue: number;
        oldest_due_on: Date;
        open_charges: number;
        total: number;
      }[]
    >`
      WITH o AS (
        SELECT c.student_id,
               SUM(${OWED})::int AS outstanding,
               COALESCE(SUM(${OWED}) FILTER (WHERE c.due_on < ${sqlDate(q.today)}), 0)::int AS overdue,
               MIN(c.due_on) AS oldest_due_on,
               COUNT(*)::int AS open_charges
          FROM charges c
         WHERE c.school_id = ${schoolId} AND c.status = 'open'
         GROUP BY c.student_id
      ), cur AS (
        SELECT DISTINCT ON (e.student_id) e.student_id, e.class_id, e.section_id
          FROM enrolments e
         WHERE e.school_id = ${schoolId} AND e.student_id IN (SELECT student_id FROM o)
         ORDER BY e.student_id, e.started_on DESC, e.id DESC
      ), listed AS (
        SELECT o.student_id, s.full_name AS student_name, s.admission_no, cl.name AS class_name,
               cl.sort_order AS class_order, se.name AS section_name, o.outstanding, o.overdue,
               o.oldest_due_on, o.open_charges
          FROM o
          JOIN students s ON s.school_id = ${schoolId} AND s.id = o.student_id
          LEFT JOIN cur ON cur.student_id = o.student_id
          LEFT JOIN classes cl ON cl.school_id = ${schoolId} AND cl.id = cur.class_id
          LEFT JOIN sections se ON se.school_id = ${schoolId} AND se.id = cur.section_id
         WHERE o.outstanding > 0
           ${filters.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(filters, ' AND ')}`}
      )
      SELECT listed.*, (COUNT(*) OVER ())::int AS total
        FROM listed
       ORDER BY ${defaulterOrder(q.sort)}
       LIMIT ${q.take} OFFSET ${q.skip}`;
    if (rows.length === 0 && q.skip > 0) {
      // A page past the end still reports the total.
      const [count] = await this.txHost.tx.$queryRaw<{ total: number }[]>`
        SELECT COUNT(*)::int AS total FROM (
          SELECT c.student_id FROM charges c
            LEFT JOIN LATERAL (
              SELECT e.class_id, e.section_id FROM enrolments e
               WHERE e.school_id = ${schoolId} AND e.student_id = c.student_id
               ORDER BY e.started_on DESC, e.id DESC LIMIT 1) cur ON TRUE
           WHERE c.school_id = ${schoolId} AND c.status = 'open'
             ${q.classId === undefined ? Prisma.empty : Prisma.sql`AND cur.class_id = ${q.classId}`}
             ${q.sectionId === undefined ? Prisma.empty : Prisma.sql`AND cur.section_id = ${q.sectionId}`}
           GROUP BY c.student_id
          HAVING SUM(${OWED}) >= ${q.minOutstanding ?? 1}
             ${q.overdueOnly ? Prisma.sql`AND COUNT(*) FILTER (WHERE c.due_on < ${sqlDate(q.today)}) > 0` : Prisma.empty}
        ) t`;
      return { rows: [], total: count?.total ?? 0 };
    }
    return {
      rows: rows.map((r) => ({
        studentId: r.student_id,
        studentName: r.student_name,
        admissionNo: r.admission_no,
        className: r.class_name,
        sectionName: r.section_name,
        outstanding: r.outstanding,
        overdue: r.overdue,
        oldestDueOn: r.oldest_due_on,
        openCharges: r.open_charges,
      })),
      total: rows[0]?.total ?? 0,
    };
  }

  /**
   * The rest of a defaulter row, for one page of students: the first live fee-paying guardian
   * (primary contact first), the last verified payment that reached the child, the last fee
   * reminder sent to any of the child's fee payers, and whether a claim is pending.
   */
  async defaulterExtras(schoolId: SchoolId, studentIds: readonly bigint[]): Promise<DefaulterExtras[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<
      {
        student_id: bigint;
        fee_payer_name: string | null;
        fee_payer_capability: ContactCapability | null;
        last_payment_on: Date | null;
        last_reminder_at: Date | null;
        pending_claim: boolean;
      }[]
    >`
      SELECT s.id AS student_id,
             fp.full_name AS fee_payer_name,
             fp.contact_capability::text AS fee_payer_capability,
             (SELECT MAX(p.received_on) FROM payment_allocations pa
                JOIN payments p ON p.school_id = pa.school_id AND p.id = pa.payment_id
               WHERE pa.school_id = ${schoolId} AND pa.student_id = s.id AND p.status = 'verified') AS last_payment_on,
             (SELECT MAX(m.created_at) FROM student_guardians sg
                JOIN messages m ON m.school_id = sg.school_id AND m.guardian_id = sg.guardian_id
               WHERE sg.school_id = ${schoolId} AND sg.student_id = s.id AND sg.ended_at IS NULL AND sg.is_fee_payer
                 AND m.subject_type = 'fee_reminder' AND m.type IN ('fee_due_reminder', 'fee_overdue')) AS last_reminder_at,
             EXISTS (SELECT 1 FROM payment_claims pc
                      WHERE pc.school_id = ${schoolId} AND pc.student_id = s.id AND pc.status = 'pending') AS pending_claim
        FROM students s
        LEFT JOIN LATERAL (
          SELECT g.full_name, g.contact_capability FROM student_guardians sg
            JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id AND g.merged_into_id IS NULL
           WHERE sg.school_id = ${schoolId} AND sg.student_id = s.id AND sg.ended_at IS NULL AND sg.is_fee_payer
           ORDER BY sg.is_primary_contact DESC, sg.id ASC LIMIT 1) fp ON TRUE
       WHERE s.school_id = ${schoolId} AND s.id IN (${Prisma.join([...studentIds])})`;
    return rows.map((r) => ({
      studentId: r.student_id,
      feePayerName: r.fee_payer_name,
      feePayerCapability: r.fee_payer_capability,
      lastPaymentOn: r.last_payment_on,
      lastReminderAt: r.last_reminder_at,
      pendingClaim: r.pending_claim,
    }));
  }

  // --------------------------------------------------------------------------- collections

  /** The basis date of a payment (rule 25, R205): received_on, or verified_at's school day. */
  private basisDate(w: CollectionWindow): Prisma.Sql {
    return w.basis === 'received' ? Prisma.sql`p.received_on` : Prisma.sql`(p.verified_at AT TIME ZONE ${w.timezone})::date`;
  }

  private basisRange(w: CollectionWindow): Prisma.Sql {
    return w.basis === 'received'
      ? Prisma.sql`p.received_on BETWEEN ${sqlDate(w.from)} AND ${sqlDate(w.to)}`
      : Prisma.sql`p.verified_at >= ${w.startsAt} AND p.verified_at < ${w.endsBefore}`;
  }

  /**
   * Collections grouped (§0.20): non-voided receipts only, so a claim (no payment yet) and a
   * carried-forward payment (no receipt) are never here. feeHead and class read the receipt's
   * lines (the advance line is its own row); the others read the payment.
   */
  async collections(schoolId: SchoolId, w: CollectionWindow, group: CollectionGroup): Promise<GroupRow[]> {
    const paid = Prisma.sql`
      FROM payments p
      JOIN receipts r ON r.school_id = p.school_id AND r.payment_id = p.id
     WHERE p.school_id = ${schoolId} AND p.status = 'verified' AND p.method <> 'carried_forward'
       AND ${this.basisRange(w)}`;
    let rows: { key: string; label: string; amount: number; count: number }[];
    switch (group) {
      case 'day':
        rows = await this.txHost.tx.$queryRaw`
          SELECT to_char(${this.basisDate(w)}, 'YYYY-MM-DD') AS key, to_char(${this.basisDate(w)}, 'YYYY-MM-DD') AS label,
                 SUM(p.amount)::int AS amount, COUNT(*)::int AS count
            ${paid}
           GROUP BY 1, 2 ORDER BY 1`;
        break;
      case 'method':
        rows = await this.txHost.tx.$queryRaw`
          SELECT p.method::text AS key, p.method::text AS label, SUM(p.amount)::int AS amount, COUNT(*)::int AS count
            ${paid}
           GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
        break;
      case 'collector':
        rows = await this.txHost.tx.$queryRaw`
          SELECT p.recorded_by::text AS key, COALESCE(st.full_name, g.full_name, 'Unknown') AS label,
                 SUM(p.amount)::int AS amount, COUNT(*)::int AS count
            FROM payments p
            JOIN receipts r ON r.school_id = p.school_id AND r.payment_id = p.id
            JOIN users u ON u.school_id = p.school_id AND u.id = p.recorded_by
            LEFT JOIN staff st ON st.school_id = u.school_id AND st.id = u.staff_id
            LEFT JOIN guardians g ON g.school_id = u.school_id AND g.id = u.guardian_id
           WHERE p.school_id = ${schoolId} AND p.status = 'verified' AND p.method <> 'carried_forward'
             AND ${this.basisRange(w)}
           GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
        break;
      case 'feeHead':
        rows = await this.txHost.tx.$queryRaw`
          SELECT COALESCE(rl.fee_head_name, 'Advance') AS key, COALESCE(rl.fee_head_name, 'Advance') AS label,
                 SUM(rl.amount)::int AS amount, COUNT(DISTINCT p.id)::int AS count
            FROM payments p
            JOIN receipts r ON r.school_id = p.school_id AND r.payment_id = p.id
            JOIN receipt_lines rl ON rl.school_id = r.school_id AND rl.receipt_id = r.id
           WHERE p.school_id = ${schoolId} AND p.status = 'verified' AND p.method <> 'carried_forward'
             AND ${this.basisRange(w)}
           GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
        break;
      case 'class':
        // Each line's class is the child's latest enrolment in the line's year, looked up once per
        // child and year (enrolments_school_id_student_id_academic_year_id_idx), not once per line:
        // 0.46 s -> 0.24 s at 75,000 lines (phase close, 2026-10-07).
        rows = await this.txHost.tx.$queryRaw`
          WITH lines AS (
            SELECT p.id AS payment_id, rl.student_id, rl.academic_year_id, rl.amount
              FROM payments p
              JOIN receipts r ON r.school_id = p.school_id AND r.payment_id = p.id
              JOIN receipt_lines rl ON rl.school_id = r.school_id AND rl.receipt_id = r.id
             WHERE p.school_id = ${schoolId} AND p.status = 'verified' AND p.method <> 'carried_forward'
               AND ${this.basisRange(w)}
          ), cur AS (
            SELECT DISTINCT ON (e.student_id, e.academic_year_id) e.student_id, e.academic_year_id, e.class_id
              FROM enrolments e
             WHERE e.school_id = ${schoolId}
               AND (e.student_id, e.academic_year_id) IN (SELECT student_id, academic_year_id FROM lines)
             ORDER BY e.student_id, e.academic_year_id, e.started_on DESC, e.id DESC
          )
          SELECT COALESCE(cl.id::text, 'none') AS key, COALESCE(cl.name, 'No class') AS label,
                 SUM(l.amount)::int AS amount, COUNT(DISTINCT l.payment_id)::int AS count
            FROM lines l
            LEFT JOIN cur ON cur.student_id = l.student_id AND cur.academic_year_id = l.academic_year_id
            LEFT JOIN classes cl ON cl.school_id = ${schoolId} AND cl.id = cur.class_id
           GROUP BY 1, 2, cl.sort_order ORDER BY cl.sort_order NULLS LAST, 2`;
        break;
    }
    return rows;
  }

  /**
   * The window's totals (R205, §0.20): collections, the voided receipts of the window (their own
   * line, never in the total), and refunds, refund reversals and carry-forwards made inside it
   * (dated by when they were made; never collections).
   */
  async collectionTotals(schoolId: SchoolId, w: CollectionWindow): Promise<CollectionTotals> {
    const [payments] = await this.txHost.tx.$queryRaw<
      { amount: number; count: number; voided_amount: number; voided_count: number }[]
    >`
      SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'verified'), 0)::int AS amount,
             (COUNT(*) FILTER (WHERE p.status = 'verified'))::int AS count,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'voided'), 0)::int AS voided_amount,
             (COUNT(*) FILTER (WHERE p.status = 'voided'))::int AS voided_count
        FROM payments p
        JOIN receipts r ON r.school_id = p.school_id AND r.payment_id = p.id
       WHERE p.school_id = ${schoolId} AND p.method <> 'carried_forward' AND ${this.basisRange(w)}`;
    const reversals = await this.txHost.tx.$queryRaw<{ kind: string; amount: number; count: number }[]>`
      SELECT pr.kind::text AS kind, SUM(pr.amount)::int AS amount, COUNT(*)::int AS count
        FROM payment_reversals pr
       WHERE pr.school_id = ${schoolId} AND pr.kind IN ('refund', 'refund_reversal', 'carried_forward')
         AND pr.created_at >= ${w.startsAt} AND pr.created_at < ${w.endsBefore}
       GROUP BY pr.kind`;
    const of = (kind: string): AmountCount => {
      const row = reversals.find((r) => r.kind === kind);
      return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
    };
    return {
      total: { amount: payments?.amount ?? 0, count: payments?.count ?? 0 },
      voided: { amount: payments?.voided_amount ?? 0, count: payments?.voided_count ?? 0 },
      refunds: of('refund'),
      refundReversals: of('refund_reversal'),
      carriedForward: of('carried_forward'),
    };
  }

  // --------------------------------------------------------------------------- outstanding

  /** Today's outstanding of one year's open charges (R228: Σ amount − allocated − credited). */
  async outstanding(
    schoolId: SchoolId,
    academicYearId: bigint,
    group: 'class' | 'feeHead' | 'period',
  ): Promise<GroupRow[]> {
    const open = Prisma.sql`c.school_id = ${schoolId} AND c.academic_year_id = ${academicYearId} AND c.status = 'open'`;
    switch (group) {
      case 'feeHead':
        return this.txHost.tx.$queryRaw`
          SELECT fh.id::text AS key, fh.name AS label, SUM(${OWED})::int AS amount, COUNT(*)::int AS count
            FROM charges c JOIN fee_heads fh ON fh.school_id = c.school_id AND fh.id = c.fee_head_id
           WHERE ${open}
           GROUP BY fh.id, fh.name ORDER BY 3 DESC, 2`;
      case 'period':
        return this.txHost.tx.$queryRaw`
          SELECT COALESCE(c.period, 'none') AS key, COALESCE(c.period, 'No period') AS label,
                 SUM(${OWED})::int AS amount, COUNT(*)::int AS count
            FROM charges c
           WHERE ${open}
           GROUP BY c.period ORDER BY c.period NULLS LAST`;
      case 'class':
        return this.txHost.tx.$queryRaw`
          SELECT cl.id::text AS key, cl.name AS label, SUM(${OWED})::int AS amount, COUNT(*)::int AS count
            FROM charges c
            JOIN enrolments e ON e.school_id = c.school_id AND e.id = c.enrolment_id
            JOIN classes cl ON cl.school_id = e.school_id AND cl.id = e.class_id
           WHERE ${open}
           GROUP BY cl.id, cl.name, cl.sort_order ORDER BY cl.sort_order, cl.name`;
    }
  }

  /** The year's credits (adjustment rows), the outstanding report's own line. */
  async adjustmentsTotal(schoolId: SchoolId, academicYearId: bigint): Promise<AmountCount> {
    const [row] = await this.txHost.tx.$queryRaw<{ amount: number; count: number }[]>`
      SELECT COALESCE(SUM(c.amount), 0)::int AS amount, COUNT(*)::int AS count
        FROM charges c
       WHERE c.school_id = ${schoolId} AND c.academic_year_id = ${academicYearId}
         AND c.kind = 'adjustment' AND c.status <> 'voided'`;
    return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
  }

  // ---------------------------------------------------------------------------- concessions

  /**
   * One year's concession reductions: the concession taken off each live charge at birth, plus
   * the credits a concession wrote on open charges (A6). `students` counts each student once.
   */
  async concessions(
    schoolId: SchoolId,
    academicYearId: bigint,
    group: 'feeHead' | 'class',
  ): Promise<(GroupRow & { students: number })[]> {
    const reductions = Prisma.sql`
      SELECT c.fee_head_id, c.enrolment_id, c.student_id, c.concession_amount AS reduction
        FROM charges c
       WHERE c.school_id = ${schoolId} AND c.academic_year_id = ${academicYearId}
         AND c.kind <> 'adjustment' AND c.status <> 'voided' AND c.concession_amount > 0
      UNION ALL
      SELECT c.fee_head_id, c.enrolment_id, c.student_id, c.amount AS reduction
        FROM charges c
       WHERE c.school_id = ${schoolId} AND c.academic_year_id = ${academicYearId}
         AND c.kind = 'adjustment' AND c.concession_id IS NOT NULL AND c.status <> 'voided'`;
    const rows =
      group === 'feeHead'
        ? await this.txHost.tx.$queryRaw<{ key: string; label: string; amount: number; count: number; students: number }[]>`
            SELECT fh.id::text AS key, fh.name AS label, SUM(x.reduction)::int AS amount, COUNT(*)::int AS count,
                   COUNT(DISTINCT x.student_id)::int AS students
              FROM (${reductions}) x
              JOIN fee_heads fh ON fh.school_id = ${schoolId} AND fh.id = x.fee_head_id
             GROUP BY fh.id, fh.name ORDER BY 3 DESC, 2`
        : await this.txHost.tx.$queryRaw<{ key: string; label: string; amount: number; count: number; students: number }[]>`
            SELECT cl.id::text AS key, cl.name AS label, SUM(x.reduction)::int AS amount, COUNT(*)::int AS count,
                   COUNT(DISTINCT x.student_id)::int AS students
              FROM (${reductions}) x
              JOIN enrolments e ON e.school_id = ${schoolId} AND e.id = x.enrolment_id
              JOIN classes cl ON cl.school_id = ${schoolId} AND cl.id = e.class_id
             GROUP BY cl.id, cl.name, cl.sort_order ORDER BY cl.sort_order, cl.name`;
    return rows;
  }

  // ------------------------------------------------------------------------------ expenses

  /** Recorded and approved expenses of the window, grouped. */
  async expenses(
    schoolId: SchoolId,
    from: Date,
    to: Date,
    group: 'category' | 'day' | 'method' | 'recorder',
  ): Promise<GroupRow[]> {
    const live = Prisma.sql`x.school_id = ${schoolId} AND x.status IN ('recorded', 'approved')
      AND x.spent_on BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}`;
    switch (group) {
      case 'category':
        return this.txHost.tx.$queryRaw`
          SELECT x.category::text AS key, x.category::text AS label, SUM(x.amount)::int AS amount, COUNT(*)::int AS count
            FROM expenses x WHERE ${live} GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
      case 'day':
        return this.txHost.tx.$queryRaw`
          SELECT to_char(x.spent_on, 'YYYY-MM-DD') AS key, to_char(x.spent_on, 'YYYY-MM-DD') AS label,
                 SUM(x.amount)::int AS amount, COUNT(*)::int AS count
            FROM expenses x WHERE ${live} GROUP BY 1, 2 ORDER BY 1`;
      case 'method':
        return this.txHost.tx.$queryRaw`
          SELECT x.method::text AS key, x.method::text AS label, SUM(x.amount)::int AS amount, COUNT(*)::int AS count
            FROM expenses x WHERE ${live} GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
      case 'recorder':
        return this.txHost.tx.$queryRaw`
          SELECT x.recorded_by::text AS key, COALESCE(st.full_name, 'Unknown') AS label,
                 SUM(x.amount)::int AS amount, COUNT(*)::int AS count
            FROM expenses x
            JOIN users u ON u.school_id = x.school_id AND u.id = x.recorded_by
            LEFT JOIN staff st ON st.school_id = u.school_id AND st.id = u.staff_id
           WHERE ${live} GROUP BY 1, 2 ORDER BY 3 DESC, 1`;
    }
  }

  /**
   * The window's pending approvals, and the sub-threshold expenses (status `recorded`: at or below
   * the threshold when recorded, R206, R208) per recorder.
   */
  async expenseSides(
    schoolId: SchoolId,
    from: Date,
    to: Date,
  ): Promise<{ pending: AmountCount; subThreshold: (AmountCount & { userId: bigint; name: string })[] }> {
    const window = Prisma.sql`x.school_id = ${schoolId} AND x.spent_on BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}`;
    const [pending] = await this.txHost.tx.$queryRaw<{ amount: number; count: number }[]>`
      SELECT COALESCE(SUM(x.amount), 0)::int AS amount, COUNT(*)::int AS count
        FROM expenses x WHERE ${window} AND x.status = 'pending_approval'`;
    const sub = await this.txHost.tx.$queryRaw<{ user_id: bigint; name: string; amount: number; count: number }[]>`
      SELECT x.recorded_by AS user_id, COALESCE(st.full_name, 'Unknown') AS name,
             SUM(x.amount)::int AS amount, COUNT(*)::int AS count
        FROM expenses x
        JOIN users u ON u.school_id = x.school_id AND u.id = x.recorded_by
        LEFT JOIN staff st ON st.school_id = u.school_id AND st.id = u.staff_id
       WHERE ${window} AND x.status = 'recorded'
       GROUP BY 1, 2 ORDER BY 3 DESC, 2`;
    return {
      pending: { amount: pending?.amount ?? 0, count: pending?.count ?? 0 },
      subThreshold: sub.map((r) => ({ userId: r.user_id, name: r.name, amount: r.amount, count: r.count })),
    };
  }

  // ------------------------------------------------------------------------------- payroll

  /** Finalised runs of the months, each summed over its payslips. */
  async payroll(
    schoolId: SchoolId,
    from: string,
    to: string,
  ): Promise<
    {
      yearMonth: string;
      staffCount: number;
      gross: number;
      deductions: number;
      adjustments: number;
      net: number;
      paid: number;
      unpaid: number;
    }[]
  > {
    const rows = await this.txHost.tx.$queryRaw<
      {
        year_month: string;
        staff_count: number;
        gross: number;
        deductions: number;
        adjustments: number;
        net: number;
        paid: number;
        unpaid: number;
      }[]
    >`
      SELECT r.year_month,
             COUNT(ps.id)::int AS staff_count,
             COALESCE(SUM(ps.basic + ps.allowances_total), 0)::int AS gross,
             COALESCE(SUM(ps.deductions_total + ps.absence_deduction + ps.advance_recovery), 0)::int AS deductions,
             COALESCE(SUM(ps.adjustment_total), 0)::int AS adjustments,
             COALESCE(SUM(ps.net), 0)::int AS net,
             COALESCE(SUM(ps.net) FILTER (WHERE ps.status = 'paid'), 0)::int AS paid,
             COALESCE(SUM(ps.net) FILTER (WHERE ps.status = 'pending'), 0)::int AS unpaid
        FROM payroll_runs r
        LEFT JOIN payslips ps ON ps.school_id = r.school_id AND ps.run_id = r.id
       WHERE r.school_id = ${schoolId} AND r.status = 'finalised' AND r.year_month BETWEEN ${from} AND ${to}
       GROUP BY r.year_month ORDER BY r.year_month`;
    return rows.map((r) => ({
      yearMonth: r.year_month,
      staffCount: r.staff_count,
      gross: r.gross,
      deductions: r.deductions,
      adjustments: r.adjustments,
      net: r.net,
      paid: r.paid,
      unpaid: r.unpaid,
    }));
  }

  // ---------------------------------------------------------------------------- daily cash

  /**
   * One day's cash (§3.4, §0.20) over the cash payments received that day: each is voided while
   * in custody, still with its collector, or in a handover (open or confirmed; a void after the
   * handover leaves it there). So cashReceived − voidedBeforeHandover = Σ withCollectors +
   * Σ handedOver.fromDay. The day's cash going out: refunds paid in cash (net of their reversals),
   * cash expenses (a written-off shortfall is one, slice 20 §8) and salaries paid in cash.
   */
  async dailyCash(schoolId: SchoolId, day: Date, startsAt: Date, endsBefore: Date): Promise<DailyCashFacts> {
    const d = sqlDate(day);
    const [inflow] = await this.txHost.tx.$queryRaw<
      { received: number; voided_before: number; voided_after: number }[]
    >`
      SELECT COALESCE(SUM(p.amount), 0)::int AS received,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'voided' AND p.handover_id IS NULL), 0)::int AS voided_before,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'voided' AND p.handover_id IS NOT NULL), 0)::int AS voided_after
        FROM payments p
       WHERE p.school_id = ${schoolId} AND p.method = 'cash' AND p.received_on = ${d}`;
    const custody = await this.txHost.tx.$queryRaw<{ user_id: bigint; amount: number; since: Date }[]>`
      SELECT p.recorded_by AS user_id, SUM(p.amount)::int AS amount, MIN(p.recorded_at) AS since
        FROM payments p
       WHERE p.school_id = ${schoolId} AND p.method = 'cash' AND p.received_on = ${d}
         AND p.status = 'verified' AND p.handover_id IS NULL
       GROUP BY p.recorded_by ORDER BY 2 DESC, 1`;
    const handed = await this.txHost.tx.$queryRaw<
      {
        id: bigint;
        status: string;
        collector_user_id: bigint;
        confirmed_by: bigint | null;
        expected_amount: number;
        counted_amount: number | null;
        shortfall_amount: number | null;
        surplus_amount: number | null;
        shortfall_resolution: string | null;
        from_day: number;
      }[]
    >`
      SELECT h.id, h.status::text AS status, h.collector_user_id, h.confirmed_by, h.expected_amount,
             h.counted_amount, h.shortfall_amount, h.surplus_amount, h.shortfall_resolution::text AS shortfall_resolution,
             SUM(p.amount)::int AS from_day
        FROM payments p
        JOIN cash_handovers h ON h.school_id = p.school_id AND h.id = p.handover_id
       WHERE p.school_id = ${schoolId} AND p.method = 'cash' AND p.received_on = ${d}
       GROUP BY h.id ORDER BY h.id`;
    const [outflow] = await this.txHost.tx.$queryRaw<
      { refunds: number; expenses: number; shortfalls: number; salaries: number }[]
    >`
      SELECT
        (SELECT COALESCE(SUM(CASE WHEN r.kind = 'refund' THEN r.amount ELSE -r.amount END), 0)
           FROM payment_reversals r
           LEFT JOIN payment_reversals o ON o.school_id = r.school_id AND o.id = r.reverses_id
          WHERE r.school_id = ${schoolId} AND r.created_at >= ${startsAt} AND r.created_at < ${endsBefore}
            AND ((r.kind = 'refund' AND r.refund_method = 'cash')
              OR (r.kind = 'refund_reversal' AND o.refund_method = 'cash')))::int AS refunds,
        (SELECT COALESCE(SUM(x.amount), 0) FROM expenses x
          WHERE x.school_id = ${schoolId} AND x.method = 'cash' AND x.spent_on = ${d}
            AND x.status IN ('recorded', 'approved'))::int AS expenses,
        (SELECT COALESCE(SUM(x.amount), 0) FROM expenses x
          WHERE x.school_id = ${schoolId} AND x.method = 'cash' AND x.spent_on = ${d}
            AND x.status IN ('recorded', 'approved') AND x.category = 'cash_shortfall')::int AS shortfalls,
        (SELECT COALESCE(SUM(ps.net), 0) FROM payslips ps
          WHERE ps.school_id = ${schoolId} AND ps.status = 'paid' AND ps.paid_method = 'cash'
            AND ps.paid_on = ${d})::int AS salaries`;
    return {
      cashReceived: inflow?.received ?? 0,
      voidedBeforeHandover: inflow?.voided_before ?? 0,
      voidedAfterHandover: inflow?.voided_after ?? 0,
      withCollectors: custody.map((r) => ({ userId: r.user_id, amount: r.amount, since: r.since })),
      handedOver: handed.map((r) => ({
        handoverId: r.id,
        status: r.status,
        collectorUserId: r.collector_user_id,
        confirmedBy: r.confirmed_by,
        expected: r.expected_amount,
        counted: r.counted_amount,
        shortfall: r.shortfall_amount,
        surplus: r.surplus_amount,
        shortfallResolution: r.shortfall_resolution,
        fromDay: r.from_day,
      })),
      refundsPaidCash: outflow?.refunds ?? 0,
      cashExpenses: outflow?.expenses ?? 0,
      shortfallWrittenOff: outflow?.shortfalls ?? 0,
      salariesPaidCash: outflow?.salaries ?? 0,
    };
  }

  // ------------------------------------------------------------------------- dues clearance

  /** A student's outstanding across every enrolment (A7, R204), and the newest open charge's birth. */
  async studentDues(schoolId: SchoolId, studentId: bigint): Promise<{ outstanding: number; newestOpenAt: Date | null }> {
    const [row] = await this.txHost.tx.$queryRaw<{ outstanding: number; newest: Date | null }[]>`
      SELECT COALESCE(SUM(${OWED}), 0)::int AS outstanding, MAX(c.created_at) AS newest
        FROM charges c
       WHERE c.school_id = ${schoolId} AND c.student_id = ${studentId} AND c.status = 'open'`;
    return { outstanding: row?.outstanding ?? 0, newestOpenAt: row?.newest ?? null };
  }

  /** The child's unspent advance in every year (payments bound to them, verified). */
  async studentAdvance(schoolId: SchoolId, studentId: bigint): Promise<number> {
    const [row] = await this.txHost.tx.$queryRaw<{ advance: number }[]>`
      SELECT COALESCE(SUM(p.unallocated_amount), 0)::int AS advance
        FROM payments p
       WHERE p.school_id = ${schoolId} AND p.advance_for_student_id = ${studentId} AND p.status = 'verified'`;
    return row?.advance ?? 0;
  }

  /** The latest dues-clearance override of the student (the audit row is the override, R204). */
  async latestOverride(
    schoolId: SchoolId,
    studentId: bigint,
  ): Promise<{ actorUserId: bigint; reason: string | null; createdAt: Date; outstanding: number } | null> {
    const row = await this.txHost.tx.auditLog.findFirst({
      where: { schoolId, action: 'dues_clearance.overridden', subjectType: 'student', subjectId: studentId },
      select: { actorUserId: true, reason: true, createdAt: true, metadata: true },
      orderBy: { id: 'desc' },
    });
    if (!row || row.actorUserId === null) return null;
    const meta = row.metadata;
    const overridden =
      meta !== null && typeof meta === 'object' && !Array.isArray(meta) && typeof meta['outstanding'] === 'number'
        ? meta['outstanding']
        : 0;
    return { actorUserId: row.actorUserId, reason: row.reason, createdAt: row.createdAt, outstanding: overridden };
  }

  // ------------------------------------------------------------------------------ reminders

  /**
   * The fee-paying links (live, to an unmerged guardian) of every child owing something, with the
   * child's outstanding, overdue part, oldest overdue and next upcoming due date, and the child's
   * pending claims (R201: a family whose pending claims cover its dues is skipped). `guardianIds`
   * narrows to these families (a manual send's target); every owing child of each is included.
   * One scan of the open charges (§7.2: ≤ 20 s per school).
   */
  async reminderLinks(schoolId: SchoolId, today: Date, guardianIds?: readonly bigint[]): Promise<ReminderLinkRow[]> {
    if (guardianIds !== undefined && guardianIds.length === 0) return [];
    const families =
      guardianIds === undefined ? Prisma.empty : Prisma.sql`AND sg.guardian_id IN (${Prisma.join([...guardianIds])})`;
    const t = sqlDate(today);
    const rows = await this.txHost.tx.$queryRaw<
      {
        guardian_id: bigint;
        student_id: bigint;
        student_name: string;
        outstanding: number;
        overdue: number;
        oldest_overdue: Date | null;
        next_due: Date | null;
        pending_claims: number;
      }[]
    >`
      WITH o AS (
        SELECT c.student_id,
               SUM(${OWED})::int AS outstanding,
               COALESCE(SUM(${OWED}) FILTER (WHERE c.due_on < ${t}), 0)::int AS overdue,
               MIN(c.due_on) FILTER (WHERE c.due_on < ${t}) AS oldest_overdue,
               MIN(c.due_on) FILTER (WHERE c.due_on >= ${t}) AS next_due
          FROM charges c
         WHERE c.school_id = ${schoolId} AND c.status = 'open'
         GROUP BY c.student_id
      ), claims AS (
        SELECT pc.student_id, SUM(pc.claimed_amount)::int AS pending
          FROM payment_claims pc
         WHERE pc.school_id = ${schoolId} AND pc.status = 'pending'
         GROUP BY pc.student_id
      )
      SELECT sg.guardian_id, o.student_id, s.full_name AS student_name, o.outstanding, o.overdue,
             o.oldest_overdue, o.next_due, COALESCE(cl.pending, 0)::int AS pending_claims
        FROM o
        JOIN student_guardians sg ON sg.school_id = ${schoolId} AND sg.student_id = o.student_id
                                 AND sg.ended_at IS NULL AND sg.is_fee_payer ${families}
        JOIN guardians g ON g.school_id = ${schoolId} AND g.id = sg.guardian_id AND g.merged_into_id IS NULL
        JOIN students s ON s.school_id = ${schoolId} AND s.id = o.student_id
        LEFT JOIN claims cl ON cl.student_id = o.student_id
       WHERE o.outstanding > 0
       ORDER BY sg.guardian_id, s.full_name, s.id`;
    return rows.map((r) => ({
      guardianId: r.guardian_id,
      studentId: r.student_id,
      studentName: r.student_name,
      outstanding: r.outstanding,
      overdue: r.overdue,
      oldestOverdue: r.oldest_overdue,
      nextDue: r.next_due,
      pendingClaims: r.pending_claims,
    }));
  }

  /** The live fee-paying guardians (unmerged) of these students: a manual send's families. */
  async feePayerGuardians(schoolId: SchoolId, studentIds: readonly bigint[]): Promise<bigint[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        studentId: { in: [...new Set(studentIds)] },
        endedAt: null,
        isFeePayer: true,
        guardian: { schoolId, mergedIntoId: null },
      },
      select: { guardianId: true },
      distinct: ['guardianId'],
    });
    return rows.map((r) => r.guardianId);
  }

  /** Students with a live enrolment (not ended) in the class or section: a manual send's target. */
  async studentsIn(schoolId: SchoolId, target: { classId?: bigint; sectionId?: bigint }): Promise<bigint[]> {
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        endedOn: null,
        ...(target.classId === undefined ? {} : { classId: target.classId }),
        ...(target.sectionId === undefined ? {} : { sectionId: target.sectionId }),
      },
      select: { studentId: true },
      distinct: ['studentId'],
    });
    return rows.map((r) => r.studentId);
  }

  /** Whether the class, the section or every student exists in this school (a target's 422). */
  async targetsExist(
    schoolId: SchoolId,
    target: { classId?: bigint; sectionId?: bigint; studentIds?: readonly bigint[] },
  ): Promise<boolean> {
    if (target.classId !== undefined) {
      return (await this.txHost.tx.class.count({ where: { schoolId, id: target.classId } })) === 1;
    }
    if (target.sectionId !== undefined) {
      return (await this.txHost.tx.section.count({ where: { schoolId, id: target.sectionId } })) === 1;
    }
    if (target.studentIds !== undefined) {
      const ids = [...new Set(target.studentIds)];
      return (await this.txHost.tx.student.count({ where: { schoolId, id: { in: ids } } })) === ids.length;
    }
    return true;
  }

  /**
   * Messages written but not yet attempted on SMS (queued or sending, an SMS leg in the plan, no
   * SMS delivery row yet), grouped by what decides their SMS units: the body, an attachment, the
   * priority and the plan. The reminder budget subtracts them (R250): each will reserve its
   * segments when the worker reaches it.
   */
  async pendingSmsMessages(
    schoolId: SchoolId,
  ): Promise<{ body: string; hasMedia: boolean; priority: MessagePriority; channelPlan: MessageChannel[]; count: number }[]> {
    const rows = await this.txHost.tx.$queryRaw<
      { body: string; has_media: boolean; priority: MessagePriority; channel_plan: MessageChannel[]; count: number }[]
    >`
      SELECT m.body, m.media_object_key IS NOT NULL AS has_media, m.priority::text AS priority, m.channel_plan::text[] AS channel_plan,
             COUNT(*)::int AS count
        FROM messages m
       WHERE m.school_id = ${schoolId}
         AND m.status IN ('queued', 'sending')
         AND 'sms' = ANY (m.channel_plan)
         AND NOT EXISTS (
               SELECT 1 FROM message_deliveries d
                WHERE d.school_id = ${schoolId} AND d.message_id = m.id AND d.channel = 'sms')
       GROUP BY m.body, has_media, m.priority, m.channel_plan`;
    return rows.map((r) => ({ body: r.body, hasMedia: r.has_media, priority: r.priority, channelPlan: r.channel_plan, count: r.count }));
  }

  /**
   * The fee reminders these subjects already carry (R107's unique key makes them facts): the
   * month's due reminder and the overdue reminders of this month and the last.
   */
  async reminderMessages(schoolId: SchoolId, subjectIds: readonly bigint[]): Promise<ReminderMessageRow[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.txHost.tx.message.findMany({
      where: {
        schoolId,
        subjectType: 'fee_reminder',
        subjectId: { in: [...subjectIds] },
        type: { in: ['fee_due_reminder', 'fee_overdue'] },
        guardianId: { not: null },
      },
      select: { guardianId: true, type: true, subjectId: true, createdAt: true },
    });
    return rows.flatMap((r) =>
      r.guardianId === null || (r.type !== 'fee_due_reminder' && r.type !== 'fee_overdue')
        ? []
        : [{ guardianId: r.guardianId, type: r.type, subjectId: r.subjectId, createdAt: r.createdAt }],
    );
  }
}
