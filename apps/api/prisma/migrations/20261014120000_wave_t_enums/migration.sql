-- Phase 5 wave T (phase-5-extended.md §5 slice 44: `POST /me/staff/attendance-disputes/:id/withdraw`):
-- a staff member may take back a pending dispute. The groundwork's dispute_status had no value for
-- it; appended in its own migration because a value added by ALTER TYPE ... ADD VALUE cannot be
-- used in the transaction that adds it. The next migration uses it (the dispute CHECKs and the
-- status transition).
ALTER TYPE "dispute_status" ADD VALUE 'withdrawn';
