import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { ApiException, notFound } from '../../common/errors/api-exception';
import {
  ObjectNotFoundError,
  ObjectStorage,
  type StoredObject,
} from '../../common/storage/object-storage';
import type { DiaryAttachment, DiaryEntryRecord } from '../../repositories/diary-entry.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { extensionOf, isImageMime, thumbnail, type ConcurrencyLimit } from '../documents/upload-processing';
import { REENCODE_LIMIT } from '../documents/uploads.service';

/** What a controller streams: the body and its §6.2 headers. */
export interface DiaryFile {
  body: Readable | Buffer;
  mime: string;
  sizeBytes: number;
  filename: string;
}

/** Where an attachment's thumbnail is stored: beside the object, under the same school prefix. */
export const thumbnailKey = (objectKey: string): string => `${objectKey}-thumb.jpg`;

/**
 * A diary entry's attachment and its thumbnail (contracts/slice-13.md §4.5, §6.3). The thumbnail
 * of an image is made once, when the attachment is consumed (after commit), and stored beside the
 * object; a read serves the stored one, and makes and stores it on first request for an entry
 * attached before thumbnails were stored (or whose store failed). The caller has already decided
 * the entry is visible to the reader; this only opens it. Streamed by the API, never a presigned
 * URL; logged by entry id, never audited (no GET writes a row).
 */
@Injectable()
export class DiaryAttachmentsService {
  private readonly logger = new Logger('DiaryAttachments');

  constructor(
    private readonly storage: ObjectStorage,
    @Inject(REENCODE_LIMIT) private readonly reencodes: ConcurrencyLimit,
  ) {}

  async attachment(schoolId: SchoolId, entry: DiaryEntryRecord): Promise<DiaryFile> {
    const { key, mime, sizeBytes } = this.stored(entry);
    const object = await this.open(schoolId, entry.id, key);
    this.logger.log({ diaryEntryId: entry.id.toString() }, 'diary attachment served');
    return {
      body: object.body,
      mime,
      sizeBytes,
      filename: `diary-${entry.id}.${extensionOf(mime)}`,
    };
  }

  /**
   * After commit of the consuming write: the image's thumbnail, made through the re-encode limit
   * and stored at thumbnailKey. A PDF has none. A failure is logged (by the after-commit runner)
   * and the first read makes it instead.
   */
  async storeThumbnail(schoolId: SchoolId, attachment: DiaryAttachment): Promise<void> {
    if (!isImageMime(attachment.mime) || !attachment.objectKey.startsWith(`${schoolId}/`)) return;
    const original = await this.storage.get(attachment.objectKey);
    const bytes = await thumbnail(await buffer(original.body), this.reencodes);
    await this.storage.put(thumbnailKey(attachment.objectKey), bytes, 'image/jpeg');
  }

  /** A JPEG of at most 320 × 320 from the stored image; a PDF has none (404). */
  async thumbnail(schoolId: SchoolId, entry: DiaryEntryRecord): Promise<DiaryFile> {
    const { key, mime } = this.stored(entry);
    if (!isImageMime(mime)) throw notFound();
    const bytes = await this.storedThumbnail(schoolId, entry.id, key);
    this.logger.log({ diaryEntryId: entry.id.toString() }, 'diary thumbnail served');
    return {
      body: bytes,
      mime: 'image/jpeg',
      sizeBytes: bytes.length,
      filename: `diary-${entry.id}-thumb.jpg`,
    };
  }

  /** The stored thumbnail, or (none stored yet) one made now from the image and stored. */
  private async storedThumbnail(schoolId: SchoolId, entryId: bigint, key: string): Promise<Buffer> {
    this.assertInSchool(schoolId, entryId, key);
    try {
      return await buffer((await this.storage.get(thumbnailKey(key))).body);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
    const object = await this.open(schoolId, entryId, key);
    const bytes = await thumbnail(await buffer(object.body), this.reencodes);
    await this.storage.put(thumbnailKey(key), bytes, 'image/jpeg');
    return bytes;
  }

  private stored(entry: DiaryEntryRecord): { key: string; mime: string; sizeBytes: number } {
    const { attachmentObjectKey: key, attachmentMime: mime, attachmentSizeBytes: sizeBytes } =
      entry;
    if (key === null || mime === null || sizeBytes === null) throw notFound();
    return { key, mime, sizeBytes };
  }

  /** The key must sit in the school's prefix (also a CHECK); anything else is a logged fault. */
  private assertInSchool(schoolId: SchoolId, entryId: bigint, key: string): void {
    if (!key.startsWith(`${schoolId}/`)) {
      this.logger.error({ diaryEntryId: entryId.toString() }, 'diary object key outside the school prefix');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
  }

  private async open(schoolId: SchoolId, entryId: bigint, key: string): Promise<StoredObject> {
    const diaryEntryId = entryId.toString();
    this.assertInSchool(schoolId, entryId, key);
    try {
      return await this.storage.get(key);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
      this.logger.error({ diaryEntryId }, 'diary object missing from storage');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
  }
}
