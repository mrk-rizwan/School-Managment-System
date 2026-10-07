/**
 * Phase 4 (Academic) value sets and defaults (phase-4-academic.md §1.1, §3, §5.1). Each value set
 * that has a table mirrors the Postgres enum of the same name: `pass_rule` since the groundwork
 * migration, the rest with the tables of their wave (test/guardrails/shared-enums.e2e-spec.ts
 * compares them once they exist).
 */

/** A `test` is the teacher's (any size, any number); the `exam` is one per class-subject per section per term. */
export const ASSESSMENT_KINDS = ['test', 'exam'] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];

/** A label on a test; no behaviour (§1.1). A practical or oral is `other` (A2). */
export const TEST_TYPES = ['daily', 'weekly', 'monthly', 'other'] as const;
export type TestType = (typeof TEST_TYPES)[number];

/** `marks.status`: a mark is never edited; a change is a new row (§0.25). */
export const ASSESSMENT_MARK_STATUSES = ['live', 'pending', 'superseded', 'rejected'] as const;
export type AssessmentMarkStatus = (typeof ASSESSMENT_MARK_STATUSES)[number];

/** The per-row answer of `submit-marks` (slice 30). Distinct from attendance's `MarkOutcome`. */
export const MARK_ENTRY_OUTCOMES = ['created', 'superseded', 'unchanged', 'changed_elsewhere'] as const;
export type MarkEntryOutcome = (typeof MARK_ENTRY_OUTCOMES)[number];

/** `result_sheets.status` (§3.2). A version inserted by a correction is born `published`. */
export const RESULT_SHEET_STATUSES = ['draft', 'submitted', 'returned', 'approved', 'published'] as const;
export type ResultSheetStatus = (typeof RESULT_SHEET_STATUSES)[number];

/** A subject on a result: `not_assessed` iff it has no percentage (§3.2), printed "—". */
export const RESULT_SUBJECT_STATUSES = ['assessed', 'not_assessed'] as const;
export type ResultSubjectStatus = (typeof RESULT_SUBJECT_STATUSES)[number];

/**
 * Rule 26, §1.1: `all_subjects` passes when every assessed subject's printed obtained ÷ max is at
 * or above the pass mark; `overall` when the overall percentage is.
 */
export const PASS_RULES = ['all_subjects', 'overall'] as const;
export type PassRule = (typeof PASS_RULES)[number];

/** Rule 29. `other` carries a free title. */
export const CERTIFICATE_TYPES = ['leaving', 'character', 'academic', 'completion', 'other'] as const;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];

/**
 * How a certificate stood against the dues endpoint (rule 20): only the leaving certificate is
 * gated, so every other type is `not_required`.
 */
export const DUES_STATUSES = ['not_required', 'cleared', 'override'] as const;
export type DuesStatus = (typeof DUES_STATUSES)[number];

/** Rule 30's four outcomes. */
export const PROMOTION_OUTCOMES = ['promote', 'detain', 'complete', 'not_continuing'] as const;
export type PromotionOutcome = (typeof PROMOTION_OUTCOMES)[number];

export const PROMOTION_SHEET_STATUSES = ['open', 'applied'] as const;
export type PromotionSheetStatus = (typeof PROMOTION_SHEET_STATUSES)[number];

// ------------------------------------------------------------------------------ certificates

/** Printed prefixes (§1.1): `LC-0001`, at least four digits, one sequence per type, never reset. */
export const CERTIFICATE_PREFIXES: Readonly<Record<CertificateType, string>> = {
  leaving: 'LC',
  character: 'CC',
  academic: 'AC',
  completion: 'PC',
  other: 'OC',
};

export type CertificateCounterName = `cert_${CertificateType}`;

export const certificateCounterName = (type: CertificateType): CertificateCounterName => `cert_${type}`;

/** `LC-0001`; a number above 9999 keeps all its digits. */
export const certificateLabel = (type: CertificateType, number: number): string =>
  `${CERTIFICATE_PREFIXES[type]}-${String(number).padStart(4, '0')}`;

// ------------------------------------------------------------------------------- set-up

/** Up to six terms per academic year (§1.1). */
export const MAX_TERMS_PER_YEAR = 6;

/** The two terms `asms_seed_year_results` writes for a new year (§1.1): first half, then the rest. */
export const SEEDED_TERM_NAMES = ['Mid-term', 'Annual'] as const;

/** Rule 26's weight defaults: class tests 20, the exam 80 (per year, summing to 100). */
export const DEFAULT_TEST_WEIGHT = 20;
export const DEFAULT_EXAM_WEIGHT = 80;

/** Rule 26: a subject is passed at 40 % by default. */
export const DEFAULT_PASS_PERCENT = 40;

/** An exam's max marks default (class_subjects.exam_max_marks); a mark's range is 1-1000. */
export const DEFAULT_EXAM_MAX_MARKS = 100;
export const MAX_ASSESSMENT_MARKS = 1000;

/** A term remark, written by the class teacher on the sheet (§1.1). */
export const TERM_REMARK_MAX = 300;
