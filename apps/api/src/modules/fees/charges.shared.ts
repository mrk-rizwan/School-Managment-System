// Slice 19's shared pieces: the refusals of §5.1 with their details, the DTO mappers, and the
// calendar arithmetic of a period (phase-3-financial.md §3.3, R180, R240).
import { addDaysTo, dayOfPeriod, ErrorCode, outstanding } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import type { ChargeCreate, ChargeRecord } from '../../repositories/charge.repository';
import type { ChargeRunRecord, SkippedClass } from '../../repositories/charge-run.repository';
import type { ConcessionRecord } from '../../repositories/concession.repository';
import type { SchoolSettingsRecord } from '../../repositories/school-settings.repository';
import { toDateString } from '../academics/academics.shared';
import type { ChargeDto, ChargeRunDto, ConcessionDto } from './charges.dto';

// ------------------------------------------------------------------------------- refusals

export const chargeNotOpen = (chargeId: bigint, extra: Record<string, string | number> = {}): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_NOT_OPEN, 'This charge is no longer open.', {
    chargeId: chargeId.toString(),
    ...extra,
  });

export const chargeHasAllocations = (chargeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_HAS_ALLOCATIONS, 'Payments are allocated to this charge.', {
    chargeId: chargeId.toString(),
  });

/**
 * 409 on a void of a charge that carries credits (adjustments): voiding it would leave the credit
 * rows pointing at nothing owed. Void it only before crediting; to undo a credit, raise the charge
 * again by hand.
 */
export const chargeHasCredits = (chargeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_HAS_ALLOCATIONS, 'Credits are recorded against this charge.', {
    chargeId: chargeId.toString(),
    reason: 'has_credits',
  });

export const chargeNotLateFee = (chargeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_NOT_LATE_FEE, 'Only a late fee can be waived.', {
    chargeId: chargeId.toString(),
  });

export const runInProgress = (runId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CHARGE_RUN_IN_PROGRESS, 'Charges for this year are being generated. Try again shortly.', {
    runId: runId.toString(),
  });

export type NotGeneratableReason = 'future' | 'outside_year' | 'year_closed';

export const monthNotGeneratable = (reason: NotGeneratableReason): ApiException =>
  new ApiException(
    409,
    ErrorCode.MONTH_NOT_GENERATABLE,
    reason === 'future'
      ? 'That month has not started yet.'
      : reason === 'outside_year'
        ? 'That month is outside the academic year.'
        : 'That academic year is closed.',
    { reason },
  );

export const concessionNotPending = (concessionId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CONCESSION_NOT_PENDING, 'This concession has already been decided.', {
    concessionId: concessionId.toString(),
  });

export const concessionExists = (concessionId: bigint, feeHeadId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.CONCESSION_EXISTS,
    'The student already has a concession on that fee head this year.',
    { concessionId: concessionId.toString(), feeHeadId: feeHeadId.toString() },
  );

export const concessionHeadNotEligible = (feeHeadId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CONCESSION_HEAD_NOT_ELIGIBLE, 'That fee head does not take concessions.', {
    feeHeadId: feeHeadId.toString(),
  });

export const campaignNotDraft = (campaignId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CAMPAIGN_NOT_DRAFT, 'This campaign is no longer a draft.', {
    campaignId: campaignId.toString(),
  });

export const campaignNoTargets = (): ApiException =>
  new ApiException(409, ErrorCode.CAMPAIGN_NO_TARGETS, 'The audience reaches no enrolled student.');

export const studentNotActive = (): ApiException =>
  new ApiException(409, ErrorCode.STUDENT_NOT_ACTIVE, 'This student has left the school.');

// ------------------------------------------------------------------------------- mappers

export function toChargeDto(row: ChargeRecord): ChargeDto {
  return {
    id: row.id.toString(),
    studentId: row.studentId.toString(),
    studentName: row.enrolment.student.fullName,
    admissionNo: row.enrolment.student.admissionNo,
    enrolmentId: row.enrolmentId.toString(),
    className: row.enrolment.class.name,
    sectionName: row.enrolment.section.name,
    academicYearId: row.academicYearId.toString(),
    feeHeadId: row.feeHeadId.toString(),
    feeHeadName: row.feeHead.name,
    kind: row.kind,
    period: row.period,
    campaignId: row.campaignId?.toString() ?? null,
    lateFeeForChargeId: row.lateFeeForChargeId?.toString() ?? null,
    adjustsChargeId: row.adjustsChargeId?.toString() ?? null,
    concessionId: row.concessionId?.toString() ?? null,
    grossAmount: row.grossAmount,
    concessionAmount: row.concessionAmount,
    amount: row.amount,
    allocatedAmount: row.allocatedAmount,
    creditedAmount: row.creditedAmount,
    // An adjustment row is a credit, never owed.
    outstanding: row.kind === 'adjustment' || row.status !== 'open' ? 0 : outstanding(row),
    description: row.description,
    dueOn: toDateString(row.dueOn),
    status: row.status,
    settledAt: row.settledAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    waivedAt: row.waivedAt,
    waiveReason: row.waiveReason,
    createdByUserId: row.createdBy?.toString() ?? null,
    createdAt: row.createdAt,
  };
}

