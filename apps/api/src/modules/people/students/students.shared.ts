// Pieces shared by the students, guardian-link and enrolment services (contracts/slice-6.md), and
// exported for the admission and readmission services (slice 6B) so their refusals match.
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused } from '../../../common/errors/api-exception';

/** The partial unique index behind R25. */
export const B_FORM_UNIQUE = 'students_school_id_b_form_hash_key';
export const ROLL_NO_UNIQUE = 'enrolments_section_roll_no_key';

export const studentBFormExists = (details: { studentId: string; readmissible?: boolean }) =>
  new ApiException(
    409,
    ErrorCode.STUDENT_BFORM_EXISTS,
    'A student with this B-Form number already exists.',
    details,
  );

export const illegalTransition = (details: Record<string, string>, message: string) =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, message, details);

export const primaryContactNeedsPhone = () =>
  new ApiException(
    409,
    ErrorCode.PRIMARY_CONTACT_NEEDS_PHONE,
    'A guardian without a phone number cannot be the primary contact.',
  );

export const primaryContactRequired = () =>
  new ApiException(
    409,
    ErrorCode.PRIMARY_CONTACT_REQUIRED,
    'A student must keep one primary contact. Make another guardian primary first.',
  );

export const feePayerRequired = () =>
  new ApiException(
    409,
    ErrorCode.FEE_PAYER_REQUIRED,
    'A student must keep at least one fee payer. Mark another guardian as fee payer first.',
  );

export const enrolmentNotActive = () =>
  new ApiException(409, ErrorCode.ENROLMENT_NOT_ACTIVE, 'This enrolment is no longer active.');

export const rollNoTaken = (enrolmentId: bigint) =>
  new ApiException(409, ErrorCode.ROLL_NO_TAKEN, 'That roll number is taken in this section.', {
    enrolmentId: enrolmentId.toString(),
  });

/** `date` is not after `today` (both DATE values, UTC midnight); else 422 on `path`. */
export function assertNotFuture(date: Date, today: Date, path: string): void {
  if (date > today) {
    throw fieldRefused(path, ErrorCode.INVALID_VALUE, `${path} must not be in the future`);
  }
}

/** A date of birth: not in the future and at most 30 years ago (contract §3.5); else 422. */
export function assertDateOfBirth(dateOfBirth: Date, today: Date, path = 'dateOfBirth'): void {
  const earliest = new Date(today);
  earliest.setUTCFullYear(today.getUTCFullYear() - 30);
  if (dateOfBirth > today || dateOfBirth < earliest) {
    throw fieldRefused(
      path,
      ErrorCode.INVALID_VALUE,
      `${path} must be no later than today and at most 30 years ago`,
    );
  }
}
