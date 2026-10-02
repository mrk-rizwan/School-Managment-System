// Slice-0 verification required by plan §3.2: an inspect-only query extension must not split an
// interactive transaction into separate ones (the class of Prisma issue #23583). Each case holds
// a row lock inside a transaction opened through the guarded client, then probes the same row
// from an unrelated connection with NOWAIT. Had any statement escaped the transaction, it would
// have autocommitted, its lock would be gone and the probe would succeed.
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { EnvModule } from '../config/env';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PRISMA_CLIENT, type GuardedPrismaClient, type PrismaTxAdapter } from './prisma';
import { QueryGuardError } from './query-guard';

const LOCK_NOT_AVAILABLE = '55P03';

describe('interactive transactions through the guarded client', () => {
  let prisma: GuardedPrismaClient;
  let cls: ClsService;
  let txHost: TransactionHost<PrismaTxAdapter>;
  let probe: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    prisma = moduleRef.get(PRISMA_CLIENT);
    cls = moduleRef.get(ClsService);
    txHost = moduleRef.get(TransactionHost);
    probe = new Client({ connectionString: process.env.DATABASE_URL });
    await probe.connect();
  });

  afterAll(async () => {
    await probe.end();
    await close();
  });

  const newSchool = () =>
    prisma.school.create({
      data: { name: 'Atomicity', shortCode: `ta${randomUUID().replace(/-/g, '').slice(0, 10)}` },
    });

  // Resolves to the Postgres error code, or 'acquired' when the row was free.
  const tryLock = async (id: bigint): Promise<string> => {
    await probe.query('BEGIN');
    try {
      await probe.query('SELECT id FROM schools WHERE id = $1 FOR UPDATE NOWAIT', [id.toString()]);
      return 'acquired';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await probe.query('ROLLBACK');
    }
  };

  it('keeps a FOR UPDATE lock across later guarded statements (TransactionHost)', async () => {
    const school = await newSchool();
    const seen: string[] = [];

    await cls.run(() =>
      txHost.withTransaction(async () => {
        await txHost.tx.$queryRaw`SELECT id FROM schools WHERE id = ${school.id} FOR UPDATE`;
        seen.push(await tryLock(school.id));
        // Guarded model operations after the lock: these are the statements an extension could
        // have routed outside the transaction.
        await txHost.tx.school.findFirst({ where: { id: school.id } });
        await txHost.tx.school.update({ where: { id: school.id }, data: { name: 'Locked' } });
        seen.push(await tryLock(school.id));
      }),
    );

    expect(seen).toEqual([LOCK_NOT_AVAILABLE, LOCK_NOT_AVAILABLE]);
    expect(await tryLock(school.id)).toBe('acquired');
  });

  it('holds the row lock taken by a guarded model write until commit ($transaction)', async () => {
    const school = await newSchool();
    let during = '';

    await prisma.$transaction(async (tx) => {
      await tx.school.update({ where: { id: school.id }, data: { name: 'Written' } });
      during = await tryLock(school.id);
    });

    expect(during).toBe(LOCK_NOT_AVAILABLE);
    expect(await tryLock(school.id)).toBe('acquired');
  });

  // Control: proves the probe can tell. A write made on the root client while a transaction is
  // open runs on its own connection, autocommits, and leaves the row free.
  it('control: a statement outside the transaction does not hold the lock', async () => {
    const school = await newSchool();
    let during = '';

    await prisma.$transaction(async () => {
      await prisma.school.update({ where: { id: school.id }, data: { name: 'Outside' } });
      during = await tryLock(school.id);
    });

    expect(during).toBe('acquired');
  });

  it('rolls back every guarded statement when the unit of work fails', async () => {
    const school = await newSchool();

    await expect(
      cls.run(() =>
        txHost.withTransaction(async () => {
          await txHost.tx.school.update({
            where: { id: school.id },
            data: { name: 'Should vanish' },
          });
          throw new Error('abort');
        }),
      ),
    ).rejects.toThrow('abort');

    const after = await prisma.school.findFirst({ where: { id: school.id } });
    expect(after?.name).toBe('Atomicity');
  });

  it('runs the guard on the transaction client too', async () => {
    const lookup: { id?: bigint } = {};
    await expect(
      cls.run(() =>
        txHost.withTransaction(() => txHost.tx.school.findFirst({ where: { id: lookup.id } })),
      ),
    ).rejects.toThrow(QueryGuardError);
  });

  it('is wired on the application client', async () => {
    const code: { value?: string } = {};
    await expect(prisma.school.findFirst({ where: { shortCode: code.value } })).rejects.toThrow(
      QueryGuardError,
    );
  });

  it('has strictUndefinedChecks on: an undefined in data is rejected by Prisma itself', async () => {
    const optional: { timezone?: string } = {};
    await expect(
      prisma.school.create({
        data: { name: 'x', shortCode: 'never', timezone: optional.timezone },
      }),
    ).rejects.toThrow(/undefined/i);
  });
});
