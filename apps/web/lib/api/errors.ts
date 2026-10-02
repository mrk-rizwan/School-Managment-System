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

  constructor(status: number, code: ErrorCode, message: string, details: unknown, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
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
    return new ApiError(response.status, code, message, details ?? null, requestId ?? null);
  }
  return new ApiError(
    response.status,
    response.status >= 500 ? ErrorCode.SERVICE_UNAVAILABLE : ErrorCode.UNEXPECTED_RESPONSE,
    'The server could not be reached. Try again in a moment.',
    null,
    null,
  );
}
