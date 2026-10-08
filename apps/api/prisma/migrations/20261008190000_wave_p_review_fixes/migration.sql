-- Phase 4 wave P review fixes (contracts/slice-32.md §4, contracts/slice-35.md §1, §6): the
-- database half of R281 (a correction's author never decides it; a corrected sheet version's
-- submitter never decides it), and the cancelled promotion sheet. Hand-written; every object is
-- listed in test/guardrails/schema-checks.ts (WAVE_P_OBJECTS). Trigger functions raise SQLSTATE
-- 23514 with DETAIL 'constraint: <name>'.

-- ---- marks (R281) ---------------------------------------------------------------------------------

-- A correction made live is never decided by the person who entered it, except by the school's
-- sole active principal (the service records selfApproved). A rejection by its author is the
-- requester withdrawing their own request, and stays allowed.
CREATE FUNCTION asms_mark_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'live' AND NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.entered_by
     AND NOT asms_is_sole_principal(NEW.school_id, NEW.decided_by) THEN
    RAISE EXCEPTION 'a correction is decided by someone other than its author (marks_not_self)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'marks_not_self',
            DETAIL = 'constraint: marks_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "marks_not_self" BEFORE UPDATE OF "decided_by" ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_mark_not_self();

-- ---- result_sheets (R281) -------------------------------------------------------------------------

-- Extended to INSERT: a correction's version n+1 is born decided (supersedes_id set), so its
-- decider is held to the same rule as an approval — never the submitter, except the sole
-- principal recorded self_approved; self_approved only when they are the same person.
CREATE OR REPLACE FUNCTION asms_result_sheet_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.decided_by IS NULL OR NEW.term_id IS NULL THEN
    IF NEW.self_approved AND NEW.term_id IS NULL THEN
      v_refusal := 'result_sheets_self_approved_unwarranted';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.decided_by = NEW.submitted_by THEN
      IF NOT (NEW.self_approved AND asms_is_sole_principal(NEW.school_id, NEW.decided_by)) THEN
        v_refusal := 'result_sheets_not_self';
      END IF;
    ELSIF NEW.self_approved THEN
      v_refusal := 'result_sheets_self_approved_unwarranted';
    END IF;
  ELSIF (NEW.decided_by, NEW.decided_at) IS DISTINCT FROM (OLD.decided_by, OLD.decided_at)
        OR NEW.self_approved IS DISTINCT FROM OLD.self_approved THEN
    IF NEW.decided_by = NEW.submitted_by THEN
      -- The sole principal may approve (recorded self_approved) or return their own submission.
      IF NOT (((NEW.self_approved AND NEW.status = 'approved') OR (NOT NEW.self_approved AND NEW.status = 'returned'))
              AND asms_is_sole_principal(NEW.school_id, NEW.decided_by)) THEN
        v_refusal := 'result_sheets_not_self';
      END IF;
    ELSIF NEW.self_approved THEN
      v_refusal := 'result_sheets_self_approved_unwarranted';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the decision is refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "result_sheets_not_self" ON "result_sheets";
CREATE TRIGGER "result_sheets_not_self" BEFORE INSERT OR UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_not_self();

-- ---- promotion_sheets (contracts/slice-35.md §1: cancel) ----------------------------------------

-- An open sheet may be cancelled (its rows stay, frozen by promotion_decisions_guard; the
-- section's open slot, promotion_sheets_open_key, is freed; the year-close guard counts only
-- applied sheets). The new value is only named inside trigger arguments here, never in a
-- predicate, so it is safe in the same transaction as ADD VALUE.
ALTER TYPE "promotion_sheet_status" ADD VALUE 'cancelled';

DROP TRIGGER "promotion_sheets_status_transition" ON "promotion_sheets";
CREATE TRIGGER "promotion_sheets_status_transition" BEFORE UPDATE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:applied', 'open:cancelled');
