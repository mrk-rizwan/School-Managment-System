-- Wave O review fixes (contracts/slice-31.md §2.4, §2.5, §4, §6; the slice-31 review, 2026-10-08).
--
-- 1. A moved student's old-section marks are locked by the sheet that uses them. Submission
--    records on the sheet what it locked: `locked_test_ids`, every live test of the class-term
--    the sheet holds (the section's own tests, and any other section's test carrying a live mark
--    of a roster student), and `locked_student_ids`, the roster. A test keeps `locked_at` while any
--    sheet that is submitted, approved or published lists it; a return clears only the tests no
--    other such sheet lists. A mark of a listed student on any assessment of the class-term is
--    locked while the sheet is submitted or later, whatever the assessment's section (an exam of
--    the old section included), and such an assessment cannot be voided.
-- 2. The submission record (submitter, time, cover assignment, the lock sets) is written only by
--    the draft | returned -> submitted transition.

ALTER TABLE "result_sheets"
  ADD COLUMN "locked_test_ids" BIGINT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "locked_student_ids" BIGINT[] NOT NULL DEFAULT '{}';

-- The per-student half of the lock predicate (R265, §0.25).
CREATE FUNCTION asms_mark_student_locked(p_school_id bigint, p_class_id bigint, p_term_id bigint, p_student_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = p_school_id AND s.class_id = p_class_id AND s.term_id = p_term_id
      AND s.status IN ('submitted', 'approved', 'published')
      AND p_student_id = ANY (s.locked_student_ids)
  );
$$;

-- Replaces wave O's function with the per-student branch.
CREATE OR REPLACE FUNCTION asms_mark_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_voided_at timestamptz;
  v_locked_at timestamptz;
  v_class_id bigint;
  v_section_id bigint;
  v_term_id bigint;
BEGIN
  SELECT a.voided_at, a.locked_at, a.class_id, a.section_id, a.term_id
    INTO v_voided_at, v_locked_at, v_class_id, v_section_id, v_term_id
    FROM assessments a
   WHERE a.school_id = NEW.school_id AND a.id = NEW.assessment_id;
  IF NEW.status NOT IN ('live', 'pending') THEN
    v_refusal := 'marks_born_live_or_pending';
  ELSIF v_voided_at IS NOT NULL THEN
    v_refusal := 'marks_assessment_voided';
  ELSIF NEW.status = 'live' AND NOT NEW.excused AND v_locked_at IS NOT NULL THEN
    v_refusal := 'marks_assessment_locked';
  ELSIF NEW.status = 'live' AND NOT NEW.excused
        AND asms_assessment_sheet_locked(NEW.school_id, v_section_id, v_term_id) THEN
    v_refusal := 'marks_assessment_locked';
  ELSIF NEW.status = 'live' AND NOT NEW.excused
        AND asms_mark_student_locked(NEW.school_id, v_class_id, v_term_id, NEW.student_id) THEN
    v_refusal := 'marks_assessment_locked';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the mark is refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- Replaces wave O's function: no void either of an assessment carrying a live mark of a student
-- a submitted (or later) sheet of the class-term has locked.
CREATE OR REPLACE FUNCTION asms_assessment_sheet_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF asms_assessment_sheet_locked(NEW.school_id, NEW.section_id, NEW.term_id) THEN
      v_refusal := 'assessments_sheet_not_draft';
    END IF;
  ELSIF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
        AND (asms_assessment_sheet_locked(NEW.school_id, NEW.section_id, NEW.term_id)
             OR EXISTS (
               SELECT 1 FROM marks m
               WHERE m.school_id = NEW.school_id AND m.assessment_id = NEW.id AND m.status = 'live'
                 AND asms_mark_student_locked(NEW.school_id, NEW.class_id, NEW.term_id, m.student_id))) THEN
    v_refusal := 'assessments_void_locked';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the section''s result sheet has been submitted (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- The submission record changes only on the draft | returned -> submitted edge.
CREATE FUNCTION asms_result_sheet_submission_frozen() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.submitted_by, NEW.submitted_at, NEW.submitted_under_assignment_id,
      NEW.locked_test_ids, NEW.locked_student_ids)
     IS DISTINCT FROM
     (OLD.submitted_by, OLD.submitted_at, OLD.submitted_under_assignment_id,
      OLD.locked_test_ids, OLD.locked_student_ids)
     AND NOT (OLD.status IN ('draft', 'returned') AND NEW.status = 'submitted') THEN
    RAISE EXCEPTION 'the submission is written only by a submission'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'result_sheets_submission_frozen',
            DETAIL = 'constraint: result_sheets_submission_frozen',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_sheets_submission_frozen" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_submission_frozen();
