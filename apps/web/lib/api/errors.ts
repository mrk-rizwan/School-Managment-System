import { ErrorCode } from '@asms/shared';
import type { components } from './school';

/** One entry of a 422 VALIDATION_FAILED response: `details.fields`. */
export type ApiFieldError = { path: string; code: string; message: string };

/** The API's one error envelope (plan §3.9), as generated from the OpenAPI document. */
export type ApiErrorEnvelope = components['schemas']['ApiErrorDto'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly requestId: string | null;
  /** Seconds from a 429's `Retry-After` header; null when absent or not a number of seconds. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details: unknown,
    requestId: string | null,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Field errors of a 422, or an empty list for anything else. */
  get fieldErrors(): ApiFieldError[] {
    if (this.status !== 422) return [];
    const fields = (this.details as { fields?: unknown } | null)?.fields;
    return Array.isArray(fields) ? fields.filter(isFieldError) : [];
  }
}

function isFieldError(value: unknown): value is ApiFieldError {
  const v = value as Partial<ApiFieldError> | null;
  return typeof v?.path === 'string' && typeof v.code === 'string' && typeof v.message === 'string';
}

function isEnvelope(body: unknown): body is ApiErrorEnvelope {
  const e = (body as Partial<ApiErrorEnvelope> | null)?.error;
  return typeof e?.code === 'string' && typeof e.message === 'string';
}

/**
 * Builds an ApiError from a failed response. A body that is not the envelope (the API is down
 * and the dev proxy answered, say) still becomes an ApiError, with a generic code.
 */
export function toApiError(response: Response, body: unknown): ApiError {
  if (isEnvelope(body)) {
    const { code, message, details, requestId } = body.error;
    return new ApiError(
      response.status,
      code,
      message,
      details ?? null,
      requestId ?? null,
      retryAfterSeconds(response),
    );
  }
  return new ApiError(
    response.status,
    response.status >= 500 ? ErrorCode.SERVICE_UNAVAILABLE : ErrorCode.UNEXPECTED_RESPONSE,
    'The server could not be reached. Try again in a moment.',
    null,
    null,
  );
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('Retry-After')?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/** The sentence shown for a 429: the wait from `Retry-After` when the API sent one. */
export function rateLimitMessage(error: ApiError): string {
  const seconds = error.retryAfterSeconds;
  if (seconds === null) return 'Too many attempts. Wait a moment and try again.';
  if (seconds < 60) return `Too many attempts. Try again in ${seconds} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** One sentence for an error shown at form level: the API's message, or the 429 wait. */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The request failed. Check your connection and try again.';
  if (error.status === 429) return rateLimitMessage(error);
  return error.message;
}
