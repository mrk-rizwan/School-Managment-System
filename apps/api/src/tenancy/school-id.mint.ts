// The only constructors of SchoolId (plan §3.1). Importing this file is restricted by lint
// (apps/api/eslint.config.mjs): the named-exception repositories may use everything except
// fromPlatformSchool, src/modules/platform/** may use only fromPlatformSchool. Every SchoolId
// therefore originates from a row the server itself read or wrote: a session, the pre-auth school
// lookup, the scheduler fan-out, or a school the platform has just created.
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

/** Exception 3: the scheduler fan-out, one job per active school. */
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

/**
 * Exception 1: the platform acting inside a school, for exactly two operations. Slice 1: creating
 * the school (its settings and counters), from the row SchoolRepository.create returned. Slice 2:
 * issuing the principal's login, which adds its own branded row type rather than widening this
 * one. Never an id from a request or a row read back by id. Importable only from
 * src/modules/platform/**.
 */
export function fromPlatformSchool(school: CreatedSchoolRow): SchoolId {
  return brand(school.id);
}
