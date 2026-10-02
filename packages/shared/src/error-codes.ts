/**
 * Stable machine-readable error codes. A code never changes meaning once shipped;
 * messages may change. Slices add codes here as they need them.
 */
export const ErrorCode = {
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SCHOOL_SUSPENDED: 'SCHOOL_SUSPENDED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  // Field-level: a value failed a shape rule (type, range, pattern). Used in details.fields only.
  INVALID_VALUE: 'INVALID_VALUE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Client-side only: the web app's label for a failed response whose body was not the error
  // envelope (a proxy page, say). The API never sends it.
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
