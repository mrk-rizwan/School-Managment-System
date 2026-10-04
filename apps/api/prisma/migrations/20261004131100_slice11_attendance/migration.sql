-- Slice 11 (student attendance) over the wave-E groundwork (contracts/slice-11.md §12).

-- AlterTable
ALTER TABLE "attendance_day_status" ADD COLUMN     "first_late_arrived_at" TIME(0);

-- AlterTable
ALTER TABLE "attendance_mark_changes" ADD COLUMN     "new_arrived_at" TIME(0),
ADD COLUMN     "old_arrived_at" TIME(0);

-- =============================================================================================
-- Hand-written below this line. Generated SQL above reviewed: no drift lines.
-- =============================================================================================

-- §12 item 2: a change to the arrival time is a correction of record and takes the same reason.
-- The generic §4.6 trigger writes old_<col>/new_<col> for every tracked column, so the history
-- trigger is re-created with arrived_at as its third tracked column.
DROP TRIGGER "attendance_marks_history" ON "attendance_marks";
CREATE TRIGGER "attendance_marks_history" BEFORE UPDATE ON "attendance_marks"
  FOR EACH ROW EXECUTE FUNCTION asms_record_change(
    'attendance_mark_changes', 'mark_id', 'reason_required', 'status', 'note', 'arrived_at');

-- §12 item 3: the stale section-days, for the outbox sweep's attendance source and the nightly
-- recompute (§8.3). A column comparison, not an enum: Prisma's enum cast does not apply.
CREATE INDEX "attendance_daily_summary_stale_idx" ON "attendance_daily_summary" ("school_id", "date")
  WHERE "computed_version" <> "version";

-- §12 item 5.
COMMENT ON TABLE "attendance_day_status" IS
  'R127 materialised per enrolment-day. Nothing stored says whether the date is a teaching day: '
  'every reader (the percentage, Phase 4 report cards) must apply the school calendar at read '
  '(contracts/slice-11.md §7).';
