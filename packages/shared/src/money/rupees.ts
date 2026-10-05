/**
 * Whole rupees (rule 15, phase-3-financial.md rule 0.18): every amount is an integer, never paisa.
 * MAX_RUPEES bounds every amount a request may carry (R229); a row's total stays far inside a
 * Postgres `integer` (2,147,483,647).
 */
export const MAX_RUPEES = 10_000_000;

const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `Rs 12,500`; a negative amount (a credit) is `-Rs 500`. Refuses a non-integer: no paisa. */
export function formatRupees(amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new Error('an amount is a whole number of rupees');
  return amount < 0 ? `-Rs ${grouping.format(-amount)}` : `Rs ${grouping.format(amount)}`;
}
