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
import { fieldInvalid } from './constraints.shared';
import { SLICE_19_CONSTRAINTS } from './constraints-charges';
import { SLICE_23_CONSTRAINTS } from './constraints-expenses';
import { SLICE_24_CONSTRAINTS } from './constraints-leave';
import { SLICE_26_CONSTRAINTS } from './constraints-billing';
import { SLICE_20_CONSTRAINTS } from './constraints-payments';
import { SLICE_25_CONSTRAINTS } from './constraints-payroll';
import { SLICE_21_CONSTRAINTS } from './constraints-claims';
import { SLICE_29_CONSTRAINTS } from './constraints-academics';
import { PHASE_5_GROUNDWORK_CONSTRAINTS } from './constraints-phase5';

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
// SQLSTATE 23P01 (an EXCLUDE constraint): the adapter forwards no constraint field and Prisma
// reports P2039; the name is only in the message, `... violates exclusion constraint "<name>"`.
const EXCLUSION_MESSAGE = /violates exclusion constraint "([^"]+)"/;

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
 *   `cause.originalMessage` matching `violates check constraint "<name>"`;
 * - P2039 with `cause.originalCode` 23P01 (EXCLUDE): `cause.originalMessage` matching
 *   `violates exclusion constraint "<name>"`.
 * Undefined when `error` is not a Prisma known-request error.
 */
export function summariseDatabaseError(error: unknown): DatabaseErrorSummary | undefined {
  const prismaCode = prismaCodeOf(error);
  if (prismaCode === undefined) return undefined;
  const cause = adapterCause(error);
  const message = str(field(cause, 'originalMessage')) ?? '';
  const exclusion =
    str(field(cause, 'originalCode')) === '23P01' ? EXCLUSION_MESSAGE.exec(message)?.[1] : undefined;
  const constraint =
    str(field(field(cause, 'constraint'), 'index')) ??
    DETAIL_CONSTRAINT.exec(str(field(cause, 'detail')) ?? '')?.[1] ??
    CHECK_MESSAGE.exec(message)?.[1] ??
    exclusion ??
    null;
  return { prismaCode, constraint };
}

/**
 * The race loser of a unique or exclusion constraint. `run` is a whole transaction; when it fails
 * on `constraint` the transaction is already rolled back, so `recover` answers from a fresh
 * statement outside it: it returns a result, or throws the refusal the in-transaction check would
 * have given (or the original `error` when the winner cannot be found). Any other error is
 * rethrown unchanged.
 */
