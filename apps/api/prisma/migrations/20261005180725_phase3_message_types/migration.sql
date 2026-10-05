-- Phase 3 groundwork (phase-3-financial.md §3.6, §4): the eighteen Phase 3 message types,
-- appended to message_type in their own migration because a value added by ALTER TYPE ... ADD
-- VALUE cannot be used in the transaction that adds it. The next migration uses four of them in
-- the school_settings.sms_allowed_types default and its backfill.
ALTER TYPE "message_type" ADD VALUE 'fee_charged';
ALTER TYPE "message_type" ADD VALUE 'fee_due_reminder';
ALTER TYPE "message_type" ADD VALUE 'fee_overdue';
ALTER TYPE "message_type" ADD VALUE 'receipt_issued';
ALTER TYPE "message_type" ADD VALUE 'payment_claim_rejected';
ALTER TYPE "message_type" ADD VALUE 'payment_claim_submitted';
ALTER TYPE "message_type" ADD VALUE 'handover_shortfall';
ALTER TYPE "message_type" ADD VALUE 'reminder_sms_capped';
ALTER TYPE "message_type" ADD VALUE 'concession_requested';
ALTER TYPE "message_type" ADD VALUE 'concession_decided';
ALTER TYPE "message_type" ADD VALUE 'expense_approval_requested';
ALTER TYPE "message_type" ADD VALUE 'expense_decided';
ALTER TYPE "message_type" ADD VALUE 'leave_requested';
ALTER TYPE "message_type" ADD VALUE 'leave_decided';
ALTER TYPE "message_type" ADD VALUE 'payslip_ready';
ALTER TYPE "message_type" ADD VALUE 'platform_invoice_issued';
ALTER TYPE "message_type" ADD VALUE 'platform_invoice_overdue';
ALTER TYPE "message_type" ADD VALUE 'billing_tier_missing';
