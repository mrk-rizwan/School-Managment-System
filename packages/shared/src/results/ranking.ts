/**
 * The class-wide ranking (Phase 5 rule 38, phase-5-extended.md §1.1 "Class ranking", §3.3; R333).
 * The merit list ranks every student of a class-term across its sections by the live published
 * term result's `percentBp`, with the same standard competition ranking a section uses (Phase 4
 * R260, `positions`), so the two can never disagree on how a tie is broken. The report card keeps
 * printing the section position.
 */
import { positions } from './compose';

export interface RankingInput {
  readonly resultId: string;
  readonly studentId: string;
  /** Null for a student with nothing assessed: listed, never positioned. */
  readonly percentBp: number | null;
}

export interface RankedRow extends RankingInput {
  readonly classPosition: number | null;
  readonly positionOf: number | null;
}

/**
 * Standard competition ranking (1, 1, 3) by `percentBp` across the class; ties share a position;
 * `positionOf` counts the positioned students. Returned best first (position ascending, unranked
 * last); equal positions keep their input order.
 */
export function classRanking(rows: readonly RankingInput[]): RankedRow[] {
  const placed = positions(rows);
  return rows
    .map((row, i) => ({ row, i, place: placed[i] ?? { position: null, positionOf: null } }))
    .sort((a, b) => (a.place.position ?? Infinity) - (b.place.position ?? Infinity) || a.i - b.i)
    .map(({ row, place }) => ({ ...row, classPosition: place.position, positionOf: place.positionOf }));
}
