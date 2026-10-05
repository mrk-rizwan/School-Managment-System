// The only constructors of SchoolId (plan §3.1; CLAUDE.md "The named exceptions"), six, one per
// path: fromPlatformSchool (exception 1), schoolIdFromLookup (2), schoolIdsForFanOut and
// schoolIdFromQueuePayload (3), schoolIdFromSession (4), schoolIdFromDeliveryReport (5).
// Importing this file is restricted by lint (apps/api/eslint.config.mjs): the named-exception
// repositories may use everything except fromPlatformSchool, src/tenancy calls the session and
// queue-payload constructors, and src/modules/platform/** may use only fromPlatformSchool. Every
// SchoolId therefore originates from a row the server itself read or wrote: a session, the pre-auth
// school lookup, the scheduler fan-out, a queue job's school, a delivery report's matched row, or a
// school the platform has just created or is issuing a principal login in.
import type { CreatedSchoolRow, SchoolId } from './school-id';

// The single cast in the codebase. Lint bans `as SchoolId` everywhere except this file.
const brand = (id: bigint): SchoolId => id as SchoolId;

/** The fields of a session row that SessionRepository.findActiveByTokenHash returns (slice 2). */
export interface ResolvedSessionRecord {
  readonly id: bigint;
  readonly schoolId: bigint;
  readonly userId: bigint;
}

/** Exception 4: session resolution. The session token is what establishes the tenant. */
export function schoolIdFromSession(session: ResolvedSessionRecord): SchoolId {
  return brand(session.schoolId);
}

/** Exception 2: the row returned by SchoolLookupRepository.findByCode at login / forgot-password. */
export function schoolIdFromLookup(school: { readonly id: bigint }): SchoolId {
  return brand(school.id);
}

/**
 * Exception 3 widened to job payloads (Phase 2 plan §4.1): the school row SchoolByIdRepository.findById read for a queue job's payload. Called only by
 * QueueTenancy.fromQueuePayload (./queue.mint.ts), after it has validated the payload and
 * dropped an unknown or terminated school.
 */
export function schoolIdFromQueuePayload(school: { readonly id: bigint }): SchoolId {
  return brand(school.id);
}

/**
 * Named exception 5 (contracts/slice-9.md §8.5): the school_id a DeliveryWebhookRepository
 * statement returned from the row it has just updated, matched by a globally unique key (the
 * hashed provider reference, the WAHA session, the Cloud API phone-number id). Called only by that
 * repository; the webhook enqueues it, and the job resolves it again through fromQueuePayload.
 */
export function schoolIdFromDeliveryReport(row: { readonly school_id: bigint }): SchoolId {
  return brand(row.school_id);
}

/** Exception 3: the scheduler fan-out, one job per school SchoolFanOutRepository listed. */
export function schoolIdsForFanOut(schools: readonly { readonly id: bigint }[]): SchoolId[] {
  return schools.map((school) => brand(school.id));
}

/**
 * Brands the row SchoolRepository.create has just inserted (its only caller). Importable from
 * src/repositories/platform/** but not from src/modules/platform/**, so the platform module holds
 * a CreatedSchoolRow only by creating a school.
 */
export function createdSchoolRow<T extends { readonly id: bigint }>(row: T): T & CreatedSchoolRow {
  return row as T & CreatedSchoolRow;
}

declare const principalIssueBrand: unique symbol;

/**
 * A school row SchoolRepository.lockForPrincipalIssue has just read under SELECT ... FOR UPDATE,
 * and nothing else (contract slice-2 §7). Like CreatedSchoolRow, the platform module can hold one
 * only by calling that method: the minting function below is importable from
 * src/repositories/platform/** and not from src/modules/platform/**.
 */
export type PrincipalIssueSchoolRow = { readonly id: bigint } & {
  readonly [principalIssueBrand]: true;
};

/** Brands the row SchoolRepository.lockForPrincipalIssue has just locked (its only caller). */
export function principalIssueSchoolRow<T extends { readonly id: bigint }>(
  row: T,
): T & PrincipalIssueSchoolRow {
  return row as T & PrincipalIssueSchoolRow;
}

/**
 * Exception 1: the platform acting inside a school, for exactly two operations. Slice 1: creating
 * the school (its settings and counters), from the row SchoolRepository.create returned. Slice 2:
 * issuing the principal's login, from the row SchoolRepository.lockForPrincipalIssue locked. Never
 * an id from a request or a row read back by id. Importable only from src/modules/platform/**.
 */
export function fromPlatformSchool(school: CreatedSchoolRow | PrincipalIssueSchoolRow): SchoolId {
  return brand(school.id);
}
