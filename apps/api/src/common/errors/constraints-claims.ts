// Constraint → refusal mappings for slice 21, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-K builds never edit the same file.
//
// Every constraint of payment_claims (migration 20261006170000_slice21_payment_claims) that a
// request or a race can reach. The service refuses each first; these are the fallback when a
// concurrent write gets between its check and its statement. The ones only a bug can break (a
// claim born decided, the stated columns changed, the decision columns out of step with the
// status, a reopen without its stamp, a verification naming a payment it did not record, a
// payment of the wrong method for a claim) stay unmapped: a 500 says "bug", where a 4xx would
// hide one.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate, fieldRefused, notFound } from './api-exception';
import { fieldInvalid, noIdentity, refusal } from './constraints.shared';

const claimNotPending = refusal(ErrorCode.CLAIM_NOT_PENDING, 'This claim has already been decided.');

export const SLICE_21_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // ---- what the guardian states (R196, R231)
  payment_claims_claimed_amount_check: fieldInvalid('claimedAmount', 'claimedAmount must be above 0'),
  payment_claims_method_check: fieldInvalid('method', 'A claim is for a bank or wallet deposit'),
  payment_claims_reference_check: fieldInvalid('reference', 'reference must not be empty'),
  payment_claims_reference_no_id_check: noIdentity('reference'),
  payment_claims_note_check: fieldInvalid('note', 'note must not be empty'),
  payment_claims_note_no_id_check: noIdentity('note'),
  payment_claims_dates_check: fieldInvalid('paidOn', 'paidOn must be on or before the day the claim was made'),
  // The link ended between the scope check and the insert: the child is no longer the caller's.
  payment_claims_guardian_link: notFound,

  // ---- the image (R199, R243)
  payment_claims_image_check: () =>
    fieldRefused('stagedUploadId', ErrorCode.REFERENCE_NOT_FOUND, 'The upload is unknown, used or expired.'),
  payment_claims_image_object_key_key: () =>
    fieldRefused('stagedUploadId', ErrorCode.REFERENCE_NOT_FOUND, 'The upload is unknown, used or expired.'),
  payment_claims_image_frozen: refusal(ErrorCode.CLAIM_IMAGE_EXISTS, 'This claim already has its slip.'),
  payment_claims_image_not_pending: claimNotPending,
  // R200: an image-less claim is never verified.
  payment_claims_image_status_check: refusal(ErrorCode.CLAIM_IMAGE_MISSING, 'This claim has no slip yet.'),

  // ---- the decision (R196, R197, A15)
  payment_claims_status_transition: claimNotPending,
  payment_claims_decision_frozen: claimNotPending,
  payment_claims_decision_reason_check: fieldInvalid('reason', 'reason must not be empty'),
  payment_claims_decision_reason_no_id_check: noIdentity('reason'),
  payment_claims_verified_amount_check: fieldInvalid('verifiedAmount', 'verifiedAmount must be above 0 and at most the amount claimed'),
  payment_claims_verified_reason_check: fieldInvalid('reason', 'A lower amount or a corrected date needs a reason'),
  payment_claims_payment_key: concurrentUpdate,
  payment_claims_not_self: () =>
    new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'This claim is from your own family. Ask a colleague.', {
      reason: 'own_child',
    }),
};
