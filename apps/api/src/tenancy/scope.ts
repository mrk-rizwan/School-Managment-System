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
