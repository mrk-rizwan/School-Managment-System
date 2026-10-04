import { ApiError, describeApiError, ErrorCode } from '@asms/shared';
import { toast } from 'sonner';
import type { components } from './school';

// ApiError, toApiError, rateLimitMessage, describeApiError and ApiFieldError live in
// @asms/shared since slice 15 (contracts/slice-15.md §2.5): the mobile app needs them too.
// Re-exported here so no web importer changes.
export {
  ApiError,
  describeApiError,
  rateLimitMessage,
  toApiError,
  type ApiFieldError,
} from '@asms/shared';

/** The API's one error envelope (plan §3.9), as generated from the OpenAPI document. */
export type ApiErrorEnvelope = components['schemas']['ApiErrorDto'];

/** The toast for a failed action. */
export function toastApiError(error: unknown) {
  toast.error(describeApiError(error));
}

/**
 * A screen's refusal sentences, keyed by error code, or by `CODE:reason` for one
 * `details.reason`; the reason-specific entry wins. A function builds the sentence from the
 * error's details. A refusal the table does not name is `describeApiError`.
 */
export type RefusalMessages = Partial<Record<string, string | ((details: Record<string, unknown>) => string)>>;

/** 403 `not_assigned_on_date`: one wording on every screen that can be refused it. */
export const NOT_ASSIGNED_ON_DATE = 'You were not assigned to this section on that date.';

/** Refusals of an action on someone else's account or staff record (`noun`). */
function accountRefusals(noun: 'account' | 'record'): RefusalMessages {
  return {
    [`${ErrorCode.PERMISSION_DENIED}:target_is_principal`]: `Only someone who manages roles can change a principal’s ${noun}.`,
    [`${ErrorCode.PERMISSION_DENIED}:target_exceeds_actor`]: `This person can do things you cannot, so you cannot change their ${noun}.`,
    [`${ErrorCode.PERMISSION_DENIED}:role_exceeds_actor`]: 'You can only give a role whose permissions you hold yourself.',
    [ErrorCode.LAST_PRINCIPAL]: 'This is the school’s only active principal. Appoint another principal first.',
    [ErrorCode.SELF_ACTION_FORBIDDEN]: `You cannot do this to your own ${noun}. Ask another member of staff.`,
    [ErrorCode.IDENTITY_NUMBER_MISSING]:
      'This person has no identity number on record, so there is no default password to reset to.',
  };
}

/**
 * The sentence for a refusal, in words the user can act on: from `messages`, or, given a noun,
 * for an action on someone else's account or staff record. A refusal with field errors, or one
 * the table does not name, is `describeApiError`.
 */
export function refusalMessage(error: unknown, messages: RefusalMessages | 'account' | 'record'): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    const table = typeof messages === 'string' ? accountRefusals(messages) : messages;
    const details = (error.details ?? {}) as Record<string, unknown>;
    const reason = typeof details.reason === 'string' ? details.reason : null;
    const message = (reason !== null ? table[`${error.code}:${reason}`] : undefined) ?? table[error.code];
    if (message !== undefined) return typeof message === 'function' ? message(details) : message;
  }
  return describeApiError(error);
}
