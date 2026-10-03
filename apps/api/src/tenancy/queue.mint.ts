// The worker's way into a school (Phase 2 plan §4.1, contracts/slice-9.md §7.6, §7.12): the fifth
// SchoolId constructor and the only place the worker opens a CLS context. Importable only from
// src/jobs/** (eslint.config.mjs); it is the only importer of SchoolByIdRepository.
//
// A job payload is `{ schoolId, ...ids }`, every value a decimal id string. Anything else - an
// extra key, a non-numeric or out-of-range id, an unknown or terminated school - is DROPPED (the
// caller ends the job successfully without retrying), never retried. A suspended school runs
// exactly like an active one (owner's answer to item 13). The resolved ids carry no proof that
// their rows belong to the school: every processor's first statement is a claim scoped by the
// SchoolId, so a payload naming school B and a row of school A touches nothing (R105, R113).
import { Injectable, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { SchoolByIdRepository } from '../repositories/platform/school-by-id.repository';
import type { RequestContext } from './request-context';
import type { SchoolId } from './school-id';
import { schoolIdFromQueuePayload } from './school-id.mint';

/** As IdParam: a positive bigint in decimal, no leading zero, within Postgres bigint. */
const ID_STRING = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
// One check, not .regex().refine(): zod 4 runs a refinement even after the regex has failed, and
// BigInt('abc') would throw instead of dropping the job.
const idString = z
  .string()
  .refine((value) => ID_STRING.test(value) && BigInt(value) <= MAX_BIGINT);

function hasEvery<K extends string>(
  ids: Partial<Record<K, bigint>>,
  keys: readonly K[],
): ids is Record<K, bigint> {
  return keys.every((key) => ids[key] !== undefined);
}

/** A payload that resolved: the job's school, branded, and its other ids as bigints. */
export interface ResolvedJob<K extends string> {
  readonly schoolId: SchoolId;
  readonly ids: Readonly<Record<K, bigint>>;
}

@Injectable()
export class QueueTenancy {
  readonly #cls: ClsService<RequestContext>;

  constructor(
    cls: ClsService<RequestContext>,
    private readonly schools: SchoolByIdRepository,
  ) {
    this.#cls = cls;
  }

  /**
   * Validates `payload` strictly (`schoolId` plus exactly `idKeys`) and resolves its school.
   * Null means drop the job: log it without ids, do not retry.
   */
  async fromQueuePayload<K extends string>(
    payload: unknown,
    idKeys: readonly K[],
  ): Promise<ResolvedJob<K> | null> {
    if (idKeys.some((key) => key === 'schoolId')) {
      throw new Error('fromQueuePayload: schoolId is not an id key');
    }
    const shape: Record<string, typeof idString> = { schoolId: idString };
    for (const key of idKeys) shape[key] = idString;
    const parsed = z.strictObject(shape).safeParse(payload);
    if (!parsed.success) return null;
    // A strict object with every key required: each value is a validated id string.
    const values: Record<string, string | undefined> = parsed.data;
    const schoolId = values.schoolId;
    if (schoolId === undefined) return null;
    const school = await this.schools.findById(BigInt(schoolId));
    if (school === null || school.status === 'terminated') return null;
    const ids: Partial<Record<K, bigint>> = {};
    for (const key of idKeys) {
      const value = values[key];
      if (value !== undefined) ids[key] = BigInt(value);
    }
    if (!hasEvery(ids, idKeys)) return null;
    return { schoolId: schoolIdFromQueuePayload(school), ids };
  }

  /**
   * Runs one job body inside a fresh CLS context carrying only `schoolId`, so two jobs for two
   * schools running concurrently never share a tenant or an ambient transaction. Never nests into
   * a caller's context.
   */
  runAsSchool<T>(schoolId: SchoolId, fn: () => Promise<T>): Promise<T> {
    return this.#cls.run({ ifNested: 'override' }, () => {
      this.#cls.set('schoolId', schoolId);
      return fn();
    });
  }
}

/** Imported by the worker's jobs module (slice 9). */
@Module({ providers: [SchoolByIdRepository, QueueTenancy], exports: [QueueTenancy] })
export class QueueTenancyModule {}
