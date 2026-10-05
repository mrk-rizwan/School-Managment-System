import type { SubmitRegisterDto } from '../api/contracts';

// Coalescing by natural key (slice-15 §7.4, R158): a second write to a register (section, date,
// period) while a PENDING row for it exists merges into that row, so an offline correction
// becomes one submit, not a terminal failure. A row already SENDING is never touched: the write
// starts a new pending row, and later writes merge into that one. The partial unique index
// outbox_pending_natural_key makes a second pending row for one key impossible. The register
// (submit_register) is the one lane with a natural key.

/** A stored register body; a body stored before the wave-F fix may hold `reason: null`. */
type MarksBody = Omit<SubmitRegisterDto, 'reason'> & { reason?: string | null };

/** `section:<id>|date:<YYYY-MM-DD>|period:<n>` */
export function registerNaturalKey(sectionId: string, date: string, period: number): string {
  return `section:${sectionId}|date:${date}|period:${period}`;
}

/**
 * Marks merged by enrolmentId, latest wins; the newer reason when it is non-empty, else the
 * older one. `reason` is left out unless a non-empty one exists: the server takes it absent or
 * as text, and refuses null with a terminal 422 (wave-F review).
 */
export function mergeMarksBody(existing: MarksBody, incoming: MarksBody): MarksBody {
  const byEnrolment = new Map(existing.marks.map((mark) => [mark.enrolmentId, mark]));
  for (const mark of incoming.marks) byEnrolment.set(mark.enrolmentId, mark);
  const nonEmpty = (reason: unknown): reason is string =>
    typeof reason === 'string' && reason.trim() !== '';
  const reason = nonEmpty(incoming.reason)
    ? incoming.reason
    : nonEmpty(existing.reason)
      ? existing.reason
      : null;
  const { reason: _existingReason, ...existingRest } = existing;
  const { reason: _incomingReason, ...incomingRest } = incoming;
  return {
    ...existingRest,
    ...incomingRest,
    marks: [...byEnrolment.values()],
    ...(reason === null ? {} : { reason }),
  };
}

/** The merge used for a lane's bodies, serialised as stored. */
export function mergeBodies(existing: string, incoming: string): string {
  return JSON.stringify(
    mergeMarksBody(JSON.parse(existing) as MarksBody, JSON.parse(incoming) as MarksBody),
  );
}
