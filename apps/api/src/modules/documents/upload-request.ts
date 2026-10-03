import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import type { Observable } from 'rxjs';
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';
import { perUserThrottle } from '../../common/rate-limit';
import { MAX_UPLOAD_BYTES, tooLarge } from './upload-processing';

// The request side of POST /uploads, the one multipart route (plan §3.9). Guards run before
// interceptors, so the session, the capability and the per-user rate limit are all checked
// before a byte of the body is read.

/** Multer's refusals in our envelope. Its own messages are not used. */
function mapMulterError(error: unknown): ApiException {
  if (!(error instanceof MulterError)) {
    // busboy: a malformed multipart body (no boundary, truncated part).
    return new ApiException(400, ErrorCode.MALFORMED_REQUEST, 'The request could not be read.');
  }
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return tooLarge();
    case 'LIMIT_UNEXPECTED_FILE':
      return fieldRefused(
        error.field ?? 'file',
        ErrorCode.UNKNOWN_FIELD,
        'Send one file, as "file"',
      );
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return fieldRefused(
        error.field ?? '',
        ErrorCode.UNKNOWN_FIELD,
        'Only the "file" part is accepted',
      );
    default:
      return fieldRefused('file', ErrorCode.INVALID_VALUE, 'Send exactly one file, as "file"');
  }
}

/**
 * Reads exactly one file part named `file` into memory (multer memory storage, 5 MB, no other
 * part). A request without it, multipart or not, is 422 on `file`.
 */
@Injectable()
export class SingleFileInterceptor implements NestInterceptor {
  private readonly upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  }).single('file');

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    await new Promise<void>((resolve, reject) => {
      this.upload(req, res, (error: unknown) => {
        if (error) reject(mapMulterError(error));
        else resolve();
      });
    });
    uploadedFile(req);
    return next.handle();
  }
}

/** The file SingleFileInterceptor read; 422 on `file` if there is none. */
export function uploadedFile(req: Request): Buffer {
  if (!req.file) throw fieldRefused('file', ErrorCode.INVALID_VALUE, 'file is required');
  return req.file.buffer;
}

/** Per user: 20 uploads a minute, 200 an hour (contract §6.1), counted in Redis. */
export const UploadThrottleGuard = perUserThrottle('upload', 20, 200);
