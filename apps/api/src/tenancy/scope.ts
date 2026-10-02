// Row scope over student-linked data (plan §3.4). Required, branded, and minted only by the
// permission service through ./scope.mint.ts, so a repository can never be handed "no filter".
// An empty `ids` list means no rows.
declare const scopeBrand: unique symbol;

export type Scope = (
  { readonly kind: 'all' } | { readonly kind: 'sections'; readonly ids: readonly bigint[] }
) & {
  readonly [scopeBrand]: true;
};
