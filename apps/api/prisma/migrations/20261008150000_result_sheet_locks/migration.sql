-- The slice-31 review fix, second step (contracts/slice-31.md §2.4): what a submission locked moves
-- from the two id arrays on result_sheets (20261008140000) into a tenant table with composite
-- foreign keys, because an *_ids column without a foreign key is refused by the schema guard
-- (Phase 2 plan §5). One row per test the sheet holds and one per roster student; a return
-- releases its rows (released_at, set once), never deletes them.
--
-- The lock predicate for a mark of student X on an assessment of class C, term T: an unreleased
-- row of a sheet of C and T names X. A test keeps locked_at while any unreleased row names it.


-- AlterTable
ALTER TABLE "result_sheets" DROP COLUMN "locked_student_ids",
DROP COLUMN "locked_test_ids";

-- CreateTable
CREATE TABLE "result_sheet_locks" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "sheet_id" BIGINT NOT NULL,
    "assessment_id" BIGINT,
    "student_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "result_sheet_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "result_sheet_locks_school_id_sheet_id_idx" ON "result_sheet_locks"("school_id", "sheet_id");

-- CreateIndex
CREATE INDEX "result_sheet_locks_school_id_assessment_id_idx" ON "result_sheet_locks"("school_id", "assessment_id", "released_at");

-- CreateIndex
CREATE INDEX "result_sheet_locks_school_id_student_id_idx" ON "result_sheet_locks"("school_id", "student_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheet_locks_school_id_id_key" ON "result_sheet_locks"("school_id", "id");

-- AddForeignKey
ALTER TABLE "result_sheet_locks" ADD CONSTRAINT "result_sheet_locks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_locks" ADD CONSTRAINT "result_sheet_locks_sheet_id_fkey" FOREIGN KEY ("school_id", "sheet_id") REFERENCES "result_sheets"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_locks" ADD CONSTRAINT "result_sheet_locks_assessment_id_fkey" FOREIGN KEY ("school_id", "assessment_id") REFERENCES "assessments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_locks" ADD CONSTRAINT "result_sheet_locks_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---- hand-written ------------------------------------------------------------------------------

ALTER TABLE "result_sheet_locks" ADD CONSTRAINT "result_sheet_locks_target_check"
  CHECK (("assessment_id" IS NULL) <> ("student_id" IS NULL));

-- One unreleased row per sheet and test, and per sheet and student.
CREATE UNIQUE INDEX "result_sheet_locks_open_test_key" ON "result_sheet_locks" ("school_id", "sheet_id", "assessment_id")
  WHERE "released_at" IS NULL AND "assessment_id" IS NOT NULL;
CREATE UNIQUE INDEX "result_sheet_locks_open_student_key" ON "result_sheet_locks" ("school_id", "sheet_id", "student_id")
  WHERE "released_at" IS NULL AND "student_id" IS NOT NULL;

-- Rows are written only onto a submitted term sheet (the submitting transaction), a test of its
-- class and term; released only once the sheet is returned.
CREATE FUNCTION asms_result_sheet_lock_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_status result_sheet_status;
  v_class_id bigint;
  v_term_id bigint;
BEGIN
  SELECT s.status, s.class_id, s.term_id INTO v_status, v_class_id, v_term_id
    FROM result_sheets s
   WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'submitted' OR v_term_id IS NULL OR NEW.released_at IS NOT NULL THEN
      v_refusal := 'result_sheet_locks_sheet_submitted';
    ELSIF NEW.assessment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM assessments a
       WHERE a.school_id = NEW.school_id AND a.id = NEW.assessment_id AND a.kind = 'test'
         AND a.class_id = v_class_id AND a.term_id = v_term_id) THEN
      v_refusal := 'result_sheet_locks_test_of_class_term';
    END IF;
  ELSIF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND v_status IS DISTINCT FROM 'returned' THEN
    v_refusal := 'result_sheet_locks_release_returned';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the lock row is refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_sheet_locks_guard" BEFORE INSERT OR UPDATE ON "result_sheet_locks"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_lock_guard();

CREATE TRIGGER "result_sheet_locks_columns_immutable" BEFORE UPDATE ON "result_sheet_locks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('sheet_id', 'assessment_id', 'student_id', 'created_at');

CREATE TRIGGER "result_sheet_locks_released_frozen" BEFORE UPDATE ON "result_sheet_locks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('released_at');

CREATE TRIGGER "result_sheet_locks_no_delete" BEFORE DELETE ON "result_sheet_locks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheet_locks_no_truncate" BEFORE TRUNCATE ON "result_sheet_locks"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheet_locks_school_id_immutable" BEFORE UPDATE ON "result_sheet_locks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- The per-student half of the lock predicate (R265, §0.25), now read from the lock rows.
CREATE OR REPLACE FUNCTION asms_mark_student_locked(p_school_id bigint, p_class_id bigint, p_term_id bigint, p_student_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM result_sheet_locks l
      JOIN result_sheets s ON s.school_id = l.school_id AND s.id = l.sheet_id
    WHERE l.school_id = p_school_id AND l.student_id = p_student_id AND l.released_at IS NULL
      AND s.class_id = p_class_id AND s.term_id = p_term_id
  );
$$;

-- The submission record (submitter, time, cover assignment) changes only on the
-- draft | returned -> submitted edge (replaces 20261008140000's, which also named the arrays).
CREATE OR REPLACE FUNCTION asms_result_sheet_submission_frozen() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.submitted_by, NEW.submitted_at, NEW.submitted_under_assignment_id)
     IS DISTINCT FROM (OLD.submitted_by, OLD.submitted_at, OLD.submitted_under_assignment_id)
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
