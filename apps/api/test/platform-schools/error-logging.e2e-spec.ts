// A database error that reaches the exception filter as a 500 must not put the failing row in
// the log: a CHECK violation's DETAIL is the whole row (password hash, ciphertext). Uses a real
// violation from the database and the real log pipeline (pino via the app's logger).
import type { ArgumentsHost } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { createTestApp } from '../core/app';
import { closeTestDb, testDb } from '../support/schools';

describe('500 logging of database errors', () => {
  let app: NestExpressApplication;
  const lines: string[] = [];

  beforeAll(async () => {
    app = await createTestApp({ logStream: { write: (line: string) => void lines.push(line) } });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** Runs the real filter over `exception` and returns the response status and new log lines. */
  function filter(exception: unknown): { status: number | undefined; logged: string } {
    const from = lines.length;
    let status: number | undefined;
    const res = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      json: () => undefined,
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }), getResponse: () => res }),
    } as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { status, logged: lines.slice(from).join('\n') };
  }

  it('a CHECK violation on platform_users logs neither the hash nor the failing row', async () => {
    // Not an argon2id string: refused by platform_users_password_hash_check.
    const secret = `plaintext-${randomBytes(8).toString('hex')}`;
    const error = await testDb()
      .platformUser.create({
        data: { email: `log-${randomBytes(4).toString('hex')}@example.test`, passwordHash: secret },
      })
      .catch((e: unknown) => e);

    // The raw error does carry the row: the test would be vacuous otherwise.
    expect(JSON.stringify(error, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toContain(
      secret,
    );

    const { status, logged } = filter(error);
    expect(status).toBe(500);
    expect(logged).toContain('request failed');
    expect(logged).toContain('P2039');
    expect(logged).toContain('platform_users_password_hash_check');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('Failing row');
  });

  it('a non-database error logs its class and stack, not its own properties', () => {
    class Boom extends Error {
      readonly payload = 'own-property-secret';
    }
    const { status, logged } = filter(new Boom('kaboom'));
    expect(status).toBe(500);
    expect(logged).toContain('Boom');
    expect(logged).toContain('kaboom');
    expect(logged).not.toContain('own-property-secret');
  });

  it('a Prisma client error without a code logs only its class', () => {
    class PrismaClientValidationError extends Error {}
    const { logged } = filter(
      new PrismaClientValidationError('Invalid invocation: { passwordHash: "argument-secret" }'),
    );
    expect(logged).toContain('PrismaClientValidationError');
    expect(logged).not.toContain('argument-secret');
  });
});
