import { ErrorCode } from '@asms/shared';
import { toast } from 'sonner';
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

/**
 * One sentence for an error shown outside a form's fields: a 422's first field message (an
 * identity number in a reason, say), the 429 wait, or the API's own message.
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The request failed. Check your connection and try again.';
  if (error.status === 429) return rateLimitMessage(error);
  return error.fieldErrors[0]?.message ?? error.message;
}

/** The toast for a failed action. */
export function toastApiError(error: unknown) {
  toast.error(describeApiError(error));
}

/**
 * The sentence for a refusal of an action on someone else's account or staff record (`noun`),
 * in words the office can act on; anything else is `describeApiError`.
 */
export function refusalMessage(error: unknown, noun: 'account' | 'record'): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    const reason = (error.details as { reason?: unknown } | null)?.reason;
    if (error.code === ErrorCode.PERMISSION_DENIED) {
      if (reason === 'target_is_principal') {
        return `Only someone who manages roles can change a principal’s ${noun}.`;
      }
      if (reason === 'target_exceeds_actor') {
        return `This person can do things you cannot, so you cannot change their ${noun}.`;
      }
      if (reason === 'role_exceeds_actor') {
        return 'You can only give a role whose permissions you hold yourself.';
      }
    }
    if (error.code === ErrorCode.LAST_PRINCIPAL) {
      return 'This is the school’s only active principal. Appoint another principal first.';
    }
    if (error.code === ErrorCode.SELF_ACTION_FORBIDDEN) {
      return `You cannot do this to your own ${noun}. Ask another member of staff.`;
    }
    if (error.code === ErrorCode.IDENTITY_NUMBER_MISSING) {
      return 'This person has no identity number on record, so there is no default password to reset to.';
    }
  }
  return describeApiError(error);
}
