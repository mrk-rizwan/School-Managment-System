// Constructors of Scope. Importable only from src/modules/access/** (the permission service),
// enforced by lint.
import type { DatedScope, MarksMode, MarksScope, Scope, SectionRoles } from './scope';

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

type UnbrandedMarksScope<M extends MarksMode> = { readonly mode: M } & (
  | { readonly kind: 'all'; readonly on: Date }
  | { readonly kind: 'sections'; readonly on: Date; readonly sections: ReadonlyMap<bigint, SectionRoles> }
);

const brandMarks = <M extends MarksMode>(scope: UnbrandedMarksScope<M>): MarksScope<M> => scope as MarksScope<M>;

/** phase-4-academic.md §0.27: school-wide marks scope on `on`, for reading or for writing. */
export function marksScopeAll<M extends MarksMode>(mode: M, on: Date): MarksScope<M> {
  return brandMarks({ mode, kind: 'all', on: new Date(on.getTime()) });
}

/**
 * The sections and subjects held on `on` (from teacher_assignments), for reading or for writing.
 * Copied deeply, so a caller cannot widen the scope by mutating its map or a section's subject
 * list afterwards.
 */
export function marksScopeSections<M extends MarksMode>(
  mode: M,
  on: Date,
  sections: ReadonlyMap<bigint, SectionRoles>,
): MarksScope<M> {
  const copy = new Map<bigint, SectionRoles>();
  for (const [sectionId, roles] of sections) {
    copy.set(sectionId, { classTeacher: roles.classTeacher, cover: roles.cover, subjectIds: [...roles.subjectIds] });
  }
  return brandMarks({ mode, kind: 'sections', on: new Date(on.getTime()), sections: copy });
}
