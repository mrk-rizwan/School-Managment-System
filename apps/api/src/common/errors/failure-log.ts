import { summariseDatabaseError } from './prisma-errors';

// Kept apart from the HTTP exception filter, which reads Express and pino-http request types: the
// worker, the seed script and the tenancy module log failures without pulling those in.

/**
 * What a 500 logs. Never the raw exception: its own properties are arbitrary, and a Prisma
 * error's message and meta carry the failing row (password hashes, ciphertext; prisma-errors.ts).
 * A database error logs its class, Prisma code and constraint name; any other Prisma client
 * error only its class (a validation error's message prints the call's arguments); any other
 * Error its class and stack; anything else only its type.
 */
export function failureLog(exception: unknown): Record<string, unknown> {
  const errorClass = exception instanceof Error ? exception.constructor.name : typeof exception;
  const database = summariseDatabaseError(exception);
  if (database) return { errorClass, ...database };
  if (errorClass.startsWith('PrismaClient')) return { errorClass };
  if (exception instanceof Error) return { errorClass, stack: exception.stack ?? null };
  return { errorClass };
}
