// The receivable side's pure functions (phase-3-financial.md §3.3). Each is the one definition of
// its rule: the services call it under their locks and the clients may preview with it, but the
// service always recomputes and never trusts a preview.
import type { ChargeKind, ConcessionKind, FeeFrequency } from '../finance';
import { addDaysTo, dayOfPeriod } from './dates';

/** The three amounts that decide what a charge still owes. */
export interface ChargeBalance {
  readonly amount: number;
  readonly allocatedAmount: number;
  readonly creditedAmount: number;
}

/** What a charge still owes: `amount − allocated − credited` (rule 0.22, the only definition). */
export const outstanding = (charge: ChargeBalance): number =>
  charge.amount - charge.allocatedAmount - charge.creditedAmount;

// ------------------------------------------------------------------------------- allocate

export interface OpenCharge {
  readonly id: bigint;
  readonly studentId: bigint;
  /** `YYYY-MM-DD`. */
  readonly dueOn: string;
  /** outstanding() of the charge, above zero. */
  readonly outstanding: number;
}

/** An earlier payment's unallocated remainder, bound to one child (rule 18: family credit is per child). */
export interface ExistingAdvance {
  readonly paymentId: bigint;
  readonly studentId: bigint;
  readonly unallocated: number;
}

export interface Allocation {
  readonly chargeId: bigint;
  readonly studentId: bigint;
  /** The advance's payment, or null for the new money. */
  readonly paymentId: bigint | null;
  readonly amount: number;
}

export interface AllocationResult {
  readonly allocations: Allocation[];
  /** New money left over: the advance of the payment. */
  readonly remainder: number;
}

const oldestFirst = (a: OpenCharge, b: OpenCharge): number =>
  a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Oldest-first allocation (rule 18) over exactly `students`: first each child's existing advances
 * (oldest payment first) pay that child's own charges, then `amount` of new money pays what is
 * left across the named children, oldest `due_on` first, ties by charge id. An advance never pays
 * a sibling's charge.
 */
export function allocate(
  amount: number,
  students: readonly bigint[],
  openCharges: readonly OpenCharge[],
  existingAdvances: readonly ExistingAdvance[],
): AllocationResult {
  const named = new Set(students);
  const charges = openCharges
    .filter((c) => named.has(c.studentId) && c.outstanding > 0)
    .sort(oldestFirst);
  const owing = new Map(charges.map((c) => [c.id, c.outstanding]));
  const advances = existingAdvances
    .filter((a) => named.has(a.studentId) && a.unallocated > 0)
    .sort((a, b) => (a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0))
    .map((a) => ({ ...a, left: a.unallocated }));
  const allocations: Allocation[] = [];

  for (const charge of charges) {
    for (const advance of advances) {
      const due = owing.get(charge.id) ?? 0;
      if (due === 0) break;
      if (advance.studentId !== charge.studentId || advance.left === 0) continue;
      const take = Math.min(due, advance.left);
      advance.left -= take;
      owing.set(charge.id, due - take);
      allocations.push({ chargeId: charge.id, studentId: charge.studentId, paymentId: advance.paymentId, amount: take });
    }
  }
  let money = amount;
  for (const charge of charges) {
    const due = owing.get(charge.id) ?? 0;
    if (money === 0) break;
    if (due === 0) continue;
    const take = Math.min(due, money);
    money -= take;
    owing.set(charge.id, due - take);
    allocations.push({ chargeId: charge.id, studentId: charge.studentId, paymentId: null, amount: take });
  }
  return { allocations, remainder: money };
}

// ------------------------------------------------------------------------------ concession

export interface ConcessionTerms {
  readonly kind: ConcessionKind;
  /** 1-100 for a percentage; whole rupees (> 0) for a fixed amount. */
  readonly value: number;
  /** The heads the concession names. */
  readonly feeHeadIds: readonly bigint[];
}

/**
 * The concession on one charge of `head` (rule 19): a percentage rounded **down** to a whole rupee,
 * or a fixed amount capped at the gross, per charge of each named head; 0 for a head the
 * concession does not name or that is not concession-eligible (a fine never is).
 */
export function concessionAmount(
  gross: number,
  concession: ConcessionTerms | null,
  head: { readonly id: bigint; readonly concessionEligible: boolean },
): number {
  if (concession === null || !head.concessionEligible || !concession.feeHeadIds.includes(head.id)) return 0;
  if (concession.kind === 'percentage') return Math.floor((gross * concession.value) / 100);
  return Math.min(concession.value, gross);
}

// -------------------------------------------------------------------------------- due date

/**
 * A charge's due date (rule 25's charge-due date): the period's `feeDueDay`, unless the charge is
 * created after that nominal date — then it is born late and falls due `grace` days after it was
 * created. `createdOn` is the school-local creation day.
 */
export function dueOn(period: string, feeDueDay: number, createdOn: string, grace: number): string {
  const nominal = dayOfPeriod(period, feeDueDay);
  return createdOn > nominal ? addDaysTo(createdOn, grace) : nominal;
}

// -------------------------------------------------------------------------------- late fee

export interface LateFeeCandidate {
  readonly id: bigint;
  readonly kind: ChargeKind;
  readonly headFrequency: FeeFrequency;
  /** `YYYY-MM`; null for a charge with no period. */
  readonly period: string | null;
  readonly dueOn: string;
  readonly outstanding: number;
  /** The charge's academic year is closed. */
  readonly yearClosed: boolean;
}

export interface LateFeeSettings {
  readonly lateFeeEnabled: boolean;
  readonly lateFeeGraceDays: number;
  /** School-local day late fees were last switched on; null while never enabled. */
  readonly lateFeeEnabledOn: string | null;
}

/**
 * The charge a late fee attaches to for one student (A3, R185): the oldest overdue monthly charge
 * (`today` past `due_on + grace`) still owing, falling due on or after late fees were enabled, in
 * an open year, whose period has no live late fee yet. Never a late fee, an adjustment or a
 * campaign charge. Null when there is none or late fees are off.
 */
export function lateFeeTarget(
  openCharges: readonly LateFeeCandidate[],
  periodsWithLateFee: readonly string[],
  settings: LateFeeSettings,
  today: string,
): LateFeeCandidate | null {
  if (!settings.lateFeeEnabled || settings.lateFeeEnabledOn === null) return null;
  const enabledOn = settings.lateFeeEnabledOn;
  const eligible = openCharges.filter(
    (c) =>
      (c.kind === 'generated' || c.kind === 'manual') &&
      c.headFrequency === 'monthly' &&
      c.period !== null &&
      !periodsWithLateFee.includes(c.period) &&
      c.outstanding > 0 &&
      !c.yearClosed &&
      c.dueOn >= enabledOn &&
      today > addDaysTo(c.dueOn, settings.lateFeeGraceDays),
  );
  return (
    eligible.sort((a, b) =>
      a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )[0] ?? null
  );
}
