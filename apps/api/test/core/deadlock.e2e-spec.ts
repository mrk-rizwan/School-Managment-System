// A real Postgres deadlock (40P01) reaches the API as 409 CONCURRENT_UPDATE, not 500. Two
// transactions each lock one school row, then each asks for the other's: Postgres aborts one.
// Also records the shapes the mapper keys on, so a Prisma upgrade that changes them fails here.
import { ErrorCode } from '@asms/shared';
import { mapDatabaseError, summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { closeTestDb, createSchool, testDb } from '../support/schools';

afterAll(closeTestDb);

type Tx = Parameters<Parameters<ReturnType<typeof testDb>['$transaction']>[0]>[0];

/** Runs two crossed transactions and returns the error of the one Postgres aborted. */
async function provokeDeadlock(
  secondWrite: (tx: Tx, id: bigint) => Promise<unknown>,
): Promise<unknown> {
  const [a, b] = [await createSchool(), await createSchool()];
  const db = testDb();
  let release!: () => void;
  const bothLocked = new Promise<void>((resolve) => (release = resolve));
  let locked = 0;
  const crossed = (first: bigint, second: bigint) =>
    db
      .$transaction(async (tx) => {
        await tx.school.update({ where: { id: first }, data: { name: 'Deadlock first' } });
        if (++locked === 2) release();
        await bothLocked;
        await secondWrite(tx, second);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  const errors = (await Promise.all([crossed(a.id, b.id), crossed(b.id, a.id)])).filter(
    (error) => error !== undefined,
  );
  expect(errors).toHaveLength(1);
  return errors[0];
}

describe('deadlock safety net', () => {
  it('a model call that deadlocks is P2034 and maps to 409 CONCURRENT_UPDATE', async () => {
    const error = await provokeDeadlock((tx, id) =>
      tx.school.update({ where: { id }, data: { name: 'Deadlock second' } }),
    );
    expect(error).toMatchObject({
      code: 'P2034',
      meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
    });
    expect(summariseDatabaseError(error)).toEqual({ prismaCode: 'P2034', constraint: null });
    expect(mapDatabaseError(error)).toMatchObject({ status: 409, code: ErrorCode.CONCURRENT_UPDATE });
  });

  it('a raw query that deadlocks is P2010 and maps to 409 CONCURRENT_UPDATE', async () => {
    const error = await provokeDeadlock(
      (tx, id) => tx.$executeRaw`UPDATE schools SET name = 'Deadlock second' WHERE id = ${id}`,
    );
    expect(error).toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
    });
    expect(mapDatabaseError(error)).toMatchObject({ status: 409, code: ErrorCode.CONCURRENT_UPDATE });
  });
});
