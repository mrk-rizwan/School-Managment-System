import { PrismaPg } from '@prisma/adapter-pg';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { PrismaClient } from './generated/prisma/client';
import { assertQueryAllowed } from './query-guard';

export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

/** The only Prisma client the application builds: every model operation passes the query guard. */
export function createGuardedClient(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) }).$extends({
    name: 'queryGuard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertQueryAllowed(model, operation, args);
          return query(args);
        },
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
