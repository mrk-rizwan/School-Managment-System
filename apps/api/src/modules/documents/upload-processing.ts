import { Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';

// What an upload becomes before it is stored (contracts/slice-6.md §6.1, R42): the type is
// sniffed from the bytes (the declared type and the file name are ignored), only JPEG, PNG and
// PDF pass, and images are decoded and re-encoded by sharp, which bounds their pixel count,
// keeps the first frame only and drops every metadata block (EXIF, including a phone's GPS).

/** 5 MB: the upload limit and the CHECK on staged_uploads.size_bytes. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Decoded pixels allowed per image (≈ 40 MP): a decompression bomb is refused, not decoded. */
const MAX_INPUT_PIXELS = 40_000_000;

export type StoredMime = 'image/jpeg' | 'image/png' | 'application/pdf';

const EXTENSIONS: Readonly<Record<StoredMime, 'jpg' | 'png' | 'pdf'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

const isStoredMime = (mime: string): mime is StoredMime => Object.hasOwn(EXTENSIONS, mime);

/** The file extension of a stored type (for a download's file name). */
export const extensionOf = (mime: string): string =>
  isStoredMime(mime) ? EXTENSIONS[mime] : 'bin';

export const isImageMime = (mime: string): boolean => mime === 'image/jpeg' || mime === 'image/png';

export interface ProcessedUpload {
  mime: StoredMime;
  ext: 'jpg' | 'png' | 'pdf';
  body: Buffer;
}

// file-type is ESM-only and the API compiles to CommonJS with node10 resolution, so it is loaded
// through Node's own require (require(esm) is native from Node 22) and checked at runtime here.
interface FileTypeModule {
  fileTypeFromBuffer(input: Uint8Array): Promise<{ mime: string } | undefined>;
}
function isFileTypeModule(value: unknown): value is FileTypeModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileTypeFromBuffer' in value &&
    typeof value.fileTypeFromBuffer === 'function'
  );
}
function loadFileType(): FileTypeModule {
  const loaded: unknown = createRequire(__filename)('file-type');
  if (!isFileTypeModule(loaded)) throw new Error('file-type did not export fileTypeFromBuffer');
  return loaded;
}
const fileType = loadFileType();

const unsupported = (reason: string) =>
  new ApiException(
    415,
    ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    'Only JPEG, PNG and PDF files are accepted.',
    { reason },
  );

export const tooLarge = () =>
  new ApiException(413, ErrorCode.PAYLOAD_TOO_LARGE, 'The file is larger than 5 MB.');

/** The sniffed type of `input`, if it is one we store. */
export async function sniff(input: Buffer): Promise<StoredMime | null> {
  const detected = await fileType.fileTypeFromBuffer(input);
  const mime = detected?.mime;
  return mime !== undefined && isStoredMime(mime) ? mime : null;
}

/**
 * Sniffs and (for images) re-encodes one upload. 415 for any other type, or an image sharp will
 * not decode within the limits (`details.reason = 'image_rejected'`); 413 if the re-encoded
 * image is over 5 MB. A PDF is stored as received: it is only ever served as an attachment
 * under a sandbox CSP (R43).
 */
export async function processUpload(
  input: Buffer,
  reencodes: ConcurrencyLimit,
  logger: Logger,
): Promise<ProcessedUpload> {
  const mime = await sniff(input);
  if (mime === null) throw unsupported('type_not_allowed');
  const ext = EXTENSIONS[mime];
  if (mime === 'application/pdf') return { mime, ext, body: input };
  const body = await reencodes.run(async () => {
    try {
      const image = sharp(input, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
        // First frame only: an animated PNG becomes a still.
        pages: 1,
      }).autoOrient();
      return await (mime === 'image/jpeg' ? image.jpeg({ quality: 85 }) : image.png()).toBuffer();
    } catch (error) {
      // Log the class only: nothing of the decoder's message is needed.
      logger.warn(
        { errorClass: error instanceof Error ? error.constructor.name : typeof error },
        'image rejected',
      );
      throw unsupported('image_rejected');
    }
  });
  if (body.length > MAX_UPLOAD_BYTES) throw tooLarge();
  return { mime, ext, body };
}

/**
 * At most `max` holders at once per process; a caller that waits longer than `waitMs` for a slot
 * is refused with 503 (contract: 4 re-encodes, 10 s). FIFO.
 */
export class ConcurrencyLimit {
  private active = 0;
  private readonly waiting: { grant: () => void }[] = [];

  constructor(
    private readonly max: number,
    private readonly waitMs: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(
          new ApiException(
            503,
            ErrorCode.SERVICE_UNAVAILABLE,
            'The service is busy. Try the upload again shortly.',
          ),
        );
      }, this.waitMs);
      this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes straight to the next waiter; `active` is unchanged.
    if (next) next.grant();
    else this.active--;
  }
}
