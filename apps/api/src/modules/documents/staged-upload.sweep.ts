import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ObjectStorage } from '../../common/storage/object-storage';
// CLAUDE.md named exception 3, the scheduler fan-out: this file is listed in
// NAMED_EXCEPTION_SITES (eslint.config.mjs) and is the only importer of the fan-out repository.
import { SchoolFanOutRepository } from '../../repositories/platform/school-fan-out.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import type { SchoolId } from '../../tenancy/school-id';

/** Rows read per batch. */
const BATCH = 100;
/**
 * Extra age past expires_at before a row is swept. Consuming compares expires_at with the API
 * server's clock; the margin keeps a server whose clock runs behind from consuming a row whose
 * object another server has just deleted.
 */
export const SWEEP_GRACE_MS = 60 * 60_000;

export interface SweepResult {
  deleted: number;
  failed: number;
}

/**
 * The daily staged-upload sweep (contracts/slice-6.md §6.2, R41, R90): for every school,
 * suspended and terminated included, deletes the object and then the row of each upload that was
 * never consumed and has expired. A consumed row (a committed document's object) is never
 * touched: both the read and the delete require consumed_at IS NULL. An object that cannot be
 * deleted keeps its row, so the next run retries it.
 */
@Injectable()
export class StagedUploadSweep {
  private readonly logger = new Logger('StagedUploadSweep');

  constructor(
    private readonly fanOut: SchoolFanOutRepository,
    private readonly staged: StagedUploadRepository,
    private readonly storage: ObjectStorage,
  ) {}

  @Cron('0 30 2 * * *', { name: 'staged-upload-sweep', timeZone: 'Asia/Karachi' })
  async runDaily(): Promise<void> {
    try {
      const result = await this.sweepAll(new Date());
      this.logger.log(result, 'staged-upload sweep finished');
    } catch (error) {
      this.logger.error(
        { errorClass: error instanceof Error ? error.constructor.name : typeof error },
        'staged-upload sweep failed',
      );
    }
  }

  async sweepAll(now: Date): Promise<SweepResult> {
    const total: SweepResult = { deleted: 0, failed: 0 };
    for (const schoolId of await this.fanOut.listAllForFanOut()) {
      const result = await this.sweepSchool(schoolId, now);
      total.deleted += result.deleted;
      total.failed += result.failed;
    }
    return total;
  }

  async sweepSchool(schoolId: SchoolId, now: Date): Promise<SweepResult> {
    const before = new Date(now.getTime() - SWEEP_GRACE_MS);
    const result: SweepResult = { deleted: 0, failed: 0 };
    for (;;) {
      const rows = await this.staged.listExpiredUnconsumed(schoolId, before, BATCH);
      let progressed = false;
      for (const row of rows) {
        if (!row.objectKey.startsWith(`${schoolId}/`)) {
          this.logger.error(
            { stagedUploadId: row.id.toString() },
            'staged key outside the school prefix',
          );
          result.failed++;
          continue;
        }
        try {
          await this.storage.delete(row.objectKey);
        } catch (error) {
          this.logger.warn(
            {
              stagedUploadId: row.id.toString(),
              errorClass: error instanceof Error ? error.constructor.name : typeof error,
            },
            'staged object could not be deleted; retried next run',
          );
          result.failed++;
          continue;
        }
        result.deleted += await this.staged.deleteExpiredUnconsumed(schoolId, row.id, before);
        progressed = true;
      }
      // A short batch is the last; a full batch of failures would only be read again.
      if (rows.length < BATCH || !progressed) return result;
    }
  }
}

/** The sweep with the fan-out repository it needs, so only this file imports it. */
export const STAGED_UPLOAD_SWEEP_PROVIDERS = [StagedUploadSweep, SchoolFanOutRepository];
