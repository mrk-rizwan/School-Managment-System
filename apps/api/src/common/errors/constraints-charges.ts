// Constraint → refusal mappings for slice 19, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-I builds never edit the same file.
//
// Every constraint of slice 19's tables (concessions, concession_heads, charge_runs,
// charge_campaigns, charge_campaign_audiences, charges) that a request or a race can reach is
// mapped here. The services refuse each of these first, with the contract's details; these are
// the fallback when a concurrent write gets there between the check and the statement. The
// CHECKs that only a bug can break (amount = gross − concession, a generated monthly charge has a
// period, the decided/ended/voided/waived/times stamps travel together, the allowlisted
// skipped_classes, the target FK by kind) are deliberately left unmapped: a 500 says "bug", where
// a 4xx would hide one (the prisma-errors.ts rule).
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';

const ownChild = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot do this for your own child. Ask a colleague.', {
    reason: 'own_child',
  });

const illegal = (message: string) => (): ApiException =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, message);

const chargeNotOpen = (): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_NOT_OPEN, 'This charge is no longer open.');

const fieldInvalid = (path: string, message: string) => (): ApiException =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code: ErrorCode.INVALID_VALUE, message }],
  });

const noIdentity = (path: string) => fieldInvalid(path, `${path} must not contain an identity number`);

export const SLICE_19_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // ---- concessions (R182, R183, R232, R253)
  concessions_value_check: fieldInvalid('value', 'value must be 1-100 for a percentage, above 0 for a fixed amount'),
  concessions_effective_from_check: fieldInvalid('effectiveFrom', 'effectiveFrom must be a month in the form YYYY-MM'),
  concessions_reason_check: fieldInvalid('reason', 'reason must not be empty'),
  concessions_reason_no_id_check: noIdentity('reason'),
  concessions_decision_reason_no_id_check: noIdentity('reason'),
  concessions_end_reason_no_id_check: noIdentity('reason'),
  concessions_status_transition: () =>
    new ApiException(409, ErrorCode.CONCESSION_NOT_PENDING, 'This concession has already been decided.'),
  concessions_decided_frozen: () =>
    new ApiException(409, ErrorCode.CONCESSION_NOT_PENDING, 'This concession has already been decided.'),
  concessions_ended_frozen: illegal('This concession has already ended.'),
  concessions_own_child: ownChild,
  concessions_self_approved_unwarranted: ownChild,
  concession_heads_school_id_concession_id_fee_head_id_key: fieldInvalid('feeHeadIds', 'each fee head may be named once'),

  // ---- charge runs (R179, R252)
  charge_runs_period_check: fieldInvalid('period', 'period must be a month in the form YYYY-MM'),
  charge_runs_period_key: () =>
    new ApiException(409, ErrorCode.CHARGE_RUN_IN_PROGRESS, 'A charge run for this year is already in progress.'),
  charge_runs_status_transition: concurrentUpdate,
  charge_runs_finished_frozen: concurrentUpdate,

  // ---- campaigns and their audiences (R184)
  charge_campaigns_name_check: fieldInvalid('name', 'name must not be empty'),
  charge_campaigns_name_no_id_check: noIdentity('name'),
  charge_campaigns_description_check: fieldInvalid('description', 'description must not be empty'),
  charge_campaigns_description_no_id_check: noIdentity('description'),
  charge_campaigns_cancel_reason_no_id_check: noIdentity('reason'),
  charge_campaigns_amount_check: fieldInvalid('amount', 'amount must be above 0'),
  charge_campaigns_status_transition: () =>
    new ApiException(409, ErrorCode.CAMPAIGN_NOT_DRAFT, 'This campaign is no longer a draft.'),
  charge_campaigns_content_frozen: () =>
    new ApiException(409, ErrorCode.CAMPAIGN_NOT_DRAFT, 'This campaign is no longer a draft.'),
  charge_campaigns_cancelled_frozen: illegal('This campaign is already cancelled.'),
  charge_campaign_audiences_kind_check: fieldInvalid('audiences', 'a campaign audience is everyone, students, a class, a section or a student'),
  charge_campaign_audiences_target_key: fieldInvalid('audiences', 'the same target appears twice'),
  charge_campaign_audiences_draft_only: () =>
    new ApiException(409, ErrorCode.CAMPAIGN_NOT_DRAFT, 'This campaign is no longer a draft.'),

  // ---- charges (R179-R186, R239-R241)
  charges_description_check: fieldInvalid('description', 'description must not be empty'),
  charges_description_no_id_check: noIdentity('description'),
  charges_void_reason_no_id_check: noIdentity('reason'),
  charges_waive_reason_no_id_check: noIdentity('reason'),
  // §3.2: an increment that would over-allocate or over-credit under a race; the service retries
  // once, then the caller reloads.
  charges_allocated_amount_check: concurrentUpdate,
  // The idempotency keys: a concurrent run or admission wrote the row first.
  charges_generated_key: concurrentUpdate,
  charges_once_key: concurrentUpdate,
  charges_yearly_key: concurrentUpdate,
  charges_late_fee_key: concurrentUpdate,
  charges_campaign_key: concurrentUpdate,
  charges_status_transition: chargeNotOpen,
  charges_voided_frozen: chargeNotOpen,
  charges_waived_frozen: chargeNotOpen,
  charges_adjustment_target_open: chargeNotOpen,
  charges_closed_unallocated_check: () =>
    new ApiException(409, ErrorCode.CHARGE_HAS_ALLOCATIONS, 'Payments are allocated to this charge.'),
  charges_own_child: ownChild,
};
