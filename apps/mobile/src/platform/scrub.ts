// The R16 patterns (identity number, phone, token) as one pure function, applied to every log
// field before it is stored or printed (slice-15 §10, R155).

/** A run of 43+ base64url characters: a bearer token (43 characters) or anything token-like. */
const TOKEN = /[A-Za-z0-9_-]{43,}/g;
/** An identity number: 5-7-1 with dashes, or 13 or more consecutive digits. */
const IDENTITY = /\d{5}-\d{7}-\d|\d{13,}/g;
/**
 * A Pakistani mobile: +92 / 92 / 0, then 3xx, then seven digits; a space or dash may follow the
 * country code, the 3xx and the next three digits (+92 300 1234567, +92-300-1234567,
 * 0300 123 4567, 0300-123-4567).
 */
const PHONE = /(\+?92[\s-]?|0)3\d{2}[\s-]?\d{3}[\s-]?\d{4}/g;
/** An email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose values are dropped outright, whatever they hold (compared case-insensitively). */
const DROPPED_KEYS = new Set(
  [
    'password',
    'currentPassword',
    'newPassword',
    'token',
    'bearerToken',
    'pushToken',
    'authorization',
    'username',
    'body',
    'text',
    // Personal data by name (review L3): dropped whatever they hold.
    'email',
    'fullName',
    'name',
    'note',
    'remark',
    'cnic',
    'identity',
    // Slice 16 (§3.7): typed text and the arrays that could carry names.
    'topic',
    'assignment',
    'learningOutcome',
    'reason',
    'title',
    'studentFullName',
    'viaStudents',
    'marks',
    'audiences',
  ].map((key) => key.toLowerCase()),
);

/** True when typed text carries a phone number (refused before a write is saved, slice-16 §3.4). */
export function containsPhone(text: string): boolean {
  return new RegExp(PHONE.source).test(text);
}

export function scrubText(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(TOKEN, '[token]')
    .replace(IDENTITY, '[id]')
    .replace(PHONE, '[phone]');
}

/** A deep copy of `value` with every string scrubbed and every dropped key removed. */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[deep]';
  if (value instanceof Error) return errorFields(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    out[key] = scrub(field, depth + 1);
  }
  return out;
}

/**
 * An error as its name, code, status and scrubbed message — never the whole object. The name is
 * `errorName`, because a field called `name` is dropped as personal data.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const { code, status } = error as { code?: unknown; status?: unknown };
  return {
    errorName: error.name,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    message: scrubText(error.message),
  };
}
