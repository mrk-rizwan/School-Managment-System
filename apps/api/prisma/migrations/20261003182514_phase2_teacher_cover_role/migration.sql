-- Phase 2 groundwork (phase-2-daily-operations.md §5, contracts/slice-10.md §6). A new enum value
-- cannot be used in the transaction that adds it, so the cover CHECK, covers_assignment_id and
-- everything else that names 'cover' are in the next migration. Generated SQL reviewed: no drift.

-- AlterEnum
ALTER TYPE "teacher_assignment_role" ADD VALUE 'cover';
