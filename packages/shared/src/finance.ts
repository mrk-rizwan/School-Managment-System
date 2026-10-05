/**
 * Phase 3 value sets (phase-3-financial.md §4, §5.1), for the API's DTOs and the clients. Each set
 * that a table stores mirrors the Postgres enum of the same name, created with that table's slice;
 * test/guardrails/shared-enums.e2e-spec.ts compares the two once the enum exists.
 */

// ------------------------------------------------------------------------------- fee setup

/** `fee_heads.category`. At most one live tuition and one live fine head per school. */
export const FEE_HEAD_CATEGORIES = ['tuition', 'admission', 'annual', 'exam', 'fine', 'other'] as const;
export type FeeHeadCategory = (typeof FEE_HEAD_CATEGORIES)[number];

/**
 * `fee_heads.frequency`. The charge job generates `monthly` and `yearly` heads only; `once` heads
 * are charged at admission and readmission; `per_term` and `ad_hoc` by campaign or by hand.
 */
export const FEE_FREQUENCIES = ['monthly', 'once', 'yearly', 'per_term', 'ad_hoc'] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];

/** `fee_heads.status`: a head is archived, never deleted (R176). */
export const FEE_HEAD_STATUSES = ['active', 'archived'] as const;
export type FeeHeadStatus = (typeof FEE_HEAD_STATUSES)[number];

/** `fee_structures.status`: a same-month replacement supersedes the active row (R177). */
export const FEE_STRUCTURE_STATUSES = ['active', 'superseded'] as const;
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUSES)[number];

/**
 * The five heads every school starts with (rule 18, R176), inserted in the school-creation
 * transaction and backfilled; `created_by` is null on each. The school edits and archives them.
 * The database function asms_seed_school_finance holds the same rows (migration
 * 20261005182000_slice18_fee_setup); a test compares the two.
 */
export const SEEDED_FEE_HEADS: readonly {
  readonly name: string;
  readonly category: FeeHeadCategory;
  readonly frequency: FeeFrequency;
  readonly concessionEligible: boolean;
  readonly refundable: boolean;
}[] = [
  { name: 'Tuition', category: 'tuition', frequency: 'monthly', concessionEligible: true, refundable: true },
  { name: 'Admission', category: 'admission', frequency: 'once', concessionEligible: true, refundable: false },
  { name: 'Annual charges', category: 'annual', frequency: 'yearly', concessionEligible: true, refundable: true },
  { name: 'Exam', category: 'exam', frequency: 'per_term', concessionEligible: true, refundable: true },
  { name: 'Fine', category: 'fine', frequency: 'ad_hoc', concessionEligible: false, refundable: true },
];

/** Where parents can pay besides the counter (rule 21). An active account turns claims on. */
export const PAYMENT_ACCOUNT_KINDS = ['bank', 'jazzcash', 'easypaisa'] as const;
export type PaymentAccountKind = (typeof PAYMENT_ACCOUNT_KINDS)[number];

export const PAYMENT_ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export type PaymentAccountStatus = (typeof PAYMENT_ACCOUNT_STATUSES)[number];

/** Display words, shared by the web and the app. */
export const PAYMENT_ACCOUNT_KIND_LABELS: Record<PaymentAccountKind, string> = {
  bank: 'Bank account',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};

export const FEE_FREQUENCY_LABELS: Record<FeeFrequency, string> = {
  monthly: 'Monthly',
  once: 'Once',
  yearly: 'Yearly',
  per_term: 'Per term',
  ad_hoc: 'Ad hoc',
};

export const FEE_HEAD_CATEGORY_LABELS: Record<FeeHeadCategory, string> = {
  tuition: 'Tuition',
  admission: 'Admission',
  annual: 'Annual',
  exam: 'Exam',
  fine: 'Fine',
  other: 'Other',
};

// --------------------------------------------------------------------- charges, concessions

export const CONCESSION_KINDS = ['percentage', 'fixed'] as const;
export type ConcessionKind = (typeof CONCESSION_KINDS)[number];

export const CONCESSION_STATUSES = ['requested', 'approved', 'rejected', 'ended'] as const;
export type ConcessionStatus = (typeof CONCESSION_STATUSES)[number];

