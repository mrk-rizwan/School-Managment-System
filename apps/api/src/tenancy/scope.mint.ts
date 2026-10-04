// Constructors of Scope. Importable only from src/modules/access/** (the permission service),
// enforced by lint.
import type { DatedScope, Scope, SectionRoles } from './scope';

type UnbrandedScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'sections'; readonly ids: readonly bigint[] }
  | { readonly kind: 'students'; readonly ids: readonly bigint[] };

const brand = (scope: UnbrandedScope): Scope => scope as Scope;

export function scopeAll(): Scope {
  return brand({ kind: 'all' });
}

export function scopeSections(ids: readonly bigint[]): Scope {
  // Copied so a caller cannot widen the scope by mutating its array afterwards.
  return brand({ kind: 'sections', ids: [...ids] });
}

/**
 * The capacity scope of a guardian or student route (contracts/slice-13.md §1.2): exactly these
 * students. An empty list means no rows, never no filter (control 7).
 */
export function scopeStudents(ids: readonly bigint[]): Scope {
  return brand({ kind: 'students', ids: [...ids] });
}

const brandDated = (
  scope:
    | { readonly kind: 'all'; readonly on: Date }
    | { readonly kind: 'sections'; readonly on: Date; readonly sections: ReadonlyMap<bigint, SectionRoles> },
): DatedScope => scope as DatedScope;

export function datedScopeAll(on: Date): DatedScope {
  return brandDated({ kind: 'all', on: new Date(on.getTime()) });
}

export function datedScopeSections(on: Date, sections: ReadonlyMap<bigint, SectionRoles>): DatedScope {
  // Copied so a caller cannot widen the scope by mutating its map afterwards.
  return brandDated({ kind: 'sections', on: new Date(on.getTime()), sections: new Map(sections) });
}
