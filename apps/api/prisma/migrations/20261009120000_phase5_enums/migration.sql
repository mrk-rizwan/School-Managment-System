-- Phase 5 groundwork (phase-5-extended.md §3.4, §4 migration (1)): the five Phase 5 message types
-- and the two fee-head categories, appended in their own migration because a value added by
-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it. The next migration uses
-- the two categories (the seeded heads, the one-transport-head index, the fee_structures trigger).
ALTER TYPE "message_type" ADD VALUE 'contract_expiring';
ALTER TYPE "message_type" ADD VALUE 'support_session_opened';
ALTER TYPE "message_type" ADD VALUE 'support_session_closed';
ALTER TYPE "message_type" ADD VALUE 'attendance_disputed';
ALTER TYPE "message_type" ADD VALUE 'attendance_dispute_decided';

ALTER TYPE "fee_head_category" ADD VALUE 'event';
ALTER TYPE "fee_head_category" ADD VALUE 'transport';
