-- Phase 2 close, performance review (measured on a seeded 3,000-student school): the messaging
-- housekeeping sweeps (expireUnreported, listAwaitingPoll, countByChannelAndStatus,
-- listUnrolledReports) scanned every delivery of a school every 2 to 15 minutes, and the
-- whole-school attendance percentage report scanned every day-status row.
-- CreateIndex
CREATE INDEX "attendance_day_status_school_id_date_student_id_idx" ON "attendance_day_status"("school_id", "date", "student_id");

-- CreateIndex
CREATE INDEX "message_deliveries_school_id_channel_status_attempted_at_idx" ON "message_deliveries"("school_id", "channel", "status", "attempted_at");

-- CreateIndex
CREATE INDEX "message_deliveries_school_id_attempted_at_idx" ON "message_deliveries"("school_id", "attempted_at");

-- CreateIndex
CREATE INDEX "message_deliveries_school_id_status_delivered_at_idx" ON "message_deliveries"("school_id", "status", "delivered_at");

-- CreateIndex
CREATE INDEX "message_deliveries_school_id_status_failed_at_idx" ON "message_deliveries"("school_id", "status", "failed_at");
