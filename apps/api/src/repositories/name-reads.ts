import type { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Reads shared by the diary-entry and remark repositories (contracts/slice-13.md): the names a
// page of rows carries, and a student's live guardians. Each takes the caller's ambient client so
// it runs inside the caller's transaction, and filters school_id like any repository statement.

type Tx = TransactionHost<PrismaTxAdapter>['tx'];

/** A lookup from id to name; an id not in `rows` gives undefined. */
export function namesById(rows: readonly { id: bigint; name: string }[]): (id: bigint) => string | undefined {
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return (id) => byId.get(id);
}

const distinct = (ids: readonly bigint[]): bigint[] => [...new Set(ids)];

/** Subject names by id: one statement, none when `ids` is empty. */
export async function subjectNames(
  tx: Tx,
  schoolId: SchoolId,
  ids: readonly bigint[],
): Promise<(id: bigint) => string | undefined> {
  if (ids.length === 0) return () => undefined;
  return namesById(
    await tx.subject.findMany({
      where: { schoolId, id: { in: distinct(ids) } },
      select: { id: true, name: true },
    }),
  );
}

/** Staff full names by staff id: one statement, none when `ids` is empty. */
export async function staffNames(
  tx: Tx,
  schoolId: SchoolId,
  ids: readonly bigint[],
): Promise<(id: bigint) => string | undefined> {
  if (ids.length === 0) return () => undefined;
  const rows = await tx.staff.findMany({
    where: { schoolId, id: { in: distinct(ids) } },
    select: { id: true, fullName: true },
  });
  return namesById(rows.map((row) => ({ id: row.id, name: row.fullName })));
}

/**
 * Every not-merged guardian with a live link to one of the students, whatever its login flag (a
 * guardian without a login gets a visible suppression, not silence). Ascending ids, each once.
 */
export async function liveGuardiansOf(
  tx: Tx,
  schoolId: SchoolId,
  studentIds: readonly bigint[],
): Promise<bigint[]> {
  if (studentIds.length === 0) return [];
  const rows = await tx.guardian.findMany({
    where: {
      schoolId,
      mergedIntoId: null,
      studentLinks: { some: { endedAt: null, studentId: { in: distinct(studentIds) } } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}
