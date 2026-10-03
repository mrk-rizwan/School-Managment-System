import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table idempotency_keys (contracts/slice-6.md §6.3, R33, R82-R89). A row holds the
// key, an HMAC of the request and the subject it created: no identity digits, no response body.

/** Lower-case route key of an idempotent endpoint (CHECK idempotency_keys_endpoint_check). */
export type IdempotentEndpoint = 'admissions';

/** The unique index a racing second insert of the same key fails on (R89). */
export const IDEMPOTENCY_KEY_UNIQUE = 'idempotency_keys_school_id_user_id_endpoint_key_key';

export interface IdempotencyKeyRecord {
  id: bigint;
  requestHash: string;
  responseStatus: number;
  subjectType: string;
  subjectId: bigint | null;
}

const SELECT = {
  id: true,
  requestHash: true,
  responseStatus: true,
  subjectType: true,
  subjectId: true,
} as const;

@Injectable()
export class IdempotencyKeyRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Per user and endpoint (R84): another user's equal key is a different row. */
  find(
    schoolId: SchoolId,
    userId: bigint,
    endpoint: IdempotentEndpoint,
    key: string,
  ): Promise<IdempotencyKeyRecord | null> {
    return this.txHost.tx.idempotencyKey.findFirst({
      where: { schoolId, userId, endpoint, key },
      select: SELECT,
    });
  }

  /**
   * The first statement of the idempotent unit of work. A concurrent insert of the same key waits
   * on the unique index and then fails with IDEMPOTENCY_KEY_UNIQUE once this one commits. The
   * subject is set by setSubject before commit (deferred trigger idempotency_keys_subject_required).
   */
  async insert(
    schoolId: SchoolId,
    data: {
      userId: bigint;
      endpoint: IdempotentEndpoint;
      key: string;
      requestHash: string;
      responseStatus: number;
      subjectType: string;
    },
  ): Promise<bigint> {
    const row = await this.txHost.tx.idempotencyKey.create({
      data: { schoolId, ...data, subjectId: null },
      select: { id: true },
    });
    return row.id;
  }

  async setSubject(schoolId: SchoolId, id: bigint, subjectId: bigint): Promise<void> {
    await this.txHost.tx.idempotencyKey.update({
      where: { schoolId_id: { schoolId, id } },
      data: { subjectId },
      select: { id: true },
    });
  }
}
