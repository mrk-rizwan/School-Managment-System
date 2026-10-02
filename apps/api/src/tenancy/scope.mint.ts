// Constructors of Scope. Importable only from src/modules/access/** (the permission service),
// enforced by lint.
import type { Scope } from './scope';

type UnbrandedScope =
  { readonly kind: 'all' } | { readonly kind: 'sections'; readonly ids: readonly bigint[] };

const brand = (scope: UnbrandedScope): Scope => scope as Scope;

export function scopeAll(): Scope {
  return brand({ kind: 'all' });
}

export function scopeSections(ids: readonly bigint[]): Scope {
  // Copied so a caller cannot widen the scope by mutating its array afterwards.
  return brand({ kind: 'sections', ids: [...ids] });
}
