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

// ---- wave T: transport (slice 41) and biometric staff attendance (slice 44), migrations
// 20261014120000_wave_t_enums and 20261014120100_wave_t_transport_biometric. The services check
// first; these answer a race loser and any write that reaches the database's line. The CHECKs and
// guards only a bug can break (a row born in a later state, the end and decision groups travelling
// together, a punch's mapping or outcome against the staff row, a device mark's punch) are
// deliberately unmapped: a 500 says "bug" (the prisma-errors.ts rule).

const routeArchived = (): ApiException =>
  new ApiException(409, ErrorCode.TRANSPORT_ROUTE_ARCHIVED, 'The route is archived.');

export const WAVE_T_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // §3.2 vehicles (R329).
  vehicles_live_registration_key: () =>
    new ApiException(409, ErrorCode.VEHICLE_REGISTRATION_TAKEN, 'An active vehicle already has that registration.', {
      field: 'registration',
    }),
  vehicles_in_use: () =>
    new ApiException(409, ErrorCode.VEHICLE_IN_USE, 'An active route still uses this vehicle.'),
  vehicles_status_transition: () =>
    new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'The vehicle is already retired.'),
  vehicles_registration_frozen: () => new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'The vehicle is retired.'),
  vehicles_capacity_frozen: () => new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'The vehicle is retired.'),
  vehicles_driver_staff_id_frozen: () => new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'The vehicle is retired.'),
  vehicles_retired_at_frozen: concurrentUpdate,
  vehicles_registration_check: fieldInvalid('registration', 'registration must not be blank'),
  vehicles_registration_no_id_check: noIdentity('registration'),
  vehicles_capacity_check: fieldInvalid('capacity', 'capacity is 1-120'),
  vehicles_retire_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  vehicles_retire_reason_no_id_check: noIdentity('reason'),
  // §3.2 routes (R329).
  transport_routes_live_name_key: () =>
    new ApiException(409, ErrorCode.TRANSPORT_ROUTE_NAME_TAKEN, 'An active route already has that name.', { field: 'name' }),
  transport_routes_vehicle_active: () =>
    new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'A retired vehicle cannot serve a route.'),
  transport_routes_has_assignments: () =>
    new ApiException(409, ErrorCode.TRANSPORT_ROUTE_HAS_ASSIGNMENTS, 'Students are still assigned to this route.'),
  transport_routes_status_transition: routeArchived,
  transport_routes_name_frozen: routeArchived,
  transport_routes_vehicle_id_frozen: routeArchived,
  transport_routes_archived_at_frozen: concurrentUpdate,
  transport_routes_name_check: fieldInvalid('name', 'name must not be blank'),
  transport_routes_name_no_id_check: noIdentity('name'),
  transport_routes_archive_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  transport_routes_archive_reason_no_id_check: noIdentity('reason'),
  // R327: one live amount per route and period; an amount is voided once, before its period.
  transport_route_amounts_route_period_key: () =>
    new ApiException(409, ErrorCode.TRANSPORT_AMOUNT_PERIOD_TAKEN, 'The route already has an amount from that period.'),
  transport_route_amounts_route_active: routeArchived,
  transport_route_amounts_void_period_started: () =>
    new ApiException(409, ErrorCode.TRANSPORT_AMOUNT_PERIOD_PAST, 'An amount whose period has started cannot be voided.'),
  transport_route_amounts_voided_at_frozen: () =>
    new ApiException(409, ErrorCode.STALE_STATUS, 'This amount is already voided.'),
  transport_route_amounts_void_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  transport_route_amounts_void_reason_no_id_check: noIdentity('reason'),
  transport_route_amounts_period_check: fieldInvalid('effectivePeriod', 'effectivePeriod is YYYY-MM'),
  transport_route_amounts_amount_check: fieldInvalid('amount', 'amount must not be negative'),
  // Stops (replaced as a whole by PATCH /transport-routes/:id).
  transport_stops_live_order_excl: fieldInvalid('stops', 'two stops share a sort order'),
  transport_stops_in_use: () =>
    new ApiException(409, ErrorCode.TRANSPORT_STOP_IN_USE, 'A student is still assigned to that stop.'),
  transport_stops_route_active: routeArchived,
  transport_stops_ended_at_frozen: concurrentUpdate,
  transport_stops_sort_order_check: fieldInvalid('stops', 'sortOrder is 1-100'),
  transport_stops_name_check: fieldInvalid('stops', 'a stop name must not be blank'),
  transport_stops_name_no_id_check: noIdentity('stops'),
  transport_stops_end_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  transport_stops_end_reason_no_id_check: noIdentity('reason'),
  // A8, R326.
  transport_assignments_live_key: () =>
    new ApiException(409, ErrorCode.TRANSPORT_ASSIGNMENT_LIVE, 'The student already has a live route this year.'),
  transport_assignments_route_active: routeArchived,
  transport_assignments_stop_live: fieldInvalid('stopId', 'stopId must be a live stop of the route'),
  transport_assignments_stop_id_fkey: fieldInvalid('stopId', 'stopId must be a stop of the route'),
  transport_assignments_in_year: fieldInvalid('startsOn', 'startsOn must be inside the academic year'),
  transport_assignments_ended_check: fieldInvalid('endedOn', 'endedOn must not be before the assignment starts'),
  transport_assignments_ended_at_frozen: concurrentUpdate,
  transport_assignments_end_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  transport_assignments_end_reason_no_id_check: noIdentity('reason'),
  // R345: a replay is answered `duplicate` by the service (ON CONFLICT); a race loser lands here.
  device_punches_replay_key: concurrentUpdate,
  device_punches_device_user_id_check: fieldInvalid('deviceUserId', 'deviceUserId is 1-40 printable ASCII characters without spaces'),
  device_punches_device_user_id_no_id_check: noIdentity('deviceUserId'),
  // A punch makes at most one mark (a race loser; the day itself is staff_attendance_natural_key).
  staff_attendance_device_punch_id_key: concurrentUpdate,
  // R346.
  staff_attendance_disputes_pending_key: () =>
    new ApiException(409, ErrorCode.ATTENDANCE_DISPUTE_PENDING_EXISTS, 'This mark already has a pending dispute.'),
  staff_attendance_disputes_status_transition: () =>
    new ApiException(409, ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING, 'The dispute is no longer pending.'),
  staff_attendance_disputes_decided_at_frozen: concurrentUpdate,
  staff_attendance_disputes_withdrawn_at_frozen: concurrentUpdate,
  staff_attendance_disputes_not_self: () =>
    new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'Nobody decides a dispute of their own attendance.', {
      reason: 'own_attendance',
    }),
  staff_attendance_disputes_decided_check: fieldInvalid('reason', 'reason is required to reject a dispute'),
  staff_attendance_disputes_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  staff_attendance_disputes_reason_no_id_check: noIdentity('reason'),
  staff_attendance_disputes_decision_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  staff_attendance_disputes_decision_reason_no_id_check: noIdentity('reason'),
};

