-- Slice 14 (contracts/slice-14.md §4.4, §11 item 8): a later recipient sharing an earlier one's
-- phone keeps its inbox row and push but loses WhatsApp and SMS; when nothing else is left the
-- message is suppressed with this reason. A new enum value cannot be used in the transaction that
-- adds it (the slice-10 `cover` precedent), so it is its own migration before
-- slice14_announcements. Generated SQL reviewed: no drift.

-- AlterEnum
ALTER TYPE "suppression_reason" ADD VALUE 'duplicate_phone';
