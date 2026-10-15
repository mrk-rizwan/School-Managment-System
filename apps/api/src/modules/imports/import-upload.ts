import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import type { Observable } from 'rxjs';
import { CSV_IMPORT_LIMITS, ErrorCode, containsIdentityNumber } from '@asms/shared';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';

// The request side of the two import previews (contracts/slice-43.md §1.1): a multipart body of
// one `file` part, the CSV, read into memory (≤ 2 MB, CSV_IMPORT_LIMITS.maxBytes), and at most
// three short text fields, which the ValidationPipe then checks as the route's DTO. Guards run
// first, so the session, the capability, the key and the throttle are all checked before a byte
// of the body is read. The file never reaches object storage: the preview keeps only its parsed
// rows (deviation from the plan's staged upload: staged_uploads admits no text/csv, §6 of the
// contract).

/** The CSV a preview read, with the name it was uploaded under. */
export interface ImportFile {
  bytes: Buffer;
  fileName: string;
}

const tooLarge = () =>
  new ApiException(413, ErrorCode.PAYLOAD_TOO_LARGE, 'The file is larger than 2 MB.');

function mapMulterError(error: unknown): ApiException {
  if (!(error instanceof MulterError)) {
    return new ApiException(400, ErrorCode.MALFORMED_REQUEST, 'The request could not be read.');
  }
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return tooLarge();
    case 'LIMIT_UNEXPECTED_FILE':
    case 'LIMIT_FILE_COUNT':
      return fieldRefused(error.field ?? 'file', ErrorCode.UNKNOWN_FIELD, 'Send one file, as "file"');
    default:
      return fieldRefused(error.field ?? '', ErrorCode.INVALID_VALUE, 'The form fields could not be read');
  }
}

@Injectable()
export class ImportFileInterceptor implements NestInterceptor {
  private readonly upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: CSV_IMPORT_LIMITS.maxBytes,
      files: 1,
      fields: 3,
      parts: 4,
      fieldNameSize: 32,
      fieldSize: 64,
    },
  }).single('file');

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    if (!req.is('multipart/form-data')) {
      throw fieldRefused('file', ErrorCode.INVALID_VALUE, 'Send the CSV as multipart/form-data, as "file"');
    }
    await new Promise<void>((resolve, reject) => {
      this.upload(req, res, (error: unknown) => {
        if (error) reject(mapMulterError(error));
        else resolve();
      });
    });
    importFile(req);
    return next.handle();
  }
}

/**
 * The name kept on the import (CHECKs imports_file_name_check, imports_file_name_no_id_check):
 * the last path segment, printable ASCII only, at most 120 characters; one that is blank or
 * carries an identity number becomes `import.csv` (it is shown back, never trusted).
 */
export function importFileName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').trim().slice(0, 120).trim();
  return ascii === '' || containsIdentityNumber(ascii) ? 'import.csv' : ascii;
}

/** The file ImportFileInterceptor read; 422 on `file` if there is none or it is empty. */
export function importFile(req: Request): ImportFile {
  if (!req.file || req.file.size === 0) throw fieldRefused('file', ErrorCode.INVALID_VALUE, 'file is required');
  return { bytes: req.file.buffer, fileName: importFileName(req.file.originalname) };
}
