// Row scope over student-linked data (plan §3.4). Required, branded, and minted only by the
// permission service through ./scope.mint.ts, so a repository can never be handed "no filter".
// An empty `ids` list means no rows. `students` is the guardian and student capacity scope of a
// @RequireCapacity route (contracts/slice-13.md §1.2, R163): exactly the listed students, with no
// enrolment condition, so a guardian keeps a child who has left while the link is live (R164).
declare const scopeBrand: unique symbol;

export type Scope = (
  | { readonly kind: 'all' }
  | { readonly kind: 'sections'; readonly ids: readonly bigint[] }
  | { readonly kind: 'students'; readonly ids: readonly bigint[] }
) & {
  readonly [scopeBrand]: true;
};

/** A staff member's roles in one section on one date (contracts/slice-10.md §7.1, R175). */
export interface SectionRoles {
  readonly classTeacher: boolean;
  readonly cover: boolean;
  /** Subjects taught in the section on that date; a whole-class subject row counts for every section. */
  readonly subjectIds: readonly bigint[];
}

declare const datedScopeBrand: unique symbol;

/**
 * The row scope a capability gives on one date, with the roles behind it (contracts/slice-10.md
 * §7.2). Minted only by the permission service through ./scope.mint.ts. An empty `sections` map
 * means no rows, never no filter.
 */
export type DatedScope = (
  | { readonly kind: 'all'; readonly on: Date }
  | {
      readonly kind: 'sections';
      readonly on: Date;
      readonly sections: ReadonlyMap<bigint, SectionRoles>;
    }
) & { readonly [datedScopeBrand]: true };

declare const marksScopeBrand: unique symbol;

/** What a MarksScope was minted for: reading marks, or writing them. */
export type MarksMode = 'read' | 'write';

/**
 * The subject-aware scope of the assessment and mark repositories (phase-4-academic.md §0.27,
 * §7.1): per section the subjects taught there on one date, and whether the caller is its class
 * teacher or covers it (R175), or school-wide (`all`) for a holder whose capability has a
 * school-wide source (the principal, an office grant of marks.enter). Minted only in
 * ./scope.mint.ts, by PermissionsService from teacher_assignments on that date (an assessment's
 * held_on for marks, today for sheets). A subject teacher writes only their subjects; a class
 * teacher (or cover) reads every subject of the section. An empty `sections` map means no rows,
 * never no filter.
 *
 * **Read and write scopes are distinct types** (security review LOW-1, 2026-10-07). `mode` is a
 * literal: `marksReadScopeOf` returns `MarksScope<'read'>` (marks.enter or marks.view_all, the
 * wider of the two), `marksWriteScopeOf` returns `MarksScope<'write'>` (marks.enter only, never
 * widened by marks.view_all). A repository method that writes takes `MarksScope<'write'>`, so a
 * read scope passed there is a compile error; a method that only reads takes `MarksScope` (either
 * mode — a write scope is never wider than the same caller's read scope).
 */
export type MarksScope<M extends MarksMode = MarksMode> = (
  | { readonly kind: 'all'; readonly on: Date }
  | {
      readonly kind: 'sections';
      readonly on: Date;
      readonly sections: ReadonlyMap<bigint, SectionRoles>;
    }
) & { readonly mode: M; readonly [marksScopeBrand]: true };
