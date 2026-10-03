// F4 (Phase 1 security review): a Redis failure is logged by failureLog, never as the raw error.
// ioredis attaches the failed command, with its arguments, to the error object (`command.args`),
// and a lockout command's arguments carry the school code and the username hash.
import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Response } from 'express';
import { enforceRateLimits, RedisLockout } from './rate-limit';

const SECRET_ARG = 'abc123:6f1e0c9d8b7a6f5e4d3c2b1a0f9e8d7c';

/** Shaped as ioredis's ReplyError: the command and its arguments ride on the error object. */
class ReplyError extends Error {
  readonly command = { name: 'evalsha', args: [`asms:school-login:{${SECRET_ARG}}:failures`, SECRET_ARG] };
  constructor() {
    super('ERR something went wrong');
    this.name = 'ReplyError';
  }
}

const loggedPayloads = (logger: Logger) => {
  const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return () => spy.mock.calls.map((call) => call[0] as unknown);
};

const expectNoArgs = (payloads: unknown[]) => {
  expect(payloads).toHaveLength(1);
  const [payload] = payloads;
  expect(payload).not.toBeInstanceOf(Error);
  expect(payload).toMatchObject({ errorClass: 'ReplyError' });
  const text = JSON.stringify(payload);
  expect(text).not.toContain(SECRET_ARG);
  expect(text).not.toContain('evalsha');
  expect(Object.keys(payload as object).sort()).toEqual(['errorClass', 'stack']);
};

describe('rate-limit storage failures are logged without the command arguments', () => {
  it('enforceRateLimits: a throwing storage is a 503, and the log line is failureLog', async () => {
    const logger = new Logger('test');
    const payloads = loggedPayloads(logger);
    const storage: Pick<ThrottlerStorage, 'increment'> = {
      increment: () => Promise.reject(new ReplyError()),
    };
    await expect(
      enforceRateLimits(
        storage as ThrottlerStorage,
        {} as Response,
        [{ name: 'n', key: SECRET_ARG, limit: 1, ttlMs: 1000 }],
        logger,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expectNoArgs(payloads());
  });

  it('RedisLockout: a failing Redis command is a 503, and the log line is failureLog', async () => {
    const logger = new Logger('test');
    const payloads = loggedPayloads(logger);
    const storage = Object.create(ThrottlerStorageRedisService.prototype) as ThrottlerStorageRedisService;
    Object.defineProperty(storage, 'redis', {
      value: { call: () => Promise.reject(new ReplyError()) },
    });
    const lockout = new RedisLockout(storage, 'school-login', { failures: 5, durationMs: 1000 }, logger);
    await expect(lockout.recordFailure(SECRET_ARG)).rejects.toMatchObject({ status: 503 });
    expectNoArgs(payloads());
  });
});
