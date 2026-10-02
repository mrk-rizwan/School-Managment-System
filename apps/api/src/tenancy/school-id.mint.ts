// The only constructors of SchoolId (plan §3.1). Importing this file is restricted by lint
// (apps/api/eslint.config.mjs): the named-exception repositories may use the first three,
// src/modules/platform/** may use only fromPlatformSchool. Every SchoolId therefore originates
// from a row the server itself read: a session, the pre-auth school lookup, the scheduler
// fan-out, or the platform's own school record.
import type { SchoolId } from './school-id';

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

/** Exception 3: the scheduler fan-out, one job per active school. */
export function schoolIdsForFanOut(schools: readonly { readonly id: bigint }[]): SchoolId[] {
  return schools.map((school) => brand(school.id));
}

/**
 * Exception 1: the platform issuing a principal's login, its one operation inside a school.
 * Importable only from src/modules/platform/**.
 */
export function fromPlatformSchool(school: { readonly id: bigint }): SchoolId {
  return brand(school.id);
}
