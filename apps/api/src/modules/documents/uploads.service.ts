import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { SchoolContext } from '../../common/school-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import type { StagedUploadDto } from './documents.dto';
import { ConcurrencyLimit, processUpload } from './upload-processing';

/** How long a staged upload stays usable (contract §6.1). */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60_000;

/** Injection token of the re-encode limit, so a test can supply a smaller one. */
export const REENCODE_LIMIT = Symbol('REENCODE_LIMIT');
/** Contract §6.1 decision 10: 4 re-encodes at once per process, 503 after waiting 10 s. */
export const reencodeLimitProvider = {
  provide: REENCODE_LIMIT,
  useFactory: () => new ConcurrencyLimit(4, 10_000),
};

/**
 * POST /uploads (contracts/slice-6.md §6.1). The object is stored once, under a ULID name in the
 * school's prefix, and never moved: committing it to a document records the same key (R42).
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger('UploadsService');

  constructor(
    private readonly context: SchoolContext,
    private readonly staged: StagedUploadRepository,
    private readonly storage: ObjectStorage,
    @Inject(REENCODE_LIMIT) private readonly reencodes: ConcurrencyLimit,
  ) {}

  async stage(input: Buffer): Promise<StagedUploadDto> {
    const { schoolId, userId } = this.context.actor();
    const processed = await processUpload(input, this.reencodes, this.logger);
    const objectKey = `${schoolId}/${ulid()}.${processed.ext}`;
    // The row first: every object the store holds then has a row the sweep reads, so no crash
    // between the two writes can leave an object nothing will ever delete.
    const row = await this.staged.create(schoolId, {
      uploadedBy: userId,
      objectKey,
      mime: processed.mime,
      sizeBytes: processed.body.length,
      expiresAt: new Date(Date.now() + STAGED_UPLOAD_TTL_MS),
    });
    try {
      await this.storage.put(objectKey, processed.body, processed.mime);
    } catch (error) {
      // The write may have landed even so (a timeout): expire the row so the next sweep deletes
      // the object, if any, and then the row. If this fails too, it expires in 24 hours.
      await this.staged.expireUnconsumed(schoolId, row).catch((cleanup: unknown) =>
        this.logger.error(
          {
            stagedUploadId: row.id.toString(),
            errorClass: cleanup instanceof Error ? cleanup.constructor.name : typeof cleanup,
          },
          'failed upload could not be expired',
        ),
      );
      throw error;
    }
    this.logger.log({ stagedUploadId: row.id.toString(), mime: row.mime }, 'upload staged');
    return {
      id: row.id.toString(),
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      expiresAt: row.expiresAt,
    };
  }
}