// ---- wave U: class rankings (slice 42), commencement imports (slice 43) and platform support
// sessions (slice 45), migration 20261016120000_wave_u_rankings_imports_support. The services
// check first; these answer a race loser and any write that reaches the database's line. As in
// wave T, the guards only a bug can break (a ranking or row born in the wrong state, a child of an
// import of the other kind, the positions against the percentage, a session born closed, the
// end and revoke groups travelling together) are deliberately unmapped: a 500 says "bug".

const importNotPreviewed = (): ApiException =>
  new ApiException(409, ErrorCode.IMPORT_NOT_PREVIEWED, 'The import is no longer awaiting commit.');

export const WAVE_U_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R333: two recomputes of one class-term raced; the loser's version is redundant.
  class_rankings_live_key: concurrentUpdate,
  class_rankings_first_key: concurrentUpdate,
  class_rankings_supersedes_key: concurrentUpdate,
  class_rankings_superseded_at_frozen: concurrentUpdate,
  // R341: the file was committed by a racing request (the preview reports it first).
  imports_committed_hash_key: () =>
    new ApiException(409, ErrorCode.IMPORT_DUPLICATE_FILE, 'This file has already been imported.'),
  imports_status_transition: importNotPreviewed,
  imports_committed_at_frozen: importNotPreviewed,
  imports_failed_at_frozen: importNotPreviewed,
  result_sheets_import_previewed: importNotPreviewed,
  charges_import_previewed: importNotPreviewed,
  // R340: one sheet per import. A racing commit of another file for the same section-term lands
  // on result_sheets_version_key (version 1 of the section-term; wave O's mapping, CONCURRENT_UPDATE).
  result_sheets_import_key: () =>
    new ApiException(409, ErrorCode.IMPORT_SHEET_EXISTS, 'A result sheet already exists for this import.'),
  charges_import_enrolment_key: concurrentUpdate,
  imports_file_name_check: fieldInvalid('file', 'the file name must not be blank'),
  imports_file_name_no_id_check: noIdentity('file'),
  imports_rows_check: fieldInvalid('file', 'the file holds at most 5,000 rows and 1 MB of data'),
  imports_row_count_check: fieldInvalid('file', 'the file holds at most 5,000 rows'),
  imports_rows_no_id_check: noIdentity('file'),
  imports_errors_no_id_check: noIdentity('file'),
  // R349: one open session per school, three per platform user.
  platform_support_sessions_open_key: () =>
    new ApiException(409, ErrorCode.SUPPORT_SESSION_OPEN, 'The school already has an open support session.'),
  platform_support_sessions_user_limit: () =>
    new ApiException(409, ErrorCode.SUPPORT_SESSION_LIMIT, 'You already have three open support sessions.'),
  // R352: the session ended while the request was in flight (the guard reports the reason first).
  platform_support_sessions_closed_at_frozen: () =>
    new ApiException(403, ErrorCode.SUPPORT_SESSION_ENDED, 'The support session has ended.'),
  platform_support_sessions_expires_check: fieldInvalid('supportSessionHours', 'a support session lasts 1-24 hours'),
  platform_support_sessions_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  platform_support_sessions_reason_no_id_check: noIdentity('reason'),
  platform_support_sessions_ticket_ref_check: fieldInvalid('ticketRef', 'ticketRef must not be blank'),
  platform_support_sessions_ticket_ref_no_id_check: noIdentity('ticketRef'),
  platform_support_sessions_close_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  platform_support_sessions_close_reason_no_id_check: noIdentity('reason'),
  platform_support_sessions_revoke_reason_check: fieldInvalid('reason', 'reason must not be blank'),
  platform_support_sessions_revoke_reason_no_id_check: noIdentity('reason'),
};
