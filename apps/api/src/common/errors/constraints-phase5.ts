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

// ---- wave S: events (slice 38) and staff contracts (slice 39), migration
// 20261010090000_wave_s_events_contracts. The services check first; these answer a race loser
// and any write that reaches the database's line. The CHECKs only a bug can break (the stamps
// travelling together, the campaign and announcement pairing with the status, the document's
// key, mime and size together, an event born draft, a duty born live) are deliberately unmapped:
// a 500 says "bug" (the prisma-errors.ts rule).

const eventNotDraft = (): ApiException =>
  new ApiException(409, ErrorCode.EVENT_NOT_DRAFT, 'The event is no longer a draft.');

const eventNotPublished = (): ApiException =>
  new ApiException(409, ErrorCode.EVENT_NOT_PUBLISHED, 'The event is not published.');

/** The draft content frozen once the event leaves draft (events_content_frozen). */
const EVENT_CONTENT = ['type', 'title', 'starts_at', 'ends_at', 'venue', 'details', 'charge_amount', 'charge_due_on'];

export const WAVE_S_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R316.
  events_status_transition: () =>
    new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'The event cannot move to that status.'),
  ...Object.fromEntries(EVENT_CONTENT.map((column) => [`events_${column}_frozen`, eventNotDraft])),
  events_campaign_id_frozen: concurrentUpdate,
  events_announcement_id_frozen: concurrentUpdate,
  events_cancel_announcement_id_frozen: concurrentUpdate,
  events_cancelled_at_frozen: concurrentUpdate,
  events_completed_at_frozen: concurrentUpdate,
  // A4, R310.
  events_in_year: fieldInvalid('startsAt', 'startsAt must fall inside the academic year'),
  events_has_sections: () =>
    new ApiException(409, ErrorCode.EVENT_NO_SECTIONS, 'An event needs at least one section before it is published.'),
  events_dates_check: fieldInvalid('endsAt', 'endsAt must not be before startsAt'),
  events_charge_check: fieldInvalid('charge.amount', 'charge.amount must be at least 1'),
  events_title_check: fieldInvalid('title', 'title must not be blank'),
  events_venue_check: fieldInvalid('venue', 'venue must not be blank'),
  events_details_check: fieldInvalid('details', 'details must not be blank'),
  events_title_no_id_check: noIdentity('title'),
  events_venue_no_id_check: noIdentity('venue'),
  events_details_no_id_check: noIdentity('details'),
  events_cancel_reason_no_id_check: noIdentity('reason'),
  // R310: a draft's sections; a section of another year fails the class FK.
  event_sections_draft_only: eventNotDraft,
  event_sections_event_section_key: concurrentUpdate,
  event_sections_class_id_fkey: fieldInvalid('sectionIds', "sectionIds must be sections of the event's academic year"),
  // R311.
  event_duties_live_key: () =>
    new ApiException(409, ErrorCode.EVENT_DUTY_EXISTS, 'That staff member already holds that duty at this event.'),
  event_duties_event_open: () =>
    new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'The duties of a completed or cancelled event do not change.'),
  event_duties_ended_at_frozen: concurrentUpdate,
  event_duties_note_check: fieldInvalid('note', 'note must not be blank'),
  event_duties_note_no_id_check: noIdentity('note'),
  event_duties_end_reason_no_id_check: noIdentity('reason'),
  // R312: recorded while published, frozen at completion; a concurrent first record of a student.
  event_participation_event_published: eventNotPublished,
  event_participation_event_student_key: concurrentUpdate,
  // R314: an expense is tagged once, while not voided, to a published or completed event.
  expenses_event_id_frozen: () =>
    new ApiException(409, ErrorCode.EXPENSE_EVENT_TAGGED, 'This expense is already tagged to an event.'),
  expenses_event_tag_voided: () =>
    new ApiException(409, ErrorCode.STALE_STATUS, 'A voided expense cannot be tagged to an event.'),
  expenses_event_tag_event_status: eventNotPublished,
  // R318.
  staff_contracts_live_key: () =>
    new ApiException(409, ErrorCode.STAFF_CONTRACT_LIVE_EXISTS, 'This staff member already has a live contract.'),
  staff_contracts_type_end_check: () =>
    fieldRefused('endsOn', ErrorCode.STAFF_CONTRACT_END_REQUIRED, 'A permanent contract has no end date; any other contract has one.'),
  staff_contracts_dates_check: fieldInvalid('endsOn', 'endsOn must not be before startsOn'),
  staff_contracts_ended_check: fieldInvalid('endedOn', 'endedOn must not be before the contract starts'),
  staff_contracts_ended_at_frozen: () =>
    new ApiException(409, ErrorCode.STAFF_CONTRACT_ENDED, 'This contract has already ended.'),
  staff_contracts_warned_30_at_frozen: concurrentUpdate,
  staff_contracts_warned_7_at_frozen: concurrentUpdate,
  staff_contracts_document_object_key_key: concurrentUpdate,
  staff_contracts_note_check: fieldInvalid('note', 'note must not be blank'),
  staff_contracts_note_no_id_check: noIdentity('note'),
  staff_contracts_end_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  staff_contracts_end_reason_no_id_check: noIdentity('reason'),
};
