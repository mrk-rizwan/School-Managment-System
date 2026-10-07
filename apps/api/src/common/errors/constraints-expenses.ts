// Constraint → refusal mappings for slice 23, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-I builds never edit the same file.
//
// Every constraint of the expenses table (migration 20261006100200_slice23_expenses) that a
// request or a race can reach. ExpensesService refuses each first, with the expense's id; these
// are the fallback when a concurrent write gets between the check and the statement. The CHECKs
// only a bug can break (the receipt's key, mime and size together; the decided and voided stamps
// travelling together; self_approved without a self-decision) are deliberately left unmapped: a
// 500 says "bug", where a 4xx would hide one (the prisma-errors.ts rule).
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';
import { fieldInvalid, noIdentity } from './constraints.shared';

const notOpen = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.EXPENSE_NOT_OPEN,
    'This expense has been decided or voided and can no longer change this way.',
  );

const receiptExists = (): ApiException =>
  new ApiException(409, ErrorCode.EXPENSE_RECEIPT_EXISTS, 'This expense already has a receipt.');

/** The open-expense content frozen once decided or voided (expenses_content_frozen). */
const FROZEN_CONTENT = ['category', 'amount', 'spent_on', 'description', 'payee', 'method', 'reference'];

export const SLICE_23_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  expenses_amount_check: fieldInvalid('amount', 'amount must be at least 1'),
  expenses_method_check: fieldInvalid('method', 'carried_forward is not an expense method'),
  expenses_description_check: fieldInvalid('description', 'description must not be blank'),
  expenses_payee_check: fieldInvalid('payee', 'payee must not be blank'),
  expenses_reference_check: fieldInvalid('reference', 'reference must not be blank'),
  // R208.
  expenses_description_no_id_check: noIdentity('description'),
  expenses_payee_no_id_check: noIdentity('payee'),
  expenses_reference_no_id_check: noIdentity('reference'),
  expenses_decision_reason_no_id_check: noIdentity('reason'),
  expenses_void_reason_no_id_check: noIdentity('reason'),
  // Two numbers taken at once cannot happen under the counter's row lock; retryable if it does.
  expenses_school_id_expense_no_key: concurrentUpdate,
  // A decision or void racing another: the row moved first.
  expenses_status_transition: concurrentUpdate,
  expenses_decided_at_frozen: concurrentUpdate,
  expenses_voided_at_frozen: concurrentUpdate,
  ...Object.fromEntries(FROZEN_CONTENT.map((column) => [`expenses_${column}_frozen`, notOpen])),
  // The receipt is set once (expenses_receipt_frozen); one object is one expense's.
  expenses_receipt_object_key_frozen: receiptExists,
  expenses_receipt_object_key_key: receiptExists,
  // R244: nobody decides, or voids after approval, their own expense.
  expenses_not_self: () =>
    new ApiException(
      409,
      ErrorCode.SELF_ACTION_FORBIDDEN,
      'You cannot decide or void your own expense. Ask a colleague.',
    ),
};
