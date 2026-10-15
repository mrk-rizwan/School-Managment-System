import { PrismaPg } from '@prisma/adapter-pg';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { PrismaClient } from './generated/prisma/client';
import { inSupportContext } from '../tenancy/support-flag';
import { assertQueryAllowed, assertSupportRead } from './query-guard';

export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

/**
 * The only Prisma client the application builds: every model operation passes the query guard,
 * and during a platform support read (exception 7) every operation, raw ones included, must be a
 * read (contracts/slice-45.md §3).
 */
export function createGuardedClient(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) }).$extends({
    name: 'queryGuard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertQueryAllowed(model, operation, args);
          assertSupportRead(model, operation, inSupportContext());
          return query(args);
        },
      },
      $allOperations({ model, operation, args, query }) {
        if (model === undefined) assertSupportRead(undefined, operation, inSupportContext());
        return query(args);
      },
    },
  });
}

export type GuardedPrismaClient = ReturnType<typeof createGuardedClient>;

/** Repositories inject `TransactionHost<PrismaTxAdapter>` and query through `txHost.tx`. */
export type PrismaTxAdapter = TransactionalAdapterPrisma<GuardedPrismaClient>;

/**
 * A search term for Prisma's contains / startsWith: LIKE wildcards and the escape character
 * escaped with Postgres's default escape (a backslash). Prisma passes the value into LIKE
 * unescaped (measured on 7.10), so an unescaped `%` would match everything.
 */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);
