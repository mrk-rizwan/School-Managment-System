import {
  COUNTER_PAYMENT_METHODS,
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  RECORDABLE_EXPENSE_CATEGORIES,
  type RecordableExpenseCategory,
} from '@asms/shared';
import type { CounterPaymentMethod } from '../api/contracts';

// The words the expense screens show (slice 23). The categories are the ones a person records:
// salary_advance_cash and cash_shortfall are written by the system (A17).

/** The recordable categories with their shared labels, in the shared order. */
export const CATEGORY_OPTIONS: readonly { value: RecordableExpenseCategory; label: string }[] =
  RECORDABLE_EXPENSE_CATEGORIES.map((value) => ({ value, label: EXPENSE_CATEGORY_LABELS[value] }));

/** The counter methods with their shared labels, in the shared order. */
export const METHOD_OPTIONS: readonly { value: CounterPaymentMethod; label: string }[] = COUNTER_PAYMENT_METHODS.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}));

/** The server's status, as the phone shows it after the expense reached the server. */
export function serverStatusLabel(status: string | null): string | null {
  switch (status) {
    case 'recorded':
      return 'Recorded';
    case 'pending_approval':
      return 'Waiting for approval';
    case 'approved':
      return 'Approved';
    default:
      return null;
  }
}
