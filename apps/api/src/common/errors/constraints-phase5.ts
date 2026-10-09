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
