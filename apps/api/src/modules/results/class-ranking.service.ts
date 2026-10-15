import { Injectable } from '@nestjs/common';
import { classRanking, type RankingTrigger } from '@asms/shared';
import { SchoolClock } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRankingRepository } from '../../repositories/class-ranking.repository';
import type { SchoolId } from '../../tenancy/school-id';

/**
 * The class-wide ranking (Phase 5 rule 38, phase-5-extended.md §1.1 "Class ranking", A9, R333;
 * contracts/slice-42.md §2.2). Computed when the last section of a class-term publishes
 * (ResultSheetsService.publishLocked), after a correction cascade (ResultRevisionService.revise)
 * and after a past-results import commits (slice 43): each time as a new version superseding the
 * live one, ranking every live published term result of the class by `percent_bp` with the
 * shared classRanking (ties share; nothing assessed = listed, never positioned). `results` is
 * never written, so the report card keeps printing the section position (R279).
 */
@Injectable()
export class ClassRankingService {
  constructor(
    private readonly rankings: ClassRankingRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** A result's place in its class-term's live ranking (the student profile); null when unranked. */
  livePositionOf(
    schoolId: SchoolId,
    resultId: bigint,
  ): Promise<{ classPosition: number | null; positionOf: number | null } | null> {
    return this.rankings.livePositionOf(schoolId, resultId);
  }

  /**
   * Inside the caller's transaction, after its results are written. Ranks the class-term when it
   * is complete — every section with an enrolment in force on the term's last day has a published
   * sheet of the term, and the class holds the term (no live skip) — and returns the new
   * version's id; null when it is not complete yet (nothing written). A recompute racing another
   * on the same class-term waits for it (advisory lock) and then supersedes its version.
   */
  async recompute(
    schoolId: SchoolId,
    classId: bigint,
    termId: bigint,
    trigger: RankingTrigger,
    actorUserId: bigint,
  ): Promise<bigint | null> {
    await this.rankings.lockClassTerm(schoolId, classId, termId);
    // A fresh statement after the lock, so a section published by the transaction it waited for is seen.
    const term = await this.rankings.completeness(schoolId, classId, termId);
    if (!term || term.notHeld || term.dueSections === 0 || term.missingSectionIds.length > 0) return null;
    const results = await this.rankings.liveResults(schoolId, classId, termId);
    if (results.length === 0) return null;

    const byId = new Map(results.map((r) => [r.resultId.toString(), r]));
    const ranked = classRanking(
      results.map((r) => ({ resultId: r.resultId.toString(), studentId: r.studentId.toString(), percentBp: r.percentBp })),
    );
    const now = this.clock.now();
    const live = await this.rankings.supersedeLive(schoolId, classId, termId, now);
    const id = await this.rankings.insert(
      schoolId,
      { classId, academicYearId: term.academicYearId, termId, trigger, computedAt: now, supersedesId: live?.id ?? null },
      ranked.map((row) => {
        const source = byId.get(row.resultId);
        if (!source) throw new Error('a ranked row names a result it was not given');
        return {
          resultId: source.resultId,
          studentId: source.studentId,
          enrolmentId: source.enrolmentId,
          classPosition: row.classPosition,
          positionOf: row.positionOf,
        };
      }),
    );
    await this.audit.record(schoolId, {
      actorUserId,
      action: 'class_ranking.computed',
      subjectType: 'class_ranking',
      subjectId: id,
      metadata: {
        classId: classId.toString(),
        termId: termId.toString(),
        trigger,
        rows: ranked.length,
        positioned: ranked.filter((r) => r.classPosition !== null).length,
        ...(live ? { supersedesId: live.id.toString() } : {}),
      },
    });
    return id;
  }
}
