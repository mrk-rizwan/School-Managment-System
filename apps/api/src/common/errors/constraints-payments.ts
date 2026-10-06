// Constraint → refusal mappings for slice 20, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-J builds never edit the same file.
//
// Every constraint of the payment tables (migration 20261006140000_slice20_payments: payments,
// payment_allocations, receipts, receipt_lines, payment_reversals, cash_handovers) that a request
// or a race can reach. The services refuse each first, with ids and amounts; these are the
// fallback when a concurrent write gets between the check and the statement. The ones only a bug
// can break (a payment born voided or in a handover, the carried-forward pairing, the void's
// amount, the stamps travelling together, the receipt line's shape, a written-off shortfall
// without its expense, frozen columns) stay unmapped: a 500 says "bug", where a 4xx would hide one.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';

const fieldInvalid = (path: string, message: string) => (): ApiException =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code: ErrorCode.INVALID_VALUE, message }],
  });

const noIdentity = (path: string) => fieldInvalid(path, `${path} must not contain an identity number`);

const ownChild = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot do this for your own child. Ask a colleague.', {
    reason: 'own_child',
  });

const refusal = (code: ErrorCode, message: string) => (): ApiException => new ApiException(409, code, message);

const paymentVoided = refusal(ErrorCode.PAYMENT_VOIDED, 'This payment has been voided.');
const handoverNotOpen = refusal(ErrorCode.HANDOVER_NOT_OPEN, 'This handover has already been confirmed.');
const noShortfall = refusal(ErrorCode.HANDOVER_NO_SHORTFALL, 'This handover has no shortfall to resolve, or it is already resolved.');

export const SLICE_20_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // ---- payments (R187, R189, R193, R232)
  payments_amount_check: fieldInvalid('amount', 'amount must be above 0'),
  // §3.2: an increment that would over-allocate under a race; the service retries once.
  payments_unallocated_amount_check: concurrentUpdate,
  payments_payer_check: fieldInvalid('payerGuardianId', 'Name the paying guardian or a walk-in payer, not both'),
  payments_payer_name_check: fieldInvalid('payerName', 'payerName must not be empty'),
  payments_payer_name_no_id_check: noIdentity('payerName'),
  payments_reference_check: fieldInvalid('reference', 'reference must not be empty'),
  payments_reference_no_id_check: noIdentity('reference'),
  payments_reference_required_check: fieldInvalid('reference', 'A bank or wallet payment needs the slip reference'),
  payments_carried_from_reversal_key: concurrentUpdate,
  payments_carried_from_check: concurrentUpdate,
  payments_status_transition: paymentVoided,
  payments_voided_at_frozen: paymentVoided,
  // A handover gathered the payment, or a void took it, between the check and the write.
  payments_handover_id_frozen: concurrentUpdate,
  payments_handover_open: concurrentUpdate,
  payments_own_child: ownChild,
  payments_advance_student_required: fieldInvalid('advanceForStudentId', 'This payment leaves an advance; name the child it is for'),

  // ---- payment_allocations (R188, R191, R192)
  payment_allocations_live_key: concurrentUpdate,
  payment_allocations_reversed_at_frozen: concurrentUpdate,
  payment_allocations_payment_voided: paymentVoided,
  payment_allocations_own_child: ownChild,
  payment_allocations_admission_reversal: () =>
    new ApiException(409, ErrorCode.CHARGE_NOT_OPEN, 'An admission fee payment is never turned into an advance.', {
      reason: 'admission_head',
    }),

  // ---- receipts (R190)
  receipts_number_key: concurrentUpdate,
  receipts_payment_key: concurrentUpdate,
  receipts_voided_at_frozen: paymentVoided,

  // ---- payment_reversals (R191, R192, R232, R251)
  payment_reversals_amount_check: fieldInvalid('amount', 'amount must be above 0'),
  payment_reversals_reason_check: fieldInvalid('reason', 'reason must not be empty'),
  payment_reversals_reason_no_id_check: noIdentity('reason'),
  payment_reversals_refund_reference_check: fieldInvalid('reference', 'reference must not be empty'),
  payment_reversals_refund_reference_no_id_check: noIdentity('reference'),
  payment_reversals_refund_method_check: fieldInvalid('method', 'A refund goes back by cash, bank transfer or wallet'),
  payment_reversals_void_key: paymentVoided,
  payment_reversals_payment_voided: paymentVoided,
  // Review fix (migration 20261006150500_slice20_review_fixes): a carried payment is refunded, never voided.
  payment_reversals_carried_forward_void: () =>
    new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'A carried-forward payment is not voided; refund or carry its advance instead.'),
  payment_reversals_reverses_key: () =>
    new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'This refund has already been reversed.'),
  payment_reversals_reverses_refund: fieldInvalid('reversalId', 'Name a refund of this payment, reversed in full'),
  payment_reversals_carried_to_key: concurrentUpdate,
  payment_reversals_carried_to_payment_id_frozen: concurrentUpdate,
  payment_reversals_carry_forward_linked: concurrentUpdate,
  payment_reversals_not_self: () =>
    new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You recorded this payment. Ask a colleague to void it.', {
      reason: 'recorder',
    }),
  payment_reversals_payment_has_refund: refusal(
    ErrorCode.PAYMENT_HAS_REFUND,
    'Part of this payment was refunded or carried forward. Reverse that first.',
  ),
  payment_reversals_payment_in_handover: refusal(
    ErrorCode.PAYMENT_IN_CUSTODY,
    'This cash is in a handover still being counted. Confirm the handover first.',
  ),
  payment_reversals_own_child: ownChild,

  // ---- cash_handovers (R193, R194)
  cash_handovers_expected_check: refusal(ErrorCode.HANDOVER_NOTHING_TO_HAND_OVER, 'There is no cash in hand to hand over.'),
  cash_handovers_expected_matches: concurrentUpdate,
  cash_handovers_open_key: refusal(ErrorCode.HANDOVER_OPEN, 'A handover of this cash is already waiting to be counted.'),
  cash_handovers_not_self_check: () =>
    new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You handed over or opened this cash. Ask a colleague to count it.'),
  cash_handovers_status_transition: handoverNotOpen,
  cash_handovers_confirmed_frozen: handoverNotOpen,
  cash_handovers_shortfall_resolution_frozen: noShortfall,
  cash_handovers_resolution_check: noShortfall,
  cash_handovers_shortfall_reversal: fieldInvalid('reversalId', 'Name the void of a payment gathered in this handover'),
  cash_handovers_note_check: fieldInvalid('note', 'note must not be empty'),
  cash_handovers_note_no_id_check: noIdentity('note'),
  cash_handovers_confirm_note_check: fieldInvalid('note', 'note must not be empty'),
  cash_handovers_confirm_note_no_id_check: noIdentity('note'),
  cash_handovers_shortfall_resolution_reason_no_id_check: noIdentity('reason'),
};
