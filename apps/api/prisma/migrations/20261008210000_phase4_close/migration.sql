-- Phase 4 close (slice 36): the performance review's index for the result-notify sweep.
-- =============================================================================================
--
-- ResultRepository.unnotifiedSheetIds runs every two minutes per school: the published, live
-- results not yet told, distinct by sheet. Without an index it scanned every result of the school
-- (measured at 3,000 students x 6 years). A partial index holds only the rows still to tell, so it
-- stays a handful of entries however many results the school keeps. Like results_term_live_idx it
-- is not declared in schema.prisma (Prisma has no partial-index syntax); the schema guard
-- (test/guardrails/schema-checks.ts) holds its definition.
CREATE INDEX "results_unnotified_idx" ON "results" ("school_id", "sheet_id")
  WHERE "notified_at" IS NULL AND "superseded_at" IS NULL;
