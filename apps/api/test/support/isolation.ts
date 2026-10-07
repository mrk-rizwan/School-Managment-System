// The per-table isolation check (CLAUDE.md control 4, R62): a row written as school A is
// invisible to, and unwritable by, school B. Each tenant table's test supplies the operations;
// the helper owns the assertions so every table is held to the same standard.
import type { SchoolId } from '../../src/tenancy/school-id';
import type { MarksMode, MarksScope, Scope, SectionRoles } from '../../src/tenancy/scope';
import { marksScopeSections, scopeStudents } from '../../src/tenancy/scope.mint';
import type { TwoSchools } from './schools';

export interface IsolationProbe<Id> {
  /** Creates one row owned by `schoolId` and returns its id. */
  create(schoolId: SchoolId): Promise<Id>;
  /** Reads one row by id as `schoolId`; must return null when the row belongs to another school. */
  read(schoolId: SchoolId, id: Id): Promise<unknown>;
  /** Lists rows as `schoolId`; must never include another school's row. */
  list?(schoolId: SchoolId): Promise<readonly { id: Id }[]>;
  /**
   * Attempts a change to the row as `schoolId`. Must either reject or report zero rows affected,
   * and the row must be unchanged when read back by its owner.
   */
  write?(schoolId: SchoolId, id: Id): Promise<number>;
  /** A value that changes when `write` succeeds, read as the owner. Required with `write`. */
  snapshot?(row: unknown): unknown;
}

export async function expectIsolated<Id>(
  { a, b }: TwoSchools,
  probe: IsolationProbe<Id>,
): Promise<void> {
  const id = await probe.create(a.id);

  // The owner can see it, so a null for B below means isolation rather than a broken probe.
  const owned = await probe.read(a.id, id);
  expect(owned).not.toBeNull();

  expect(await probe.read(b.id, id)).toBeNull();

  if (probe.list) {
    expect((await probe.list(a.id)).map((row) => row.id)).toContainEqual(id);
    expect((await probe.list(b.id)).map((row) => row.id)).not.toContainEqual(id);
  }

  if (probe.write) {
    if (!probe.snapshot)
      throw new Error('expectIsolated: write needs snapshot to prove the row is unchanged');
    const affected = await probe.write(b.id, id).catch(() => 0);
    expect(affected).toBe(0);
    expect(probe.snapshot(await probe.read(a.id, id))).toEqual(probe.snapshot(owned));
  }
}

/** A guardian or student capacity scope of exactly these students, to call a scoped repository directly. */
export const studentsScope = (ids: readonly bigint[]): Scope => scopeStudents(ids);

/** A sections MarksScope, to call a marks repository (wave N) or prove the mint copies its input. */
export const sectionsMarksScope = <M extends MarksMode>(
  mode: M,
  on: Date,
  sections: ReadonlyMap<bigint, SectionRoles>,
): MarksScope<M> => marksScopeSections(mode, on, sections);
