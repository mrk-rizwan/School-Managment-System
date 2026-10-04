import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { ObjectNotFoundError, ObjectStorage, type StoredObject } from '../../common/storage/object-storage';
import type { SchoolId } from '../../tenancy/school-id';
import { extensionOf, isImageMime, thumbnail, type ConcurrencyLimit } from './upload-processing';
import { REENCODE_LIMIT } from './uploads.service';

/** A consumed staged upload as a row stores it (diary entries, announcements). */
export interface StoredAttachment {
  objectKey: string;
  mime: string;
  sizeBytes: number;
}

/** What a controller streams: the body and its headers (contracts/slice-13.md §4.5). */
export interface AttachedFile {
  body: Readable | Buffer;
  mime: string;
  sizeBytes: number;
  filename: string;
}

/** Where an attachment's thumbnail is stored: beside the object, under the same school prefix. */
export const thumbnailKey = (objectKey: string): string => `${objectKey}-thumb.jpg`;

/** The row's attachment columns, or 404 when it has none. */
export function storedAttachment(row: {
  attachmentObjectKey: string | null;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
}): StoredAttachment {
  const { attachmentObjectKey: objectKey, attachmentMime: mime, attachmentSizeBytes: sizeBytes } = row;
  if (objectKey === null || mime === null || sizeBytes === null) throw notFound();
  return { objectKey, mime, sizeBytes };
}

/**
 * An attachment and its thumbnail (contracts/slice-13.md §4.5, slice-14.md §5.10, §7.5), for the
 * diary and announcements alike. The thumbnail of an image is made once, when the attachment is
 * consumed (after commit), and stored beside the object; a read serves the stored one, and makes
 * and stores it on first request when it is missing. The caller has already decided the reader
 * may see the row; this only opens it. Streamed by the API, never a presigned URL (R43, R148);
 * logged by the caller's row id (`logContext`), never audited.
 */
@Injectable()
export class AttachmentFiles {
  private readonly logger = new Logger('AttachmentFiles');

  constructor(
    private readonly storage: ObjectStorage,
    @Inject(REENCODE_LIMIT) private readonly reencodes: ConcurrencyLimit,
  ) {}

  /** The object, named `<filenameBase>.<ext>`. */
  async open(
    schoolId: SchoolId,
    file: StoredAttachment,
    filenameBase: string,
    logContext: Record<string, string>,
  ): Promise<AttachedFile> {
    const object = await this.get(schoolId, file.objectKey, logContext);
    this.logger.log(logContext, 'attachment served');
    return {
      body: object.body,
      mime: file.mime,
      sizeBytes: file.sizeBytes,
      filename: `${filenameBase}.${extensionOf(file.mime)}`,
    };
  }

  /** A JPEG of at most 320 × 320 from the stored image, named `<filenameBase>-thumb.jpg`; a PDF has none (404). */
  async thumbnail(
    schoolId: SchoolId,
    file: StoredAttachment,
    filenameBase: string,
    logContext: Record<string, string>,
  ): Promise<AttachedFile> {
    if (!isImageMime(file.mime)) throw notFound();
    const bytes = await this.storedThumbnail(schoolId, file.objectKey, logContext);
    this.logger.log(logContext, 'thumbnail served');
    return { body: bytes, mime: 'image/jpeg', sizeBytes: bytes.length, filename: `${filenameBase}-thumb.jpg` };
  }

  /**
   * After commit of the consuming write: the image's thumbnail, made through the re-encode limit
   * and stored at thumbnailKey. A PDF has none. A failure is logged (by the after-commit runner)
   * and the first read makes it instead.
   */
  async storeThumbnail(schoolId: SchoolId, file: Pick<StoredAttachment, 'objectKey' | 'mime'>): Promise<void> {
    if (!isImageMime(file.mime) || !file.objectKey.startsWith(`${schoolId}/`)) return;
    const original = await this.storage.get(file.objectKey);
    const bytes = await thumbnail(await buffer(original.body), this.reencodes);
    await this.storage.put(thumbnailKey(file.objectKey), bytes, 'image/jpeg');
  }

  /** The stored thumbnail, or (none stored yet) one made now from the image and stored. */
  private async storedThumbnail(
    schoolId: SchoolId,
    key: string,
    logContext: Record<string, string>,
  ): Promise<Buffer> {
    this.assertInSchool(schoolId, key, logContext);
    try {
      return await buffer((await this.storage.get(thumbnailKey(key))).body);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
    const object = await this.get(schoolId, key, logContext);
    const bytes = await thumbnail(await buffer(object.body), this.reencodes);
    await this.storage.put(thumbnailKey(key), bytes, 'image/jpeg');
    return bytes;
  }

  /** The key must sit in the school's prefix (also a CHECK); anything else is a logged fault. */
  private assertInSchool(schoolId: SchoolId, key: string, logContext: Record<string, string>): void {
    if (!key.startsWith(`${schoolId}/`)) {
      this.logger.error(logContext, 'attachment object key outside the school prefix');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
  }

  private async get(schoolId: SchoolId, key: string, logContext: Record<string, string>): Promise<StoredObject> {
    this.assertInSchool(schoolId, key, logContext);
    try {
      return await this.storage.get(key);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
      this.logger.error(logContext, 'attachment object missing from storage');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
  }
}
