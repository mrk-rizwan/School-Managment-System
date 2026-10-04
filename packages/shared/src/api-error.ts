import { ErrorCode } from './error-codes';

// The API's error envelope as a client sees it, and the helpers both clients (web and mobile)
// need. Moved from apps/web/lib/api/errors.ts (contracts/slice-15.md §2.5); the web re-exports
// these names, so no web importer changed. Typed structurally: no fetch or DOM type, no generated
// file, so the package stays usable from Node, the browser and React Native alike.

/** One entry of a 422 VALIDATION_FAILED response: `details.fields`. */
export type ApiFieldError = { path: string; code: string; message: string };

/** The envelope (plan §3.9). The web keeps its generated twin, `ApiErrorEnvelope`. */
export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string | null };
};

/** What toApiError reads from a response: its status and one header. */
export type ApiResponseLike = { status: number; headers: { get(name: string): string | null } };

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

function isEnvelope(body: unknown): body is ApiErrorBody {
  const e = (body as Partial<ApiErrorBody> | null)?.error;
  return typeof e?.code === 'string' && typeof e.message === 'string';
}

/**
 * Builds an ApiError from a failed response. A body that is not the envelope (the API is down
 * and the dev proxy answered, say) still becomes an ApiError, with a generic code.
 */
export function toApiError(response: ApiResponseLike, body: unknown): ApiError {
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

function retryAfterSeconds(response: ApiResponseLike): number | null {
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

/**
 * One sentence for an error shown outside a form's fields: a 422's first field message (an
 * identity number in a reason, say), the 429 wait, or the API's own message.
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError))
    return 'The request failed. Check your connection and try again.';
  if (error.status === 429) return rateLimitMessage(error);
  return error.fieldErrors[0]?.message ?? error.message;
}
