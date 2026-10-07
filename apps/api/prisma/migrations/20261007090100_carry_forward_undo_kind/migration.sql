-- Phase 3 close (business-rules review G1): a carry-forward can be undone while its carried
-- payment in the target year is still wholly unallocated. The new reversal kind is added alone:
-- an enum value cannot be used in the transaction that adds it. Its rules and effect are in
-- 20261007090200_carry_forward_undo.
ALTER TYPE "reversal_kind" ADD VALUE 'carry_forward_reversal';
