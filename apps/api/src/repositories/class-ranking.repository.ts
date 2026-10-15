import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { RankingTrigger } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Phase 5 slice 42 (phase-5-extended.md §1.1 "Class ranking", §3.2 "Rankings", A9, R333;
// contracts/slice-42.md §2.2): class_rankings and class_ranking_rows. A recompute, in the caller's
// transaction, takes the class-term's advisory lock, stamps the live version superseded, inserts
// the new version naming it, then its rows; the triggers hold the order and the live, published
// results (class_rankings_guard, class_ranking_rows_guard). `results` is never written here. The
// merit list and the student profile read the live version. Importable only from
// src/modules/results/** (lint). Listed in RAW_SQL_FILES for the one advisory lock.

/** One live published term result of the class, as the ranking reads it. */
export interface RankableResult {
  resultId: bigint;
  studentId: bigint;
  enrolmentId: bigint;
  percentBp: number | null;
}

export interface RankingRecord {
  id: bigint;
  classId: bigint;
  academicYearId: bigint;
  termId: bigint;
  trigger: RankingTrigger;
  computedAt: Date;
}

export interface RankingCompleteness {
  academicYearId: bigint;
  endsOn: Date;
  /** A live term_skips row: the class does not hold the term. */
  notHeld: boolean;
  /** Sections with an enrolment of the class in force on the term's last day. */
  dueSections: number;
  /** Of those, the ones with no published sheet of the term (id order). */
  missingSectionIds: bigint[];
}

export interface MeritRowRecord {
  resultId: bigint;
  studentId: bigint;
  studentName: string;
  admissionNo: string;
  sectionId: bigint;
  sectionName: string;
  classPosition: number | null;
  positionOf: number | null;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
}

const RANKING_SELECT = {
  id: true,
  classId: true,
  academicYearId: true,
  termId: true,
  trigger: true,
  computedAt: true,
} as const;

@Injectable()
export class ClassRankingRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * Serialises the recomputes of one class-term until commit: two sections published at once each
   * see the other's sheet once it commits, so the last one to commit always ranks.
   */
  async lockClassTerm(schoolId: SchoolId, classId: bigint, termId: bigint): Promise<void> {
    const key = `class_ranking:${schoolId}:${classId}:${termId}`;
    await this.txHost.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * Whether the class-term is complete, in one statement (R333): the term of the class's year, its
   * last day, whether the class does not hold it (a live term_skips row), and the sections with an
   * enrolment of the class in force on that day that have no published sheet of the term. Null when
   * the class or the term (of the class's year) is not the school's.
   */
  async completeness(schoolId: SchoolId, classId: bigint, termId: bigint): Promise<RankingCompleteness | null> {
    const [row] = await this.txHost.tx.$queryRaw<
      { academic_year_id: bigint; ends_on: Date; not_held: boolean; due: number; missing: bigint[] }[]
    >`
      WITH due AS (
        SELECT DISTINCT e.section_id
          FROM enrolments e
          JOIN academic_terms t ON t.school_id = e.school_id AND t.id = ${termId}
         WHERE e.school_id = ${schoolId} AND e.class_id = ${classId}
           AND e.started_on <= t.ends_on AND (e.ended_on IS NULL OR e.ended_on >= t.ends_on)
      )
      SELECT c.academic_year_id, t.ends_on,
             EXISTS (SELECT 1 FROM term_skips s
                      WHERE s.school_id = ${schoolId} AND s.class_id = c.id AND s.term_id = t.id AND s.ended_at IS NULL) AS not_held,
             (SELECT COUNT(*)::int FROM due) AS due,
             ARRAY(SELECT d.section_id FROM due d
                    WHERE NOT EXISTS (SELECT 1 FROM result_sheets rs
                                       WHERE rs.school_id = ${schoolId} AND rs.class_id = c.id AND rs.term_id = t.id
                                         AND rs.section_id = d.section_id AND rs.status = 'published')
                    ORDER BY d.section_id) AS missing
        FROM classes c
        JOIN academic_terms t ON t.school_id = c.school_id AND t.academic_year_id = c.academic_year_id AND t.id = ${termId}
       WHERE c.school_id = ${schoolId} AND c.id = ${classId}`;
    if (!row) return null;
    return {
      academicYearId: row.academic_year_id,
      endsOn: row.ends_on,
      notHeld: row.not_held,
      dueSections: row.due,
      missingSectionIds: row.missing.map((id) => BigInt(id)),
    };
  }

  /** Every live published term result of the class (every section), in id order. */
  async liveResults(schoolId: SchoolId, classId: bigint, termId: bigint): Promise<RankableResult[]> {
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, termId, publishedAt: { not: null }, supersededAt: null, sheet: { is: { classId } } },
      select: { id: true, studentId: true, enrolmentId: true, percentBp: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({ resultId: r.id, studentId: r.studentId, enrolmentId: r.enrolmentId, percentBp: r.percentBp }));
  }

  /** The live version of a class-term, or null before its first ranking. */
  live(schoolId: SchoolId, classId: bigint, termId: bigint): Promise<RankingRecord | null> {
    return this.txHost.tx.classRanking.findFirst({
      where: { schoolId, classId, termId, supersededAt: null },
      select: RANKING_SELECT,
    });
  }

  /**
   * Stamps the class-term's live version superseded and returns it (one statement); null before
   * the first ranking.
   */
  async supersedeLive(schoolId: SchoolId, classId: bigint, termId: bigint, at: Date): Promise<{ id: bigint } | null> {
    const [row] = await this.txHost.tx.classRanking.updateManyAndReturn({
      where: { schoolId, classId, termId, supersededAt: null },
      data: { supersededAt: at },
      select: { id: true },
    });
    return row ?? null;
  }

  /** A new live version and its rows (the predecessor is already stamped). */
  async insert(
    schoolId: SchoolId,
    version: {
      classId: bigint;
      academicYearId: bigint;
      termId: bigint;
      trigger: RankingTrigger;
      computedAt: Date;
      supersedesId: bigint | null;
    },
    rows: readonly { resultId: bigint; studentId: bigint; enrolmentId: bigint; classPosition: number | null; positionOf: number | null }[],
  ): Promise<bigint> {
    const { id } = await this.txHost.tx.classRanking.create({
      data: { schoolId, ...version },
      select: { id: true },
    });
    if (rows.length > 0) {
      await this.txHost.tx.classRankingRow.createMany({
        data: rows.map((row) => ({ schoolId, rankingId: id, ...row })),
      });
    }
    return id;
  }

  /** A page of a version's rows, best first (unranked last, then by name), and its total. */
  async meritPage(
    schoolId: SchoolId,
    rankingId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: MeritRowRecord[]; total: number }> {
    const where = { schoolId, rankingId };
    const [rows, total] = [
      await this.txHost.tx.classRankingRow.findMany({
        where,
        select: {
          resultId: true,
          studentId: true,
          classPosition: true,
          positionOf: true,
          result: { select: { percentBp: true, grade: true, passed: true } },
          enrolment: {
            select: {
              sectionId: true,
              section: { select: { name: true } },
              student: { select: { fullName: true, admissionNo: true } },
            },
          },
        },
        orderBy: [
          { classPosition: { sort: 'asc', nulls: 'last' } },
          { enrolment: { student: { fullName: 'asc' } } },
          { id: 'asc' },
        ],
        skip: page.skip,
        take: page.take,
      }),
      await this.txHost.tx.classRankingRow.count({ where }),
    ];
    return {
      rows: rows.map((r) => ({
        resultId: r.resultId,
        studentId: r.studentId,
        studentName: r.enrolment.student.fullName,
        admissionNo: r.enrolment.student.admissionNo,
        sectionId: r.enrolment.sectionId,
        sectionName: r.enrolment.section.name,
        classPosition: r.classPosition,
        positionOf: r.positionOf,
        percentBp: r.result.percentBp,
        grade: r.result.grade,
        passed: r.result.passed,
      })),
      total,
    };
  }

  /** The class position of a result in its class-term's live version (the student profile). */
  async livePositionOf(
    schoolId: SchoolId,
    resultId: bigint,
  ): Promise<{ classPosition: number | null; positionOf: number | null } | null> {
    return this.txHost.tx.classRankingRow.findFirst({
      where: { schoolId, resultId, ranking: { is: { supersededAt: null } } },
      select: { classPosition: true, positionOf: true },
    });
  }

  /** The class and term names of a merit list's header. */
  async names(
    schoolId: SchoolId,
    classId: bigint,
    termId: bigint,
  ): Promise<{ className: string; termName: string; academicYearId: bigint } | null> {
    const cls = await this.txHost.tx.class.findFirst({
      where: { schoolId, id: classId },
      select: { name: true, academicYearId: true },
    });
    if (!cls) return null;
    const term = await this.txHost.tx.academicTerm.findFirst({
      where: { schoolId, id: termId, academicYearId: cls.academicYearId },
      select: { name: true },
    });
    return term ? { className: cls.name, termName: term.name, academicYearId: cls.academicYearId } : null;
  }

  /** The sections' names (a pending merit list names what is missing). */
  async sectionNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<{ id: bigint; name: string }[]> {
    if (ids.length === 0) return [];
    return this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: [...ids] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}
