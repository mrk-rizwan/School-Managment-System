// Constraint -> refusal mappings for the Phase 5 groundwork (phase-5-extended.md §3.2, §5.1),
// merged into BY_CONSTRAINT (prisma-errors.ts). The services check first; these answer the race
// losers and any write that reaches the database's line. Each later Phase 5 slice adds its own.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate, fieldRefused } from './api-exception';
import { fieldInvalid, noIdentity } from './constraints.shared';

/**
 * Phase 5 R329: a transport head is charged from the student's route (slice 41) and an event head
 * by the event's campaign (slice 38); neither takes a fee structure. 422 on feeHeadId; the fee
 * structure service refuses with it first.
 */
export const headNotStructured = (): ApiException =>
  fieldRefused(
    'feeHeadId',
    ErrorCode.INVALID_VALUE,
    'A transport or event head is charged by its own module and takes no fee structure',
  );

export const PHASE_5_GROUNDWORK_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R329 (trigger asms_fee_structure_head_category).
  fee_structures_head_category: headNotStructured,
  fee_heads_one_transport_key: () =>
    new ApiException(409, ErrorCode.FEE_HEAD_CATEGORY_TAKEN, 'The school already has a transport head.'),
  // R322 (trigger asms_student_document_decision_guard; slice 40's service refuses first).
  student_documents_not_self: () =>
    new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'Nobody verifies or rejects a document they uploaded.', {
      reason: 'own_upload',
    }),
  // A decision raced another: the document is decided once (the service reads it under lock).
  student_documents_status_transition: concurrentUpdate,
  student_documents_reject_reason_no_id_check: noIdentity('reason'),
  // Rule 40 (slice 44's PATCH /staff/:id refuses first).
  staff_school_id_device_user_id_key: concurrentUpdate,
  staff_device_user_id_check: fieldInvalid('deviceUserId', 'deviceUserId is 1-40 printable ASCII characters without spaces'),
  staff_device_user_id_no_id_check: noIdentity('deviceUserId'),
  // §3.6 settings.
  school_settings_required_document_types_check: fieldInvalid('requiredDocumentTypes', 'requiredDocumentTypes lists each type at most once'),
  school_settings_contract_warning_days_check: fieldInvalid('contractWarningDays', 'contractWarningDays is 1-90'),
  platform_settings_support_session_hours_check: fieldInvalid('supportSessionHours', 'supportSessionHours is 1-24'),
};

// ---- slice 37: the period timetable (contracts/slice-37.md §4). The services check first; these
// answer a race loser and any write that reaches the database's line.

const slotClash = (kind: 'teacher' | 'room' | 'section') => (): ApiException =>
  new ApiException(409, ErrorCode.TIMETABLE_SLOT_CLASH, 'That period is already taken.', { kind });

export const SLICE_37_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R302.
  timetable_slots_teacher_excl: slotClash('teacher'),
  timetable_slots_room_excl: slotClash('room'),
  timetable_slots_version_weekday_period_key: slotClash('section'),
  timetable_slots_off_day: () =>
    new ApiException(409, ErrorCode.TIMETABLE_OFF_DAY, 'A slot cannot fall on a weekly-off day.'),
  timetable_slots_period_in_day: fieldInvalid('period', "period must be within the school's periods per day"),
  timetable_slots_version_voided: concurrentUpdate,
  timetable_slots_room_check: fieldInvalid('room', 'room is 1-40 characters, trimmed'),
  timetable_slots_room_no_id_check: noIdentity('room'),
  // R301: a racing create or void of the same section.
  timetable_versions_live_excl: concurrentUpdate,
  timetable_versions_voided_frozen: concurrentUpdate,
  timetable_versions_in_year: fieldInvalid('effectiveFrom', 'effectiveFrom must be inside the academic year'),
  timetable_versions_void_reason_no_id_check: noIdentity('reason'),
  // R306.
  timetable_substitutions_live_key: () =>
    new ApiException(409, ErrorCode.TIMETABLE_SUBSTITUTION_EXISTS, 'That period already has a substitution.'),
  timetable_substitutions_staff_live_key: () =>
    new ApiException(409, ErrorCode.TIMETABLE_SUBSTITUTION_EXISTS, 'That teacher already substitutes in that period.'),
  timetable_substitutions_reason_no_id_check: noIdentity('reason'),
  timetable_substitutions_void_reason_no_id_check: noIdentity('reason'),
  // §3.3: lowering periods_per_day below a live or future slot.
  school_settings_periods_per_day_timetabled: fieldInvalid(
    'periodsPerDay',
    'periodsPerDay cannot be lowered below a period the timetable uses',
  ),
};
