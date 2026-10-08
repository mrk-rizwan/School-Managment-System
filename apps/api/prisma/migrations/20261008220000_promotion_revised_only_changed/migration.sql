-- Phase 4 close (contracts/slice-35.md §4 "After apply", §6): an applied promotion decision is
-- marked revised_after_apply only when its result really changed. Hand-written; no Prisma schema
-- change. Every object here is listed in test/guardrails/schema-checks.ts (WAVE_P_OBJECTS).
--
-- The wave P trigger fired on every superseded result. A correction (slice 32) supersedes the
-- FULL row set of the section's sheet version, so every applied decision of the section was
-- flagged, not only the student whose figures changed. Now:
--   1. a correction: the row that replaces the decision's result is inserted with
--      `revised = true` (its printed figures changed: totals, verdict, position or a subject).
--      A row carried over unchanged (`revised = false`) flags nothing.
--   2. a return of an approved sheet (result-sheets return): its rows are superseded with no
--      replacement, so the result the decision was applied on is withdrawn; that still flags. The
--      return moves the sheet to `returned` before it supersedes the rows.

DROP TRIGGER "results_promotion_revised" ON "results";
DROP FUNCTION asms_promotion_result_revised();

CREATE FUNCTION asms_promotion_result_revised() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result_id bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A correction's revised row: the result it supersedes.
    v_result_id := NEW.supersedes_id;
  ELSIF EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id AND s.status = 'returned'
  ) THEN
    -- A row withdrawn by its sheet's return.
    v_result_id := NEW.id;
  ELSE
    -- Superseded by a correction's new version: decided by the replacing row's insert.
    RETURN NULL;
  END IF;
  UPDATE promotion_decisions d
  SET revised_after_apply = true, updated_at = CURRENT_TIMESTAMP
  WHERE d.school_id = NEW.school_id AND d.result_id = v_result_id
    AND d.applied_at IS NOT NULL AND NOT d.revised_after_apply;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "results_promotion_revised" AFTER INSERT ON "results"
  FOR EACH ROW WHEN (NEW."supersedes_id" IS NOT NULL AND NEW."revised")
  EXECUTE FUNCTION asms_promotion_result_revised();

CREATE TRIGGER "results_promotion_returned" AFTER UPDATE OF "superseded_at" ON "results"
  FOR EACH ROW WHEN (OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL)
  EXECUTE FUNCTION asms_promotion_result_revised();