export function toConcessionDto(row: ConcessionRecord): ConcessionDto {
  return {
    id: row.id.toString(),
    studentId: row.studentId.toString(),
    studentName: row.enrolment.student.fullName,
    academicYearId: row.academicYearId.toString(),
    enrolmentId: row.enrolmentId.toString(),
    className: row.enrolment.class.name,
    kind: row.kind,
    value: row.value,
    heads: row.heads.map((h) => ({ feeHeadId: h.feeHeadId.toString(), name: h.feeHead.name })),
    effectiveFrom: row.effectiveFrom,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requestedBy.toString(),
    requestedByName: row.requestedByUser.staff?.fullName ?? null,
    requestedAt: row.requestedAt,
    decidedByUserId: row.decidedBy?.toString() ?? null,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    selfApproved: row.selfApproved,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

const isSkipped = (value: unknown): value is SkippedClass =>
  typeof value === 'object' &&
  value !== null &&
  'classId' in value &&
  typeof value.classId === 'string' &&
  'reason' in value &&
  typeof value.reason === 'string';

/** The stored skipped classes (allowlisted jsonb), with their names. */
export function skippedClassesOf(row: ChargeRunRecord): SkippedClass[] {
  if (!Array.isArray(row.skippedClasses)) return [];
  return row.skippedClasses.flatMap((item: unknown) => (isSkipped(item) ? [item] : []));
}

export function toChargeRunDto(row: ChargeRunRecord, classNames: ReadonlyMap<string, string>): ChargeRunDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    period: row.period,
    kind: row.kind,
    campaignId: row.campaignId?.toString() ?? null,
    status: row.status,
    regenerateVoided: row.regenerateVoided,
    triggeredBy: row.triggeredBy?.toString() ?? null,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    studentsCharged: row.studentsCharged,
    chargesInserted: row.chargesInserted,
    chargesSkipped: row.chargesSkipped,
    skippedClasses: skippedClassesOf(row).map((c) => ({
      classId: c.classId,
      className: classNames.get(c.classId) ?? '',
      reason: c.reason,
    })),
    errorCode: row.errorCode,
  };
}

// ------------------------------------------------------------------------------- periods

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `YYYY-MM` of a DATE value. */
export const periodOf = (day: Date): string => day.toISOString().slice(0, 7);

/** `October 2026`. */
export function monthLabel(period: string): string {
  return `${MONTH_NAMES[Number(period.slice(5, 7)) - 1] ?? period} ${period.slice(0, 4)}`;
}

/** The period's first and last days, `YYYY-MM-DD`. */
export function periodBounds(period: string): { start: string; end: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: dayOfPeriod(period, 1), end: dayOfPeriod(period, last) };
}

/** The months an academic year spans, as `YYYY-MM` bounds. */
export const yearMonths = (year: { startsOn: Date; endsOn: Date }): { from: string; to: string } => ({
  from: periodOf(year.startsOn),
  to: periodOf(year.endsOn),
});

/**
 * The grace a born-late charge gets (§1.1 "Born-late charges"): the late-fee grace while late
 * fees are on, else 7 days.
 */
export const chargeGrace = (settings: Pick<SchoolSettingsRecord, 'lateFeeEnabled' | 'lateFeeGraceDays'>): number =>
  settings.lateFeeEnabled ? settings.lateFeeGraceDays : 7;

/** `YYYY-MM-DD` `days` after `day`. */
export const plusDays = (day: string, days: number): string => addDaysTo(day, days);

/** A credit row against `row` (R186, A6): settled, never owed, same child, year and head. */
export function adjustmentOf(
  row: ChargeRecord,
  amount: number,
  concessionId: bigint | null,
  createdBy: bigint,
): ChargeCreate {
  const prefix = concessionId === null ? 'Adjustment' : 'Concession';
  return {
    enrolmentId: row.enrolmentId,
    studentId: row.studentId,
    academicYearId: row.academicYearId,
    feeHeadId: row.feeHeadId,
    headFrequency: row.headFrequency,
    kind: 'adjustment',
    period: row.period,
    adjustsChargeId: row.id,
    concessionId,
    grossAmount: amount,
    concessionAmount: 0,
    description: `${prefix}: ${row.description}`.slice(0, 200).trimEnd(),
    dueOn: row.dueOn,
    createdBy,
  };
}

