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
  // Wave N (migration 20261007160000_wave_n_assessments_certificates): wave M's deferred locks.
  academic_terms_in_use: () =>
    new ApiException(409, ErrorCode.TERM_IN_USE, 'The term has assessments; its dates and weight can no longer change.', { termId: null }),
  class_subjects_in_use: () =>
    new ApiException(409, ErrorCode.CLASS_SUBJECT_IN_USE, 'This subject has marks and cannot be removed from the class.', { classSubjectId: null }),
  result_settings_band_values_check: fieldInvalid('bands', 'Each grade is 1-4 letters, digits, + or -, and each minimum a whole percent from 0 to 100'),
  // Slice 30 (contracts/slice-30.md §6): the services check first under the assessment's row
  // lock; these answer a write that reaches the database's line.
  assessments_held_on_in_term: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_OUTSIDE_TERM, 'The date must lie inside the assessment’s term.', { assessmentId: null }),
  assessments_has_marks: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_HAS_MARKS, 'Marks have been entered: the name, date and maximum marks can no longer change.', { assessmentId: null }),
  assessments_voided_frozen: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_VOIDED, 'This assessment has been voided.', { assessmentId: null }),
  // A concurrent set-up or a void-and-recreate race; set-up itself skips an existing exam.
  assessments_exam_key: concurrentUpdate,
  marks_assessment_locked: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_LOCKED, 'This assessment is locked: its result sheet has been submitted.', { assessmentId: null }),
  marks_assessment_voided: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_VOIDED, 'This assessment has been voided.', { assessmentId: null }),
  // One live (or pending) row per enrolment and one row per entry key: a concurrent write lost.
  marks_live_key: concurrentUpdate,
  marks_pending_key: concurrentUpdate,
  marks_client_entry_key: concurrentUpdate,
  marks_supersedes_key: concurrentUpdate,
  marks_obtained_check: () =>
    new ApiException(409, ErrorCode.MARK_EXCEEDS_MAX, 'A mark cannot exceed the maximum.', { enrolmentId: null, max: null }),
  // ON UPDATE RESTRICT: an assessment's max marks freeze once a mark carries them.
  marks_assessment_max_fkey: () =>
    new ApiException(409, ErrorCode.ASSESSMENT_HAS_MARKS, 'Marks have been entered: the maximum marks can no longer change.', { assessmentId: null }),
  // Slice 34 (contracts/slice-34.md §5): two reissues of one number through different rows at
  // once; the loser retries. Numbers themselves are taken under the counter's row lock.
  certificates_school_id_type_number_issue_no_key: concurrentUpdate,
};
