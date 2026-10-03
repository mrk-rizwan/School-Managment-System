// Maps a database constraint violation to the API error it means (plan §3.8). Constraint names
// are stable identifiers; Prisma 7's own error codes and messages say little about which rule
// fired. Prisma may be imported only in src/repositories/**, so errors are recognised by shape.
//
// SECURITY: a Prisma error's meta carries the database's message and DETAIL, and a CHECK
// violation's DETAIL is the whole failing row ("Failing row contains (...)": password hashes,
// ciphertext, identity numbers). Nothing here returns or logs either; only the Prisma code and
// the constraint name leave this file.
import { ErrorCode } from '@asms/shared';
import { ApiException } from './api-exception';

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

/**
 * The constraint a Prisma error names, read from the shapes measured on Prisma 7.10 + adapter-pg:
 * - P2002 / P2003: `meta.driverAdapterError.cause.constraint.index`;
 * - P2039 (SQLSTATE 23514, CHECK or trigger): `cause.detail` matching `constraint: <name>`, else
 *   `cause.originalMessage` matching `violates check constraint "<name>"`.
 * Undefined when `error` is not a Prisma known-request error.
 */
export function summariseDatabaseError(error: unknown): DatabaseErrorSummary | undefined {
  const prismaCode = str(field(error, 'code'));
  if (prismaCode === undefined || !PRISMA_CODE.test(prismaCode)) return undefined;
  const cause = field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
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
};

/** The API error for a database constraint violation, or undefined when it maps to none. */
export function mapDatabaseError(error: unknown): ApiException | undefined {
  const constraint = summariseDatabaseError(error)?.constraint;
  if (!constraint || !Object.hasOwn(BY_CONSTRAINT, constraint)) return undefined;
  return BY_CONSTRAINT[constraint]?.();
}
