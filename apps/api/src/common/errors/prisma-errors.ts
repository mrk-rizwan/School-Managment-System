// Maps a database constraint violation to the API error it means (plan §3.8). Constraint names
// are stable identifiers; Prisma 7's own error codes and messages say little about which rule
// fired. Prisma may be imported only in src/repositories/**, so errors are recognised by shape.
//
// SECURITY: a Prisma error's meta carries the database's message and DETAIL, and a CHECK
// violation's DETAIL is the whole failing row ("Failing row contains (...)": password hashes,
// ciphertext, identity numbers). Nothing here returns or logs either; only the Prisma code and
// the constraint name leave this file.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';

/** What may be logged about a database error. */
export interface DatabaseErrorSummary {
  prismaCode: string;
  constraint: string | null;
}

const PRISMA_CODE = /^P\d{4}$/;
// Our trigger functions RAISE with DETAIL = 'constraint: <name>' (migration
// 20261002163440_trigger_errors_name_constraint): the adapter drops the protocol's constraint
// field for SQLSTATE 23514, but forwards DETAIL.
const DETAIL_CONSTRAINT = /^constraint: (\S+)$/;
const CHECK_MESSAGE = /violates check constraint "([^"]+)"/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The Prisma code of a known-request error; undefined for anything else. */
const prismaCodeOf = (error: unknown): string | undefined => {
  const code = str(field(error, 'code'));
  return code !== undefined && PRISMA_CODE.test(code) ? code : undefined;
};

const adapterCause = (error: unknown): unknown =>
  field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');

/**
 * The constraint a Prisma error names, read from the shapes measured on Prisma 7.10 + adapter-pg:
 * - P2002 / P2003: `meta.driverAdapterError.cause.constraint.index`;
 * - P2039 (SQLSTATE 23514, CHECK or trigger): `cause.detail` matching `constraint: <name>`, else
 *   `cause.originalMessage` matching `violates check constraint "<name>"`.
 * Undefined when `error` is not a Prisma known-request error.
 */
export function summariseDatabaseError(error: unknown): DatabaseErrorSummary | undefined {
  const prismaCode = prismaCodeOf(error);
  if (prismaCode === undefined) return undefined;
  const cause = adapterCause(error);
  const constraint =
    str(field(field(cause, 'constraint'), 'index')) ??
    DETAIL_CONSTRAINT.exec(str(field(cause, 'detail')) ?? '')?.[1] ??
    CHECK_MESSAGE.exec(str(field(cause, 'originalMessage')) ?? '')?.[1] ??
    null;
  return { prismaCode, constraint };
}

const fieldInvalid = (path: string, message: string) =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code: ErrorCode.INVALID_VALUE, message }],
  });

/** A 409 refusal naming the field it concerns. */
const taken = (code: ErrorCode, field: string, message: string) =>
  new ApiException(409, code, message, { field });

/** Constraint name → the refusal it means. Every other constraint is a 500 (a bug, not input). */
const BY_CONSTRAINT: Readonly<Record<string, () => ApiException>> = {
  schools_short_code_key: () =>
    new ApiException(409, ErrorCode.SCHOOL_SHORT_CODE_TAKEN, 'That short code is already in use.', {
      field: 'shortCode',
    }),
  schools_short_code_immutable: () =>
    new ApiException(
      409,
      ErrorCode.SCHOOL_SHORT_CODE_IMMUTABLE,
      'A school short code cannot be changed.',
      { field: 'shortCode' },
    ),
  school_settings_fee_due_day_check: () =>
    fieldInvalid('feeDueDay', 'feeDueDay must be between 1 and 28'),
  // Slice 3 (contracts/slice-3.md §6).
  academic_years_school_id_name_key: () =>
    taken(ErrorCode.ACADEMIC_YEAR_NAME_TAKEN, 'name', 'That academic year name is already in use.'),
  academic_years_dates_check: () => fieldInvalid('endsOn', 'endsOn must be after startsOn'),
  classes_school_id_academic_year_id_name_key: () =>
    taken(ErrorCode.CLASS_NAME_TAKEN, 'name', 'That year already has a class of that name.'),
  // The trigger refusing a year change on a class with sections. Slices 4 and 6 add their
  // (school_id, class_id, academic_year_id) ON UPDATE RESTRICT foreign keys here, same code.
  classes_academic_year_immutable: () =>
    taken(
      ErrorCode.CLASS_YEAR_IMMUTABLE,
      'academicYearId',
      'The academic year of a class cannot change once it has sections.',
    ),
  sections_school_id_class_id_name_key: () =>
    taken(ErrorCode.SECTION_NAME_TAKEN, 'name', 'That class already has a section of that name.'),
  subjects_school_id_name_key: () =>
    taken(ErrorCode.SUBJECT_NAME_TAKEN, 'name', 'A subject of that name already exists.'),
  subjects_school_id_code_key: () =>
    taken(ErrorCode.SUBJECT_CODE_TAKEN, 'code', 'A subject with that code already exists.'),
};

/**
 * A deadlock (SQLSTATE 40P01) or write conflict: the transaction was rolled back and a retry
 * may succeed. Shapes measured on Prisma 7.10 + adapter-pg (test/core/deadlock.e2e-spec.ts): a
 * model call fails P2034, a raw query P2010; both carry `cause.originalCode` 40P01. Our
 * read-then-lock order should never deadlock; this is the safety net if it does.
 */
function isConcurrencyFailure(error: unknown): boolean {
  const prismaCode = prismaCodeOf(error);
  if (prismaCode === undefined) return false;
  return prismaCode === 'P2034' || str(field(adapterCause(error), 'originalCode')) === '40P01';
}

/** The API error for a database constraint violation, or undefined when it maps to none. */
export function mapDatabaseError(error: unknown): ApiException | undefined {
  if (isConcurrencyFailure(error)) {
    return concurrentUpdate();
  }
  const constraint = summariseDatabaseError(error)?.constraint;
  if (!constraint || !Object.hasOwn(BY_CONSTRAINT, constraint)) return undefined;
  return BY_CONSTRAINT[constraint]?.();
}
