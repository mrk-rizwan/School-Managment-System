import { ErrorCode } from '@asms/shared';

/**
 * The one exception application code throws for an expected refusal. It carries its own
 * stable code, so the filter never has to guess one from a status.
 */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export interface FieldError {
  path: string;
  code: ErrorCode;
  message: string;
}

/** 404 for a row absent from the caller's school: never "exists elsewhere" (tenant isolation). */
export const notFound = (): ApiException =>
  new ApiException(404, ErrorCode.NOT_FOUND, 'Not found.');

/** 409 when the row kept changing under the request, or the database rolled it back (deadlock). */
export const concurrentUpdate = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.CONCURRENT_UPDATE,
    'The record changed while this request ran. Reload and try again.',
  );