export async function recoverConstraint<T>(
  constraint: string,
  run: () => Promise<T>,
  recover: (error: unknown) => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (summariseDatabaseError(error)?.constraint !== constraint) throw error;
    return recover(error);
  }
}

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
  school_settings_fee_due_day_check: fieldInvalid('feeDueDay', 'feeDueDay must be between 1 and 28'),
  // Slice 3 (contracts/slice-3.md §6).
  academic_years_school_id_name_key: () =>
    taken(ErrorCode.ACADEMIC_YEAR_NAME_TAKEN, 'name', 'That academic year name is already in use.'),
  academic_years_dates_check: fieldInvalid('endsOn', 'endsOn must be after startsOn'),
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
  // Slice 4 (contracts/slice-4.md §6). The services catch the first three outside their
  // transaction and answer with the contract's details (the existing row's id, the conflicting
  // class teachers), read in a fresh statement; these entries are the fallback.
  staff_school_id_cnic_hash_key: () =>
    taken(ErrorCode.STAFF_CNIC_EXISTS, 'cnic', 'A staff member with this CNIC already exists.'),
  teacher_assignments_class_teacher_excl: () =>
    taken(
      ErrorCode.CLASS_TEACHER_EXISTS,
      'sectionId',
      'The section already has a class teacher for those dates.',
    ),
  user_roles_school_id_user_id_system_role_key: () =>
    taken(ErrorCode.ROLE_ALREADY_ASSIGNED, 'systemRole', 'The user already holds that role.'),
  // ON UPDATE RESTRICT: a class's year cannot change while an assignment names the class, even
  // before it has a section. An assignment insert locks its class first, so never hits this.
  teacher_assignments_class_id_fkey: () =>
    taken(
      ErrorCode.CLASS_YEAR_IMMUTABLE,
      'academicYearId',
      'The academic year of a class cannot change once teachers are assigned to it.',
    ),
  // Slice 6 (contracts/slice-6.md), here so the slice-6 services need not edit this file.
  students_school_id_b_form_hash_key: () =>
    taken(ErrorCode.STUDENT_BFORM_EXISTS, 'bForm', 'A student with this B-Form already exists.'),
  student_guardians_live_pair_key: () =>
    taken(
      ErrorCode.GUARDIAN_LINK_EXISTS,
      'guardianId',
      'This guardian is already linked to the student.',
    ),
  enrolments_section_roll_no_key: () =>
    taken(ErrorCode.ROLL_NO_TAKEN, 'rollNo', 'That roll number is taken in the section.'),
  users_school_id_student_id_key: () =>
    taken(ErrorCode.LOGIN_ALREADY_EXISTS, 'studentId', 'This student already has a login.'),
  // contracts/slice-10.md §10. HolidaysService answers it with details.holidayId first.
  holidays_live_excl: () =>
    new ApiException(409, ErrorCode.HOLIDAY_DATES_TAKEN, 'Those dates overlap another holiday.'),
  // contracts/slice-12.md §5. StaffAttendanceService answers the natural-key race itself; the
  // not-self trigger is unreachable after its own check, mapped so it can never become a 500.
  staff_attendance_natural_key: concurrentUpdate,
  // contracts/slice-11.md §4.2: the submit inserts on both natural keys with ON CONFLICT under the
  // register's lock, so neither race should reach here; mapped so it is a retryable 409, never 500.
  attendance_registers_natural_key: concurrentUpdate,
  attendance_marks_natural_key: concurrentUpdate,
  staff_attendance_not_self: () =>
    new ApiException(
      409,
      ErrorCode.SELF_ACTION_FORBIDDEN,
      'Nobody marks or amends their own attendance.',
    ),
  // contracts/slice-13.md §8. The services answer both races with the contract's details (the
  // existing entry's id, the successor's id) read in a fresh statement; these are the fallback.
  diary_entries_natural_key: () =>
    new ApiException(
      409,
      ErrorCode.DIARY_ENTRY_EXISTS,
      'The diary for this date and subject is already written.',
    ),
  remarks_supersedes_id_key: () =>
    new ApiException(409, ErrorCode.REMARK_SUPERSEDED, 'This remark has already been corrected.'),
  // Phase 3 slice 18. The services refuse each with the holder's id first; these are the
  // fallback for a concurrent write.
  fee_heads_live_name_key: () =>
    new ApiException(409, ErrorCode.FEE_HEAD_NAME_TAKEN, 'A fee head of that name already exists.'),
  fee_heads_one_tuition_key: () =>
    new ApiException(409, ErrorCode.FEE_HEAD_CATEGORY_TAKEN, 'The school already has a tuition head.'),
  fee_heads_one_fine_key: () =>
    new ApiException(409, ErrorCode.FEE_HEAD_CATEGORY_TAKEN, 'The school already has a fine head.'),
  fee_structures_active_key: () =>
    new ApiException(
      409,
      ErrorCode.FEE_STRUCTURE_EXISTS,
      'This class already has an amount for that head from that month.',
    ),
  // ON UPDATE RESTRICT: a class's year cannot change once fee amounts name the class.
  fee_structures_class_id_fkey: () =>
    taken(
      ErrorCode.CLASS_YEAR_IMMUTABLE,
      'academicYearId',
      'The academic year of a class cannot change once fees are set for it.',
    ),
  school_settings_late_fee_enabled_check: fieldInvalid('lateFeeAmount', 'lateFeeAmount is required while late fees are enabled'),
  ...SLICE_19_CONSTRAINTS,
  ...SLICE_23_CONSTRAINTS,
  ...SLICE_24_CONSTRAINTS,
  ...SLICE_26_CONSTRAINTS,
  ...SLICE_20_CONSTRAINTS,
  ...SLICE_25_CONSTRAINTS,
  ...SLICE_21_CONSTRAINTS,
  ...SLICE_29_CONSTRAINTS,
  ...PHASE_5_GROUNDWORK_CONSTRAINTS,
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
