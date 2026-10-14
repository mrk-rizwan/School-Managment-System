import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The charge job's one read of transport (phase-5-extended.md §2 boundaries, rule 37, R327;
// contracts/slice-41.md §2.6): read-only, importable only from src/modules/transport/** and
// src/modules/fees/charge-generation.ts (eslint transportReadsRepository). Every statement filters
// school_id on every table it reads (test/transport/isolation.e2e-spec.ts). Listed in RAW_SQL_FILES.

/** One student to charge for a period: the route amount in force (> 0). */
export interface TransportRider {
  studentId: bigint;
  routeId: bigint;
  amount: number;
}

@Injectable()
export class TransportReadsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * R327: per student, the assignment of the year in force for the period and started on or before
   * the cut-off day — the one in force on the period's first day, else the earliest to start —
   * with its route's amount in force for the period (the live row with the greatest
   * effective_period not after it). An assignment ended before it began (ends_on < starts_on) was
   * never in force. An end inside the period still counts: a mid-month end is charged in full.
   * Students whose chosen route has no positive amount are left out.
   */
  riders(
    schoolId: SchoolId,
    q: { academicYearId: bigint; period: string; periodStart: string; cutoffDate: string },
  ): Promise<TransportRider[]> {
    return this.txHost.tx.$queryRaw<TransportRider[]>`
      WITH chosen AS (
        SELECT DISTINCT ON (a.student_id) a.student_id, a.route_id
          FROM transport_assignments a
         WHERE a.school_id = ${schoolId} AND a.academic_year_id = ${q.academicYearId}
           AND a.starts_on <= ${q.cutoffDate}::date
           AND (a.ends_on IS NULL OR (a.ends_on >= ${q.periodStart}::date AND a.ends_on >= a.starts_on))
         ORDER BY a.student_id,
                  (a.starts_on <= ${q.periodStart}::date) DESC,
                  CASE WHEN a.starts_on <= ${q.periodStart}::date THEN a.starts_on END DESC NULLS LAST,
                  a.starts_on ASC, a.id ASC
      )
      SELECT c.student_id AS "studentId", c.route_id AS "routeId", amt.amount
        FROM chosen c
        JOIN LATERAL (
          SELECT ra.amount FROM transport_route_amounts ra
           WHERE ra.school_id = ${schoolId} AND ra.route_id = c.route_id AND ra.voided_at IS NULL
             AND ra.effective_period <= ${q.period}::text
           ORDER BY ra.effective_period DESC, ra.id DESC
           LIMIT 1) amt ON TRUE
       WHERE amt.amount > 0
       ORDER BY c.student_id`;
  }
}
