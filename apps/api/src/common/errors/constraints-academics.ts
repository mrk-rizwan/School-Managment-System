// Constraint → refusal mappings for Phase 4 slice 29 (contracts/slice-29.md §5), merged into
// BY_CONSTRAINT (prisma-errors.ts). The services check first; these answer the race losers and
// any write that reaches the database's line.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';
import { fieldInvalid } from './constraints.shared';

const yearImmutable = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.CLASS_YEAR_IMMUTABLE,
    'The academic year of a class cannot change once it has subjects or terms set for it.',
    { field: 'academicYearId' },
  );

export const SLICE_29_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  academic_terms_no_overlap: () =>
    new ApiException(409, ErrorCode.TERM_OVERLAPS, 'This overlaps another term of the year.', { termId: null }),
  academic_terms_inside_year: () =>
    new ApiException(409, ErrorCode.TERM_OUTSIDE_YEAR, 'A term must lie inside its academic year.', { termId: null }),
  academic_terms_name_key: () =>
    new ApiException(409, ErrorCode.TERM_NAME_TAKEN, 'The year already has a term of that name.', { field: 'name' }),
  // The service renumbers under the year's lock; a clash here is a concurrent write.
  academic_terms_sort_order_excl: concurrentUpdate,
  academic_terms_sort_order_check: fieldInvalid('startsOn', 'A year has at most six terms'),
  term_skips_live_key: concurrentUpdate,
  class_subjects_live_key: concurrentUpdate,
  // ON UPDATE RESTRICT: a class's year cannot change once a subject list or a skip names it.
  class_subjects_class_id_fkey: yearImmutable,
  term_skips_class_id_fkey: yearImmutable,
  classes_next_class_check: fieldInvalid('nextClassId', 'A final class has no next class, and a class is not its own next class'),
  result_settings_weights_check: fieldInvalid('testWeight', 'testWeight and examWeight are whole percents summing to 100'),
  result_settings_band_values_check: fieldInvalid('bands', 'Each grade is 1-4 letters, digits, + or -, and each minimum a whole percent from 0 to 100'),
};
