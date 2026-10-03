import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table staged_uploads (contracts/slice-6.md §6.1, R41, R90, R91): an uploaded object
// not yet committed to a document, usable only by its uploader until it expires. The object key
// never leaves the server.

export interface StagedUploadRecord {
  id: bigint;
  uploadedBy: bigint;
  objectKey: string;
  mime: string;
  sizeBytes: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface StagedUploadWrite {
  uploadedBy: bigint;
  objectKey: string;
  mime: string;
  sizeBytes: number;
  expiresAt: Date;
}

const SELECT = {
  id: true,
  uploadedBy: true,
  objectKey: true,
  mime: true,
  sizeBytes: true,
  expiresAt: true,
  consumedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class StagedUploadRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(schoolId: SchoolId, data: StagedUploadWrite): Promise<StagedUploadRecord> {
    return this.txHost.tx.stagedUpload.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /** The rows of these ids uploaded by `userId`, in any state; other users' rows are absent. */
  findOwned(
    schoolId: SchoolId,
    userId: bigint,
    ids: readonly bigint[],
  ): Promise<StagedUploadRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.txHost.tx.stagedUpload.findMany({
      where: { schoolId, uploadedBy: userId, id: { in: [...ids] } },
      select: SELECT,
    });
  }

  /**
   * Consumes the row in one conditional update (R91): only its uploader, only once, only before
   * it expires. False when any condition fails; the caller cannot tell which, by design. A
   * concurrent consumer of the same row waits on the row lock and then sees consumed_at set.
   */
  async consume(schoolId: SchoolId, userId: bigint, id: bigint, now: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.stagedUpload.updateMany({
      where: { schoolId, id, uploadedBy: userId, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  /**
   * Expires an unconsumed row at once (expires_at = created_at + 1 ms, the earliest the CHECK
   * allows), so it can no longer be consumed and the sweep deletes its object, if any, and then
   * the row. For an upload whose object write failed: the write may still have landed, so the row
   * is kept for the sweep rather than removed.
   */
  async expireUnconsumed(
    schoolId: SchoolId,
    row: Pick<StagedUploadRecord, 'id' | 'createdAt'>,
  ): Promise<void> {
    await this.txHost.tx.stagedUpload.updateMany({
      where: { schoolId, id: row.id, consumedAt: null },
      data: { expiresAt: new Date(row.createdAt.getTime() + 1) },
    });
  }

  /** Unconsumed rows that expired before `before`, oldest first: the sweep's work list. */
  listExpiredUnconsumed(
    schoolId: SchoolId,
    before: Date,
    take: number,
  ): Promise<StagedUploadRecord[]> {
    return this.txHost.tx.stagedUpload.findMany({
      where: { schoolId, consumedAt: null, expiresAt: { lt: before } },
      select: SELECT,
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /**
   * Deletes the row only while it is still unconsumed and expired before `before` (R90): a row
   * consumed meanwhile is a committed document's object and stays. Returns rows deleted.
   */
  async deleteExpiredUnconsumed(schoolId: SchoolId, id: bigint, before: Date): Promise<number> {
    const { count } = await this.txHost.tx.stagedUpload.deleteMany({
      where: { schoolId, id, consumedAt: null, expiresAt: { lt: before } },
    });
    return count;
  }
}
