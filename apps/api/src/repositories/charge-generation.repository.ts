import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ChargeKind, FeeFrequency } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The set-based writes of charge generation (phase-3-financial.md §3.7, §5 slice 19, R179-R185,
// R240, R241): the monthly and yearly INSERT … SELECT per class, the campaign INSERT … SELECT, and
// the late-fee sweep's candidates and inserts. Every ON CONFLICT names its key's columns and
// repeats the key's predicate exactly (never ON CONSTRAINT). Every statement filters school_id on
// every table it reads (test/charges/isolation.e2e-spec.ts). Listed in RAW_SQL_FILES.
//
// The concession arithmetic in CONCEDED is concessionAmount (packages/shared/src/money/charges.ts)
// in SQL, so a 3,000-student month stays one statement per class (§7.2); generation.spec checks
// the two agree on every rounding case.

/** One new charge a statement inserted. */
export interface InsertedCharge {
  id: bigint;
  studentId: bigint;
  amount: number;
}

export interface GenerationResult {
  /** Rows the statement would write before the keys and the voided-row check skip any. */
  candidates: number;
  inserted: InsertedCharge[];
}

/** One class's monthly or yearly generation for one period (§5 slice 19 "Generation"). */
export interface ClassGeneration {
  academicYearId: bigint;
  classId: bigint;
  /** `YYYY-MM`. */
  period: string;
  /** `YYYY-MM-DD`: the period's first and last days, and its fee cut-off day (R180). */
  periodStart: string;
  periodEnd: string;
  cutoffDate: string;
  /** Appended to the head's name: `October 2026` (monthly) or the year's name (yearly). */
  label: string;
  /** dueOn() of the period for a charge created today (R240). */
  dueOn: string;
  /** A manual run's `regenerateVoided`: recreate a generated row that was voided. */
  regenerateVoided: boolean;
}

/** An open overdue charge the late-fee sweep may attach a late fee to (A3, R185). */
export interface LateFeeCandidateRow {
  id: bigint;
  studentId: bigint;
  enrolmentId: bigint;
  academicYearId: bigint;
  kind: ChargeKind;
  headFrequency: FeeFrequency;
  period: string | null;
  dueOn: string;
  outstanding: number;
  yearClosed: boolean;
}

export interface NewLateFee {
  targetId: bigint;
  studentId: bigint;
  enrolmentId: bigint;
  academicYearId: bigint;
  period: string;
}

/** The concession on one row: the approved concession `con` applied to `gross` (concessionAmount). */
const conceded = (gross: Prisma.Sql): Prisma.Sql => Prisma.sql`
  CASE WHEN con.id IS NULL THEN 0
       WHEN con.kind = 'percentage' THEN ((${gross})::bigint * con.value / 100)::int
       ELSE LEAST(con.value, ${gross}) END`;

/** The approved concession of `studentExpr` on head `h` in force for `period` (R182). */
const concessionJoin = (schoolId: SchoolId, yearId: bigint, studentExpr: Prisma.Sql, period: string): Prisma.Sql => Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT co.id, co.kind, co.value
      FROM concessions co
      JOIN concession_heads ch
        ON ch.school_id = co.school_id AND ch.concession_id = co.id AND ch.fee_head_id = h.id
     WHERE co.school_id = ${schoolId} AND co.student_id = ${studentExpr}
       AND co.academic_year_id = ${yearId} AND co.status = 'approved'
       AND co.effective_from <= ${period}::text AND h.concession_eligible
     ORDER BY co.id
     LIMIT 1) con ON TRUE`;

/** The statement's json_agg of [id, student_id, amount] triples (ids as text: no 2^53 loss). */
function parseInserted(json: unknown): InsertedCharge[] {
  if (!Array.isArray(json)) throw new Error('generation returned no row list');
  return json.map((item: unknown) => {
    if (!Array.isArray(item)) throw new Error('generation returned a malformed row');
    const id: unknown = item[0];
    const studentId: unknown = item[1];
    const amount: unknown = item[2];
    if (typeof id !== 'string' || typeof studentId !== 'string' || typeof amount !== 'number') {
      throw new Error('generation returned a malformed row');
    }
    return { id: BigInt(id), studentId: BigInt(studentId), amount };
  });
}

@Injectable()
export class ChargeGenerationRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * Shared locks on the school's live fee heads, in id order: a structure write locks its head
   * for update (FeeStructuresService), so a class's generation reads one consistent set of
   * amounts and a structure write waits for the class in progress.
   */
  async lockHeadsShared(schoolId: SchoolId): Promise<void> {
    await this.txHost.tx.$queryRaw`
      SELECT id FROM fee_heads WHERE school_id = ${schoolId} AND status = 'active' ORDER BY id FOR SHARE`;
  }

  /**
   * The classes of the year with an enrolment overlapping the period, and which of them lack a
   * structure for a head that is priced somewhere in the year (the run's skipped classes, R177).
   */
  async classesToGenerate(
    schoolId: SchoolId,
    g: Pick<ClassGeneration, 'academicYearId' | 'period' | 'periodStart' | 'periodEnd'>,
  ): Promise<{ classId: bigint; className: string; missingStructure: boolean }[]> {
    return this.txHost.tx.$queryRaw<{ classId: bigint; className: string; missingStructure: boolean }[]>`
      WITH priced AS (
        SELECT DISTINCT s.class_id, s.fee_head_id
          FROM fee_structures s
          JOIN fee_heads h ON h.school_id = s.school_id AND h.id = s.fee_head_id
         WHERE s.school_id = ${schoolId} AND s.academic_year_id = ${g.academicYearId}
           AND s.status = 'active' AND s.effective_from <= ${g.period}::text
           AND h.status = 'active' AND h.frequency IN ('monthly', 'yearly')
      )
      SELECT c.id AS "classId", c.name AS "className",
             EXISTS (
               SELECT 1 FROM (SELECT DISTINCT fee_head_id FROM priced) p
                WHERE NOT EXISTS (SELECT 1 FROM priced q WHERE q.class_id = c.id AND q.fee_head_id = p.fee_head_id)
             ) AS "missingStructure"
        FROM classes c
       WHERE c.school_id = ${schoolId} AND c.academic_year_id = ${g.academicYearId}
         AND EXISTS (
           SELECT 1 FROM enrolments e
            WHERE e.school_id = ${schoolId} AND e.class_id = c.id
              AND e.started_on <= ${g.periodEnd}::date
              AND (e.ended_on IS NULL OR e.ended_on >= ${g.periodStart}::date))
       ORDER BY c.id`;
  }

  /**
   * One class's monthly heads for the period (R179-R182, R240, R241), one INSERT … SELECT: per
   * student the enrolment active on the 1st, else the first that started on or before the
   * cut-off; the class of that enrolment pays; every active monthly head with a structure > 0
   * effective by the period; the approved concession in force; settled at birth when nothing is
   * owed. A student, head and period with any generated row (voided included) is skipped unless
   * `regenerateVoided`; the key skips a live one either way.
   */
  generateMonthly(schoolId: SchoolId, g: ClassGeneration): Promise<GenerationResult> {
    return this.generateHeads(schoolId, g, 'monthly');
  }

  /**
   * One class's yearly heads (§1.1 "Once and yearly heads"): at the student's first generated
   * period of the year, cut-off ignored, on charges_yearly_key; the enrolment active on the 1st,
   * else the first to start in the period. No period on the row.
   */
  generateYearly(schoolId: SchoolId, g: ClassGeneration): Promise<GenerationResult> {
    return this.generateHeads(schoolId, g, 'yearly');
  }

  /**
   * The statement behind both. The (student, head) pairs that already have a generated row on the
   * key (voided included, unless `regenerateVoided`) are dropped by an anti-join before the
   * structure and concession lookups, so a catch-up that finds everyone charged reads only the
   * class's enrolments and the key index (§7.2: ≤ 5 s). `candidates` = pairs already charged +
   * rows offered to the insert, so `candidates − inserted` is what was skipped.
   */
  private async generateHeads(
    schoolId: SchoolId,
    g: ClassGeneration,
    frequency: 'monthly' | 'yearly',
  ): Promise<GenerationResult> {
    const monthly = frequency === 'monthly';
    // A literal, not a parameter: the planner then uses the partial key indexes' predicates.
    const freq = monthly ? Prisma.sql`'monthly'::fee_frequency` : Prisma.sql`'yearly'::fee_frequency`;
    // Monthly heads honour the fee cut-off (R180); yearly heads ignore it.
    const startedBy = monthly ? g.cutoffDate : g.periodEnd;
    const sameKey = monthly
      ? Prisma.sql`x.period = ${g.period}::text`
      : Prisma.sql`x.academic_year_id = ${g.academicYearId}`;
    const period = monthly ? Prisma.sql`${g.period}` : Prisma.sql`NULL`;
    const conflict = monthly
      ? Prisma.sql`ON CONFLICT (school_id, student_id, fee_head_id, period)
           WHERE kind = 'generated' AND head_frequency = 'monthly' AND status <> 'voided' DO NOTHING`
      : Prisma.sql`ON CONFLICT (school_id, student_id, fee_head_id, academic_year_id)
           WHERE kind = 'generated' AND head_frequency = 'yearly' AND status <> 'voided' DO NOTHING`;
    const rows = await this.txHost.tx.$queryRaw<{ candidates: number; inserted: unknown }[]>`
      WITH members AS (
        -- The class's students in the year (any enrolment in it), then per student one indexed
        -- lookup of the enrolment that decides the period (enrolments_school_id_student_id_idx).
        SELECT DISTINCT x.student_id FROM enrolments x
         WHERE x.school_id = ${schoolId} AND x.academic_year_id = ${g.academicYearId}
           AND x.class_id = ${g.classId}
      ), chosen AS (
        SELECT ch.enrolment_id, m.student_id, ch.class_id
          FROM members m
          JOIN LATERAL (
            SELECT e.id AS enrolment_id, e.class_id
              FROM enrolments e
             WHERE e.school_id = ${schoolId} AND e.student_id = m.student_id
               AND e.academic_year_id = ${g.academicYearId}
               AND e.started_on <= ${startedBy}::date
               AND (e.ended_on IS NULL OR e.ended_on >= ${g.periodStart}::date)
             ORDER BY (e.started_on <= ${g.periodStart}::date) DESC,
                      CASE WHEN e.started_on <= ${g.periodStart}::date THEN e.started_on END DESC NULLS LAST,
                      e.started_on ASC, e.id ASC
             LIMIT 1) ch ON TRUE
      ), pairs AS (
        SELECT c.enrolment_id, c.student_id, h.id AS fee_head_id
          FROM chosen c
          JOIN fee_heads h
            ON h.school_id = ${schoolId} AND h.status = 'active' AND h.frequency = ${freq}
         WHERE c.class_id = ${g.classId}
      ), todo AS (
        SELECT p.* FROM pairs p
         WHERE ${g.regenerateVoided}::boolean OR NOT EXISTS (
                 SELECT 1 FROM charges x
                  WHERE x.school_id = ${schoolId} AND x.student_id = p.student_id
                    AND x.fee_head_id = p.fee_head_id AND ${sameKey}
                    AND x.kind = 'generated' AND x.head_frequency = ${freq})
      ), rows AS (
        SELECT t.enrolment_id, t.student_id, h.id AS fee_head_id, h.name AS head_name,
               fs.amount AS gross, con.id AS concession_id, ${conceded(Prisma.sql`fs.amount`)} AS conceded
          FROM todo t
          JOIN fee_heads h ON h.school_id = ${schoolId} AND h.id = t.fee_head_id
          JOIN LATERAL (
            SELECT s.amount FROM fee_structures s
             WHERE s.school_id = ${schoolId} AND s.class_id = ${g.classId} AND s.fee_head_id = h.id
               AND s.status = 'active' AND s.effective_from <= ${g.period}::text
             ORDER BY s.effective_from DESC, s.id DESC
             LIMIT 1) fs ON TRUE
          ${concessionJoin(schoolId, g.academicYearId, Prisma.sql`t.student_id`, g.period)}
         WHERE fs.amount > 0
      ), ins AS (
        INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id,
                             head_frequency, kind, period, concession_id, gross_amount,
                             concession_amount, amount, description, due_on, status, settled_at,
                             created_by)
        SELECT ${schoolId}, r.enrolment_id, r.student_id, ${g.academicYearId}, r.fee_head_id,
               ${freq}, 'generated'::charge_kind, ${period}, r.concession_id, r.gross,
               r.conceded, r.gross - r.conceded, r.head_name || ' ' || ${g.label}::text, ${g.dueOn}::date,
               CASE WHEN r.gross = r.conceded THEN 'settled'::charge_status ELSE 'open'::charge_status END,
               CASE WHEN r.gross = r.conceded THEN now() END, NULL
          FROM rows r
        ${conflict}
        RETURNING id, student_id, amount
      )
      SELECT ((SELECT count(*) FROM pairs) - (SELECT count(*) FROM todo) + (SELECT count(*) FROM rows))::int AS candidates,
             COALESCE((SELECT json_agg(json_build_array(id::text, student_id::text, amount)) FROM ins), '[]'::json) AS inserted`;
    const row = rows[0];
    return { candidates: row?.candidates ?? 0, inserted: parseInserted(row?.inserted ?? []) };
  }

  /**
   * A campaign's charges (R184): one per targeted enrolment on charges_campaign_key, the
   * campaign's head and amount, the approved concession in force when `applyConcessions` and the
   * head is eligible. `enrolmentIds` are live enrolments of the campaign's year, one per student.
   */
  async generateCampaign(
    schoolId: SchoolId,
    c: {
      campaignId: bigint;
      academicYearId: bigint;
      feeHeadId: bigint;
      amount: number;
      description: string;
      dueOn: string;
      /** The month a concession must be in force by. */
      period: string;
      applyConcessions: boolean;
      enrolmentIds: readonly bigint[];
    },
  ): Promise<GenerationResult> {
    if (c.enrolmentIds.length === 0) return { candidates: 0, inserted: [] };
    const rows = await this.txHost.tx.$queryRaw<{ candidates: number; inserted: unknown }[]>`
      WITH targets AS (
        SELECT e.id AS enrolment_id, e.student_id
          FROM enrolments e
         WHERE e.school_id = ${schoolId} AND e.academic_year_id = ${c.academicYearId}
           AND e.id IN (${Prisma.join([...c.enrolmentIds])})
      ), rows AS (
        SELECT t.enrolment_id, t.student_id, h.id AS fee_head_id, h.frequency,
               ${c.amount}::int AS gross,
               CASE WHEN ${c.applyConcessions}::boolean THEN con.id END AS concession_id,
               CASE WHEN ${c.applyConcessions}::boolean THEN ${conceded(Prisma.sql`${c.amount}::int`)} ELSE 0 END AS conceded
          FROM targets t
          JOIN fee_heads h ON h.school_id = ${schoolId} AND h.id = ${c.feeHeadId}
          ${concessionJoin(schoolId, c.academicYearId, Prisma.sql`t.student_id`, c.period)}
      ), ins AS (
        INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id,
                             head_frequency, kind, period, campaign_id, concession_id, gross_amount,
                             concession_amount, amount, description, due_on, status, settled_at,
                             created_by)
        SELECT ${schoolId}, r.enrolment_id, r.student_id, ${c.academicYearId}, r.fee_head_id,
               r.frequency, 'campaign'::charge_kind, NULL, ${c.campaignId}, r.concession_id, r.gross,
               r.conceded, r.gross - r.conceded, ${c.description}::text, ${c.dueOn}::date,
               CASE WHEN r.gross = r.conceded THEN 'settled'::charge_status ELSE 'open'::charge_status END,
               CASE WHEN r.gross = r.conceded THEN now() END, NULL
          FROM rows r
        ON CONFLICT (school_id, campaign_id, enrolment_id) WHERE campaign_id IS NOT NULL DO NOTHING
        RETURNING id, student_id, amount
      )
      SELECT (SELECT count(*) FROM rows)::int AS candidates,
             COALESCE((SELECT json_agg(json_build_array(id::text, student_id::text, amount)) FROM ins), '[]'::json) AS inserted`;
    const row = rows[0];
    return { candidates: row?.candidates ?? 0, inserted: parseInserted(row?.inserted ?? []) };
  }

  /**
   * The late-fee sweep's candidates (A3, R185): open monthly charges with a period, still owing,
   * due on or after late fees were enabled and past the grace, whose student is still on the roll
   * of that year today (any enrolment not ended before `today`; the late fee is written on the
   * latest one). lateFeeTarget() makes the final choice.
   */
  lateFeeCandidates(
    schoolId: SchoolId,
    q: { enabledOn: string; overdueBefore: string; today: string },
  ): Promise<LateFeeCandidateRow[]> {
    return this.txHost.tx.$queryRaw<LateFeeCandidateRow[]>`
      SELECT c.id, c.student_id AS "studentId", e.id AS "enrolmentId",
             c.academic_year_id AS "academicYearId", c.kind::text AS kind,
             c.head_frequency::text AS "headFrequency", c.period::text AS period,
             to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn",
             (c.amount - c.allocated_amount - c.credited_amount)::int AS outstanding,
             (y.status = 'closed') AS "yearClosed"
        FROM charges c
        -- The student's latest enrolment in the charge's year that is still on the roll today: a
        -- section or class change ends the charge's own enrolment but not the student's place.
        JOIN LATERAL (
          SELECT x.id FROM enrolments x
           WHERE x.school_id = ${schoolId} AND x.student_id = c.student_id
             AND x.academic_year_id = c.academic_year_id
             AND (x.ended_on IS NULL OR x.ended_on >= ${q.today}::date)
           ORDER BY x.started_on DESC, x.id DESC
           LIMIT 1) e ON TRUE
        JOIN academic_years y ON y.school_id = c.school_id AND y.id = c.academic_year_id
       WHERE c.school_id = ${schoolId} AND y.school_id = ${schoolId}
         AND c.status = 'open' AND c.period IS NOT NULL
         AND c.kind IN ('generated', 'manual') AND c.head_frequency = 'monthly'
         AND c.due_on >= ${q.enabledOn}::date AND c.due_on < ${q.overdueBefore}::date
       ORDER BY c.student_id, c.due_on, c.id`;
  }

  /** The periods of these students that already carry a live late fee (charges_late_fee_key). */
  async lateFeePeriods(schoolId: SchoolId, studentIds: readonly bigint[]): Promise<Map<bigint, string[]>> {
    const result = new Map<bigint, string[]>();
    if (studentIds.length === 0) return result;
    const rows = await this.txHost.tx.charge.findMany({
      where: { schoolId, kind: 'late_fee', status: { not: 'voided' }, studentId: { in: [...studentIds] } },
      select: { studentId: true, period: true },
    });
    for (const row of rows) {
      if (row.period === null) continue;
      result.set(row.studentId, [...(result.get(row.studentId) ?? []), row.period]);
    }
    return result;
  }

  /**
   * The sweep's late fees (R185): one per student and period on charges_late_fee_key, under the
   * fine head, due `today`, written by the system (created_by null).
   */
  async insertLateFees(
    schoolId: SchoolId,
    fees: readonly NewLateFee[],
    head: { id: bigint; frequency: FeeFrequency },
    amount: number,
    today: string,
    labels: ReadonlyMap<string, string>,
  ): Promise<(InsertedCharge & { period: string })[]> {
    if (fees.length === 0) return [];
    const values = fees.map(
      (f) => Prisma.sql`(${schoolId}, ${f.enrolmentId}, ${f.studentId}, ${f.academicYearId}, ${head.id},
        ${head.frequency}::fee_frequency, 'late_fee'::charge_kind, ${f.period}, ${f.targetId},
        ${amount}::int, 0, ${amount}::int, ${`Late fee ${labels.get(f.period) ?? f.period}`}::text,
        ${today}::date, 'open'::charge_status, NULL::bigint)`,
    );
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint; studentId: bigint; amount: number; period: string }[]>`
      INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id,
                           head_frequency, kind, period, late_fee_for_charge_id, gross_amount,
                           concession_amount, amount, description, due_on, status, created_by)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (school_id, student_id, period) WHERE kind = 'late_fee' AND status <> 'voided'
        DO NOTHING
      RETURNING id, student_id AS "studentId", amount, period::text AS period`;
    return rows;
  }

  /**
   * The live `once` heads priced for a class by `period`, each at its latest active amount (> 0):
   * what admission and readmission charge (R239).
   */
  async onceStructures(
    schoolId: SchoolId,
    classId: bigint,
    period: string,
  ): Promise<{ feeHeadId: bigint; amount: number; head: { name: string; category: string; concessionEligible: boolean } }[]> {
    const rows = await this.txHost.tx.feeStructure.findMany({
      where: {
        schoolId,
        classId,
        status: 'active',
        effectiveFrom: { lte: period },
        feeHead: { schoolId, status: 'active', frequency: 'once' },
      },
      select: {
        feeHeadId: true,
        amount: true,
        feeHead: { select: { name: true, category: true, concessionEligible: true } },
      },
      orderBy: [{ feeHeadId: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }],
    });
    const seen = new Set<bigint>();
    return rows
      .filter((r) => (seen.has(r.feeHeadId) ? false : (seen.add(r.feeHeadId), true)))
      .filter((r) => r.amount > 0)
      .map((r) => ({ feeHeadId: r.feeHeadId, amount: r.amount, head: r.feeHead }));
  }

  /** A year's name and status (a run's label and R242's closed-year check). */
  yearOf(schoolId: SchoolId, id: bigint): Promise<{ name: string; status: string } | null> {
    return this.txHost.tx.academicYear.findFirst({ where: { schoolId, id }, select: { name: true, status: true } });
  }

  /** The `active` academic years whose dates overlap the period (A1: the scheduled run's years). */
  activeYearsFor(
    schoolId: SchoolId,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ id: bigint; name: string; startsOn: Date; endsOn: Date }[]> {
    return this.txHost.tx.academicYear.findMany({
      where: { schoolId, status: 'active', startsOn: { lte: periodEnd }, endsOn: { gte: periodStart } },
      select: { id: true, name: true, startsOn: true, endsOn: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Live fee-payer links of these students, to unmerged guardians (the fee_charged audience). */
  feePayers(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
  ): Promise<{ studentId: bigint; guardianId: bigint; student: { fullName: string } }[]> {
    if (studentIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        endedAt: null,
        isFeePayer: true,
        guardian: { schoolId, mergedIntoId: null },
      },
      select: { studentId: true, guardianId: true, student: { select: { fullName: true } } },
      orderBy: [{ guardianId: 'asc' }, { studentId: 'asc' }],
    });
  }
}
