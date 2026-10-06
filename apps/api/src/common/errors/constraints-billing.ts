// Constraint → refusal mappings for slice 26, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-I builds never edit the same file.
//
// The billing services check each of these first and answer with the contract's details; these
// entries are the fallback for a concurrent write (or a DTO rule a direct write would bypass), so
// no billing constraint can surface as a 500 (contracts/slice-26.md §6).
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';

const fieldInvalid = (path: string, message: string) =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code: ErrorCode.INVALID_VALUE, message }],
  });

const bandOverlaps = () =>
  new ApiException(409, ErrorCode.PLAN_BAND_OVERLAPS, 'The band overlaps an active plan.');

const planArchived = () =>
  new ApiException(409, ErrorCode.PLAN_ARCHIVED, 'An archived plan cannot be changed.');

const invoiceNotIssued = () =>
  new ApiException(409, ErrorCode.INVOICE_NOT_ISSUED, 'The invoice is no longer issued.');

export const SLICE_26_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R219: active bands never overlap (EXCLUDE, SQLSTATE 23P01).
  platform_plans_band_excl: bandOverlaps,
  platform_plans_band_check: () =>
    fieldInvalid('maxStudents', 'maxStudents must be at least minStudents'),
  platform_plans_name_check: () => fieldInvalid('name', 'name must not be blank'),
  platform_plans_money_check: () =>
    fieldInvalid('monthlyPrice', 'monthlyPrice and smsAllowance must not be negative'),
  // The archived plan is frozen whole (platform_plans_archived_frozen raises per column).
  platform_plans_archived_at_frozen: planArchived,
  platform_plans_status_frozen: planArchived,
  platform_plans_name_frozen: planArchived,
  platform_plans_monthly_price_frozen: planArchived,
  platform_plans_sms_allowance_frozen: planArchived,
  // One live subscription per school: two writers raced; the request is retried by the caller.
  platform_subscriptions_live_key: concurrentUpdate,
  platform_subscriptions_ended_on_frozen: concurrentUpdate,
  // R220: one non-void invoice per school per month. The run recovers it as "already issued".
  platform_invoices_month_key: concurrentUpdate,
  platform_invoices_invoice_no_key: concurrentUpdate,
  // issued -> paid | void only; a second payment for the invoice.
  platform_invoices_status_transition: invoiceNotIssued,
  platform_invoices_paid_at_frozen: invoiceNotIssued,
  platform_invoices_voided_at_frozen: invoiceNotIssued,
  platform_payments_invoice_id_key: invoiceNotIssued,
  platform_payments_reference_check: () => fieldInvalid('reference', 'reference must not be blank'),
  platform_payments_reference_no_id_check: () =>
    fieldInvalid('reference', 'reference must not contain an identity number'),
  platform_subscriptions_reason_no_id_check: () =>
    fieldInvalid('reason', 'reason must not contain an identity number'),
  platform_invoices_void_reason_no_id_check: () =>
    fieldInvalid('reason', 'reason must not contain an identity number'),
  platform_settings_invoice_due_day_check: () =>
    fieldInvalid('invoiceDueDay', 'invoiceDueDay must be between 1 and 28'),
  platform_settings_grace_days_check: () =>
    fieldInvalid('graceDays', 'graceDays must be between 0 and 90'),
};
