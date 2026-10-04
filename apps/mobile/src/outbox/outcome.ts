import { ATTENDANCE_STATUSES, ErrorCode, toApiError } from '@asms/shared';
import { z } from 'zod';
import { currentBearerToken } from '../api/client';
import type { Outcome } from './machine';

/** An outcome with what a lane's follow-up reads on a 2xx (slice-16 §10.3). */
export type SentOutcome = Outcome & {
  /** The parsed response body on a 2xx; the follow-up validates it and ignores it when malformed. */
  body?: unknown;
  /** The response's Date header on a 2xx: "saved on server at". */
  date?: string | null;
  /** The response's Preference-Applied header on a 2xx (`return=minimal`), else null. */
  preferenceApplied?: string | null;
};

/**
 * A response reduced to an Outcome. A 401 to a token since replaced (or already dropped by a loss)
 * is `stale_token`: the item waits, unblamed. A 401 to no token at all is the ordinary pause.
 */
export async function outcomeOf(response: Response, sentWith: string | null): Promise<SentOutcome> {
  if (response.status === 401 && sentWith !== null && sentWith !== currentBearerToken()) {
    return { kind: 'stale_token' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    return {
      kind: 'response',
      status: response.status,
      code: null,
      message: null,
      retryAfterSeconds: null,
      body,
      date: response.headers.get('Date'),
      preferenceApplied: response.headers.get('Preference-Applied'),
    };
  }
  const error = toApiError(response, body);
  return {
    kind: 'response',
    status: response.status,
    code: error.code,
    message: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
    details: retainedDetails(error.code, error.details),
  };
}

const Amendments = z.object({
  amendments: z.array(
    z.object({
      enrolmentId: z.string(),
      from: z.enum(ATTENDANCE_STATUSES).nullable(),
      to: z.enum(ATTENDANCE_STATUSES),
    }),
  ),
});

/**
 * The part of a refusal's details kept on the outbox row, as JSON, or null: only what a remedy
 * shows, rebuilt field by field so nothing else the server sent is stored (§7.6). Today: the
 * register's AMENDMENT_REASON_REQUIRED amendments — enrolment ids and statuses, never a name.
 */
export function retainedDetails(code: string, details: unknown): string | null {
  if (code !== ErrorCode.AMENDMENT_REASON_REQUIRED) return null;
  const parsed = Amendments.safeParse(details);
  if (!parsed.success) return null;
  return JSON.stringify({
    amendments: parsed.data.amendments.map(({ enrolmentId, from, to }) => ({ enrolmentId, from, to })),
  });
}
