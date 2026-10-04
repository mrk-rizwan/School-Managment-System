// The slice-6 Idempotency-Key mechanism's shared pieces (contracts/slice-6.md §6.3,
// contracts/slice-13.md §3): the header's rules, checked by a guard so a missing or malformed key
// is refused before the body is validated (§3 step 4), the request hash, and the find-replay-run-
// recover sequence of a keyed create (IdempotentRequests). What a replay returns stays in each
// service: it differs per endpoint. Admissions keeps its own sequence (slice-6 §6.3 predates the
// path id in the hash and answers a reuse with its own message and stored status).
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ErrorCode, type IdempotentEndpoint } from '@asms/shared';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';
import {
  IDEMPOTENCY_KEY_UNIQUE,
  IdempotencyKeyRepository,
  type IdempotencyKeyRecord,
} from '../repositories/idempotency-key.repository';
import { ApiException } from './errors/api-exception';
import { recoverConstraint } from './errors/prisma-errors';
import type { Actor } from './school-context';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Generated once per form; never 13 consecutive digits (R82). */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const keyRefused = (message: string) =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path: IDEMPOTENCY_HEADER, code: ErrorCode.INVALID_VALUE, message }],
  });

/** The validated key, or the 422 naming the header. */
export function parseIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw keyRefused('The Idempotency-Key header is required');
  if (!KEY_PATTERN.test(raw)) {
    throw keyRefused('Idempotency-Key must be 16-64 characters of A-Z, a-z, 0-9, _ and -');
  }
  if (/[0-9]{13}/.test(raw)) {
    throw keyRefused('Idempotency-Key must not contain 13 consecutive digits');
  }
  return raw;
}

/**
 * Refuses a request without a valid key before the ValidationPipe runs (contracts/slice-13.md §3
 * step 4: guard, header, body). Used after the access guard on an idempotent route.
 */
@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    parseIdempotencyKey(context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_HEADER));
    return true;
  }
}

/** JSON with object keys sorted at every depth and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, member]) => `${JSON.stringify(k)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * HMAC-SHA256 under IDENTITY_HASH_KEY of `<endpoint>|<pathId>|<canonical body>` (contracts/
 * slice-13.md §3 item 2): the path id is hashed, so one key sent to two sections or two students
 * is a reuse, never a replay. Nothing of the body is stored.
 */
export function idempotencyRequestHash(
  hashKey: string,
  endpoint: IdempotentEndpoint,
  pathId: bigint,
  body: unknown,
): string {
  return createHmac('sha256', Buffer.from(hashKey, 'base64'))
    .update(`${endpoint}|${pathId}|${canonicalJson(body)}`)
    .digest('hex');
}

/** A different request under a used key, or a key whose unit of work never completed (§3 item 3). */
export const idempotencyKeyReused = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different request.',
  );

/** A keyed request's validated key and request hash, handed to its unit of work. */
export interface IdempotencyClaim {
  key: string;
  requestHash: string;
}

/** A replay names the stored subject; a first request carries what its unit of work returned. */
export type IdempotentOutcome<T> =
  | { replayed: true; subjectId: bigint }
  | { replayed: false; value: T };

/**
 * contracts/slice-13.md §3 for a keyed create: the key and the hash (path id included, so one key
 * sent to two paths is a reuse), a stored key's replay or 409 reuse, else `run` — one transaction
 * whose first statement is `claim` — and, when `run` loses a same-key race on
 * IDEMPOTENCY_KEY_UNIQUE (rolled back), the winner's replay read in a fresh statement.
 */
@Injectable()
export class IdempotentRequests {
  private readonly hashKey: string;

  constructor(
    private readonly keys: IdempotencyKeyRepository,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  async withIdempotencyKey<T>(
    actor: Actor,
    endpoint: IdempotentEndpoint,
    pathId: bigint,
    dto: unknown,
    rawKey: string | undefined,
    run: (claim: IdempotencyClaim) => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    const key = parseIdempotencyKey(rawKey);
    const claim = { key, requestHash: idempotencyRequestHash(this.hashKey, endpoint, pathId, dto) };
    const replay = (stored: IdempotencyKeyRecord): IdempotentOutcome<T> => {
      if (stored.requestHash !== claim.requestHash || stored.subjectId === null) {
        throw idempotencyKeyReused();
      }
      return { replayed: true, subjectId: stored.subjectId };
    };
    const stored = await this.keys.find(actor.schoolId, actor.userId, endpoint, key);
    if (stored) return replay(stored);
    return recoverConstraint(
      IDEMPOTENCY_KEY_UNIQUE,
      async (): Promise<IdempotentOutcome<T>> => ({ replayed: false, value: await run(claim) }),
      async (error) => {
        const winner = await this.keys.find(actor.schoolId, actor.userId, endpoint, key);
        if (!winner) throw error;
        return replay(winner);
      },
    );
  }

  /**
   * §3 step 1, the first statement of the unit of work: a racing same-key request now waits on
   * the unique index. Returns the step that records the created subject before commit.
   */
  async claim(
    actor: Actor,
    endpoint: IdempotentEndpoint,
    claim: IdempotencyClaim,
    subjectType: string,
  ): Promise<(subjectId: bigint) => Promise<void>> {
    const keyId = await this.keys.insert(actor.schoolId, {
      userId: actor.userId,
      endpoint,
      key: claim.key,
      requestHash: claim.requestHash,
      responseStatus: 201,
      subjectType,
    });
    return (subjectId) => this.keys.setSubject(actor.schoolId, keyId, subjectId);
  }
}
