-- Slice 12 review fix B9 (contracts/slice-12.md §1, §5): the row lock is now a SELECT ... FOR
-- UPDATE (StaffAttendanceRepository), so nothing writes marked_by or marked_at after the insert.
-- Who first marked a row, and when, never change: a correction is recorded by the history
-- trigger with its own actor and time.

-- =============================================================================================
-- Hand-written. No schema change.
-- =============================================================================================

DROP TRIGGER "staff_attendance_columns_immutable" ON "staff_attendance";
CREATE TRIGGER "staff_attendance_columns_immutable" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'date', 'marked_by', 'marked_at');