export const CHARGE_KINDS = ['generated', 'campaign', 'manual', 'late_fee', 'adjustment'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** `open -> settled | voided | waived`; `settled -> open` only while a payment is reversed. */
export const CHARGE_STATUSES = ['open', 'settled', 'voided', 'waived'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export const CHARGE_RUN_KINDS = ['monthly', 'campaign'] as const;
export type ChargeRunKind = (typeof CHARGE_RUN_KINDS)[number];

export const CHARGE_RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type ChargeRunStatus = (typeof CHARGE_RUN_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'generating', 'generated', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// ------------------------------------------------------------------------------- payments

/** `carried_forward` is internal: written by a carry-forward, never offered at the counter (A8). */
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'jazzcash', 'easypaisa', 'carried_forward'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The methods a person may choose at the counter or on a claim. */
export const COUNTER_PAYMENT_METHODS = ['cash', 'bank_transfer', 'jazzcash', 'easypaisa'] as const satisfies readonly PaymentMethod[];
export type CounterPaymentMethod = (typeof COUNTER_PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['verified', 'voided'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REVERSAL_KINDS = ['void', 'refund', 'refund_reversal', 'carried_forward'] as const;
export type ReversalKind = (typeof REVERSAL_KINDS)[number];

export const CLAIM_STATUSES = ['pending', 'verified', 'rejected', 'withdrawn', 'expired'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const HANDOVER_STATUSES = ['open', 'confirmed'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

export const SHORTFALL_RESOLUTIONS = ['recovered', 'written_off', 'explained_by_void'] as const;
export type ShortfallResolution = (typeof SHORTFALL_RESOLUTIONS)[number];

// ------------------------------------------------------------------------------- expenses

/** The functional spec's list (§14) plus the categories the system writes itself (A17). */
export const EXPENSE_CATEGORIES = [
  'electricity',
  'water',
  'internet',
  'cleaning',
  'stationery',
  'repairs',
  'maintenance',
  'fuel',
  'transport',
  'building',
  'daily_purchases',
  'salary_advance_cash',
  'cash_shortfall',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ['recorded', 'pending_approval', 'approved', 'rejected', 'voided'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// ------------------------------------------------------------------------- leave, payroll

export const LEAVE_CODES = ['casual', 'sick', 'unpaid', 'other'] as const;
export type LeaveCode = (typeof LEAVE_CODES)[number];

/** `leave_types.status`: a type is archived, never deleted or changed. */
export const LEAVE_TYPE_STATUSES = ['active', 'archived'] as const;
export type LeaveTypeStatus = (typeof LEAVE_TYPE_STATUSES)[number];

/**
 * The three leave types every school starts with (§1.1 item 22), `created_by` null, inserted by
 * the database function asms_seed_school_finance (migration 20261006100300_slice24_leave) in the
 * school-creation transaction and backfilled. `daysPerYear` null = unlimited.
 */
export const SEEDED_LEAVE_TYPES: readonly {
  readonly name: string;
  readonly code: LeaveCode;
  readonly daysPerYear: number | null;
  readonly paid: boolean;
}[] = [
  { name: 'Casual leave', code: 'casual', daysPerYear: 10, paid: true },
  { name: 'Sick leave', code: 'sick', daysPerYear: 10, paid: true },
  { name: 'Unpaid leave', code: 'unpaid', daysPerYear: null, paid: false },
];

export const LEAVE_STATUSES =['pending', 'approved', 'rejected', 'cancelled', 'ended_early'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const SALARY_STRUCTURE_STATUSES = ['active', 'superseded'] as const;
export type SalaryStructureStatus = (typeof SALARY_STRUCTURE_STATUSES)[number];

export const PAYROLL_RUN_STATUSES = ['draft', 'finalised'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const PAYSLIP_STATUSES = ['pending', 'paid'] as const;
export type PayslipStatus = (typeof PAYSLIP_STATUSES)[number];

export const PAYSLIP_LINE_KINDS = ['allowance', 'deduction', 'absence', 'advance_recovery', 'adjustment'] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];

export const ADVANCE_STATUSES = ['open', 'recovered', 'written_off'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

// ------------------------------------------------------------------------ platform billing

export const PLAN_STATUSES = ['active', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Why the monthly billing run skipped a school: a type, not error codes (§5.1). */
export const BILLING_SKIP_REASONS = ['trial', 'terminated', 'no_metrics', 'no_band'] as const;
export type BillingSkipReason = (typeof BILLING_SKIP_REASONS)[number];

// ------------------------------------------------------------------------------- counters

/** One receipt sequence per school per academic year (rule 18): `receipt_<academicYearId>`. */
export type ReceiptCounterName = `receipt_${string}`;

/**
 * `school_counters.name` (CHECK school_counters_name_check): admission numbers, expense numbers
 * (created with the school) and one receipt counter per academic year (created with the year).
 */
export type SchoolCounterName = 'admission_no' | 'expense_no' | ReceiptCounterName;

export const receiptCounterName = (academicYearId: bigint | string): ReceiptCounterName =>
  `receipt_${academicYearId.toString()}`;
