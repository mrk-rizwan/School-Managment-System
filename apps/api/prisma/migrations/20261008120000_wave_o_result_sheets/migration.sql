-- Phase 4 wave O (phase-4-academic.md §3.2, §4 "Slice 31"): the result_sheet_status and
-- result_subject_status enums, the result_sheets, result_sheet_remarks, results and
-- result_subjects tables, and the wave-O deferrals of waves M and N (the result-settings and term
-- locks, the class-subject freeze and in-use rule for published results, the exam half of the
-- assessment lock, RESULT_SHEET_NOT_DRAFT). Generated DDL first (prisma migrate diff against the
-- migrated database), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "result_sheet_status" AS ENUM ('draft', 'submitted', 'returned', 'approved', 'published');

-- CreateEnum
CREATE TYPE "result_subject_status" AS ENUM ('assessed', 'not_assessed');

-- CreateTable
CREATE TABLE "result_sheets" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "term_id" BIGINT,
    "class_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "version" SMALLINT NOT NULL DEFAULT 1,
    "status" "result_sheet_status" NOT NULL DEFAULT 'draft',
    "created_by" BIGINT NOT NULL,
    "submitted_by" BIGINT,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_under_assignment_id" BIGINT,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "return_reason" VARCHAR(500),
    "published_by" BIGINT,
    "published_at" TIMESTAMPTZ(3),
    "supersedes_id" BIGINT,
    "test_weight" SMALLINT,
    "exam_weight" SMALLINT,
    "pass_percent" SMALLINT,
    "pass_rule" "pass_rule",
    "bands" JSONB,
    "term_weights" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_sheet_remarks" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "sheet_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "remark" VARCHAR(300),
    "written_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_sheet_remarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "sheet_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "term_id" BIGINT,
    "total_obtained" INTEGER NOT NULL,
    "total_max" INTEGER NOT NULL,
    "percent_bp" INTEGER,
    "grade" VARCHAR(4),
    "passed" BOOLEAN,
    "failed_subjects" SMALLINT NOT NULL DEFAULT 0,
    "position" SMALLINT,
    "position_of" SMALLINT,
    "attendance_bp" INTEGER,
    "remark" VARCHAR(300),
    "own_child_flags" JSONB NOT NULL DEFAULT '[]',
    "revised" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "superseded_by" BIGINT,
    "supersedes_id" BIGINT,
    "notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_subjects" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "result_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "class_subject_id" BIGINT NOT NULL,
    "subject_name" VARCHAR(100) NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "test_bp" INTEGER,
    "exam_bp" INTEGER,
    "exam_obtained" SMALLINT,
    "exam_max" SMALLINT,
    "exam_absent" BOOLEAN NOT NULL DEFAULT false,
    "exam_excused" BOOLEAN NOT NULL DEFAULT false,
    "percent_bp" INTEGER,
    "obtained" SMALLINT,
    "max" SMALLINT NOT NULL,
    "grade" VARCHAR(4),
    "status" "result_subject_status" NOT NULL,
    "own_child_of" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "result_sheets_school_id_status_submitted_at_idx" ON "result_sheets"("school_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_academic_year_id_section_id_idx" ON "result_sheets"("school_id", "academic_year_id", "section_id");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_term_id_idx" ON "result_sheets"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_class_id_idx" ON "result_sheets"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_section_id_class_id_idx" ON "result_sheets"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_created_by_idx" ON "result_sheets"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_submitted_by_idx" ON "result_sheets"("school_id", "submitted_by");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_decided_by_idx" ON "result_sheets"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_published_by_idx" ON "result_sheets"("school_id", "published_by");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_submitted_under_idx" ON "result_sheets"("school_id", "submitted_under_assignment_id", "section_id");

-- CreateIndex
CREATE INDEX "result_sheets_school_id_supersedes_id_idx" ON "result_sheets"("school_id", "supersedes_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_school_id_id_key" ON "result_sheets"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_school_id_id_term_id_key" ON "result_sheets"("school_id", "id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_school_id_id_section_id_key" ON "result_sheets"("school_id", "id", "section_id");

-- CreateIndex
CREATE INDEX "result_sheet_remarks_school_id_enrolment_id_idx" ON "result_sheet_remarks"("school_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "result_sheet_remarks_school_id_written_by_idx" ON "result_sheet_remarks"("school_id", "written_by");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheet_remarks_school_id_id_key" ON "result_sheet_remarks"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheet_remarks_school_id_sheet_id_enrolment_id_key" ON "result_sheet_remarks"("school_id", "sheet_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "results_school_id_sheet_id_idx" ON "results"("school_id", "sheet_id");

-- CreateIndex
CREATE INDEX "results_school_id_sheet_id_term_id_idx" ON "results"("school_id", "sheet_id", "term_id");

-- CreateIndex
CREATE INDEX "results_school_id_student_id_published_at_idx" ON "results"("school_id", "student_id", "published_at");

-- CreateIndex
CREATE INDEX "results_school_id_enrolment_id_published_at_idx" ON "results"("school_id", "enrolment_id", "published_at");

-- CreateIndex
CREATE INDEX "results_school_id_enrolment_id_idx" ON "results"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "results_school_id_term_id_academic_year_id_idx" ON "results"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "results_school_id_supersedes_id_idx" ON "results"("school_id", "supersedes_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "results_school_id_superseded_by_idx" ON "results"("school_id", "superseded_by", "enrolment_id");

-- CreateIndex
CREATE UNIQUE INDEX "results_school_id_id_key" ON "results"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "results_school_id_id_enrolment_id_key" ON "results"("school_id", "id", "enrolment_id");

-- CreateIndex
CREATE INDEX "result_subjects_school_id_class_subject_id_result_id_idx" ON "result_subjects"("school_id", "class_subject_id", "result_id");

-- CreateIndex
CREATE INDEX "result_subjects_school_id_class_subject_id_class_id_idx" ON "result_subjects"("school_id", "class_subject_id", "class_id");

-- CreateIndex
CREATE INDEX "result_subjects_school_id_own_child_of_idx" ON "result_subjects"("school_id", "own_child_of");

-- CreateIndex
CREATE UNIQUE INDEX "result_subjects_school_id_id_key" ON "result_subjects"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "result_subjects_school_id_result_id_class_subject_id_key" ON "result_subjects"("school_id", "result_id", "class_subject_id");

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_submitted_by_fkey" FOREIGN KEY ("school_id", "submitted_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_published_by_fkey" FOREIGN KEY ("school_id", "published_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_submitted_under_assignment_id_fkey" FOREIGN KEY ("school_id", "submitted_under_assignment_id", "section_id") REFERENCES "teacher_assignments"("school_id", "id", "section_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_supersedes_id_fkey" FOREIGN KEY ("school_id", "supersedes_id", "section_id") REFERENCES "result_sheets"("school_id", "id", "section_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_sheet_id_fkey" FOREIGN KEY ("school_id", "sheet_id") REFERENCES "result_sheets"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id") REFERENCES "enrolments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_written_by_fkey" FOREIGN KEY ("school_id", "written_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_sheet_id_fkey" FOREIGN KEY ("school_id", "sheet_id") REFERENCES "result_sheets"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_sheet_term_fkey" FOREIGN KEY ("school_id", "sheet_id", "term_id") REFERENCES "result_sheets"("school_id", "id", "term_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_supersedes_id_fkey" FOREIGN KEY ("school_id", "supersedes_id", "enrolment_id") REFERENCES "results"("school_id", "id", "enrolment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_superseded_by_fkey" FOREIGN KEY ("school_id", "superseded_by", "enrolment_id") REFERENCES "results"("school_id", "id", "enrolment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_result_id_fkey" FOREIGN KEY ("school_id", "result_id") REFERENCES "results"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_class_subject_id_fkey" FOREIGN KEY ("school_id", "class_subject_id", "class_id") REFERENCES "class_subjects"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_own_child_of_fkey" FOREIGN KEY ("school_id", "own_child_of") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line (phase-4-academic.md §3.2, §4 "Slice 31"). Generated SQL above
-- reviewed: no drift lines. Every object here is listed in test/guardrails/schema-checks.ts
-- (WAVE_O_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
-- Also the wave-O deferrals of waves M and N: result_settings_locked, TERM_IN_USE for a submitted
-- sheet, CLASS_SUBJECT_IN_USE for published results, CLASS_SUBJECTS_FROZEN, the exam half of
-- "locked", the void refusal after submission and RESULT_SHEET_NOT_DRAFT on a new assessment.
-- =============================================================================================

-- ---- result_sheets (R267-R272, R275) ------------------------------------------------------------

-- Version 1 is the first; a later version names the one it supersedes.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_version_check"
  CHECK ("version" >= 1 AND ("version" = 1) = ("supersedes_id" IS NULL));

-- A decision (approve or return) is recorded exactly while the sheet is decided.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_decided_check"
  CHECK (
    ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" IN ('approved', 'published', 'returned')) = ("decided_at" IS NOT NULL)
  );

-- Only an approval is self-approved (the sole-principal exception, §1.1).
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_self_approved_check"
  CHECK (NOT "self_approved" OR "status" IN ('approved', 'published'));

-- A returned sheet carries its reason; a resubmission clears it.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_return_reason_check"
  CHECK (
    ("status" = 'returned') = ("return_reason" IS NOT NULL)
    AND ("return_reason" IS NULL OR ("return_reason" = btrim("return_reason") AND "return_reason" <> ''))
  );

ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_return_reason_no_id_check"
  CHECK ("return_reason" !~ '[0-9]{13}' AND "return_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_published_check"
  CHECK (
    ("published_at" IS NULL) = ("published_by" IS NULL)
    AND ("status" = 'published') = ("published_at" IS NOT NULL)
  );

-- A term sheet is submitted by someone; the final sheet never is (it has no submitter, R275).
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_submitted_check"
  CHECK (
    ("submitted_at" IS NULL) = ("submitted_by" IS NULL)
    AND ("term_id" IS NOT NULL OR "submitted_by" IS NULL)
    AND ("status" <> 'submitted' OR "term_id" IS NULL OR "submitted_by" IS NOT NULL)
    AND ("submitted_under_assignment_id" IS NULL OR "submitted_by" IS NOT NULL)
  );

-- The settings snapshot: whole once approved; term weights only on the final sheet.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_snapshot_check"
  CHECK (
    ("test_weight" IS NULL) = ("exam_weight" IS NULL)
    AND ("test_weight" IS NULL OR ("test_weight" BETWEEN 0 AND 100 AND "test_weight" + "exam_weight" = 100))
    AND ("pass_percent" IS NULL OR "pass_percent" BETWEEN 0 AND 100)
    AND ("bands" IS NULL OR jsonb_typeof("bands") = 'array')
    AND ("term_weights" IS NULL OR (jsonb_typeof("term_weights") = 'array' AND "term_id" IS NULL))
    AND ("status" NOT IN ('approved', 'published')
         OR ("pass_percent" IS NOT NULL AND "pass_rule" IS NOT NULL AND "bands" IS NOT NULL
             AND ("term_id" IS NULL OR "test_weight" IS NOT NULL)
             AND ("term_id" IS NOT NULL OR "term_weights" IS NOT NULL)))
  );

-- R267: one open (not published) version per section and term; versions unique.
CREATE UNIQUE INDEX "result_sheets_open_key" ON "result_sheets" ("school_id", "section_id", COALESCE("term_id", 0))
  WHERE "status" <> 'published';

CREATE UNIQUE INDEX "result_sheets_version_key" ON "result_sheets" ("school_id", "section_id", COALESCE("term_id", 0), "version");

-- A sheet is born draft; a correction's version (slice 32) is born published.
CREATE FUNCTION asms_result_sheet_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.supersedes_id IS NULL AND NEW.status <> 'draft')
     OR (NEW.supersedes_id IS NOT NULL AND NEW.status <> 'published') THEN
    RAISE EXCEPTION 'a result sheet is born draft, a corrected version published'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'result_sheets_born_draft',
            DETAIL = 'constraint: result_sheets_born_draft',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_sheets_insert_guard" BEFORE INSERT ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_insert_guard();

-- §3.2: BEFORE UPDATE only (an inserted correction version is not a transition).
CREATE TRIGGER "result_sheets_status_transition" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'draft:submitted', 'submitted:approved', 'submitted:returned', 'returned:submitted',
    'approved:returned', 'approved:published');

-- R271, §0.28: whoever decides a term sheet (approve or return) is not its submitter, except the
-- sole active principal, whose approval is recorded self_approved. self_approved on anyone
-- else's sheet is refused. The final sheet has no submitter and is exempt.
CREATE FUNCTION asms_result_sheet_not_self() RETURNS trigger
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

CREATE TRIGGER "result_sheets_not_self" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_not_self();

CREATE TRIGGER "result_sheets_columns_immutable" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'term_id', 'class_id', 'section_id', 'version', 'supersedes_id', 'created_by',
    'created_at');

-- R256: the snapshot is frozen while the sheet is approved or published.
CREATE TRIGGER "result_sheets_snapshot_frozen" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'draft,submitted,returned', 'test_weight', 'exam_weight', 'pass_percent', 'pass_rule', 'bands',
    'term_weights');

CREATE TRIGGER "result_sheets_published_frozen" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('published_at', 'published_by');

CREATE TRIGGER "result_sheets_no_delete" BEFORE DELETE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheets_no_truncate" BEFORE TRUNCATE ON "result_sheets"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheets_school_id_immutable" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- result_sheet_remarks (§1.1 "Term remark") --------------------------------------------------

-- A cleared remark is null (the row stays: rule 4).
ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_remark_check"
  CHECK ("remark" IS NULL OR ("remark" = btrim("remark") AND "remark" <> ''));

ALTER TABLE "result_sheet_remarks" ADD CONSTRAINT "result_sheet_remarks_remark_no_id_check"
  CHECK ("remark" !~ '[0-9]{13}' AND "remark" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Written only while the sheet is draft or returned.
CREATE FUNCTION asms_result_sheet_remark_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id AND s.status IN ('draft', 'returned')
  ) THEN
    RAISE EXCEPTION 'a remark is written only while its sheet is draft or returned'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'result_sheet_remarks_open',
            DETAIL = 'constraint: result_sheet_remarks_open',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_sheet_remarks_open" BEFORE INSERT OR UPDATE ON "result_sheet_remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_result_sheet_remark_open();

CREATE TRIGGER "result_sheet_remarks_columns_immutable" BEFORE UPDATE ON "result_sheet_remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('sheet_id', 'enrolment_id', 'created_at');

CREATE TRIGGER "result_sheet_remarks_no_delete" BEFORE DELETE ON "result_sheet_remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheet_remarks_no_truncate" BEFORE TRUNCATE ON "result_sheet_remarks"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_sheet_remarks_school_id_immutable" BEFORE UPDATE ON "result_sheet_remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- results (R269, R270, R274) -----------------------------------------------------------------

ALTER TABLE "results" ADD CONSTRAINT "results_percent_check"
  CHECK (
    ("percent_bp" IS NULL OR "percent_bp" BETWEEN 0 AND 10000)
    AND ("attendance_bp" IS NULL OR "attendance_bp" BETWEEN 0 AND 10000)
  );

-- Nothing assessed: no percentage, grade, verdict or position (R259, R260).
ALTER TABLE "results" ADD CONSTRAINT "results_assessed_check"
  CHECK (
    ("percent_bp" IS NULL) = ("passed" IS NULL)
    AND ("percent_bp" IS NULL) = ("grade" IS NULL)
    AND ("percent_bp" IS NULL) = ("total_max" = 0)
    AND ("percent_bp" IS NOT NULL OR "position" IS NULL)
  );

ALTER TABLE "results" ADD CONSTRAINT "results_totals_check"
  CHECK ("total_obtained" >= 0 AND "total_obtained" <= "total_max" AND "failed_subjects" >= 0);

ALTER TABLE "results" ADD CONSTRAINT "results_position_check"
  CHECK (
    ("position" IS NULL) = ("position_of" IS NULL)
    AND ("position" IS NULL OR ("position" >= 1 AND "position" <= "position_of"))
  );

ALTER TABLE "results" ADD CONSTRAINT "results_superseded_check"
  CHECK (("superseded_by" IS NULL OR "superseded_at" IS NOT NULL) AND (NOT "revised" OR "supersedes_id" IS NOT NULL));

ALTER TABLE "results" ADD CONSTRAINT "results_notified_check"
  CHECK ("notified_at" IS NULL OR "published_at" IS NOT NULL);

ALTER TABLE "results" ADD CONSTRAINT "results_remark_check"
  CHECK ("remark" IS NULL OR ("remark" = btrim("remark") AND "remark" <> ''));

ALTER TABLE "results" ADD CONSTRAINT "results_remark_no_id_check"
  CHECK ("remark" !~ '[0-9]{13}' AND "remark" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "results" ADD CONSTRAINT "results_own_child_flags_check"
  CHECK (jsonb_typeof("own_child_flags") = 'array');

-- One live result per enrolment and term (the final's term is null), and one live row per
-- enrolment on a sheet version (a version returned from approved supersedes its rows; its
-- re-approval writes a new set).
CREATE UNIQUE INDEX "results_live_key" ON "results" ("school_id", "enrolment_id", COALESCE("term_id", 0))
  WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "results_sheet_enrolment_key" ON "results" ("school_id", "sheet_id", "enrolment_id")
  WHERE "superseded_at" IS NULL;

CREATE INDEX "results_term_live_idx" ON "results" ("school_id", "term_id") WHERE "superseded_at" IS NULL;

-- A result is written only onto an approved or published sheet, for the sheet's year and term,
-- and hangs off an enrolment of the sheet's section (§0.25: the one in force on the last day).
CREATE FUNCTION asms_result_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM result_sheets s
    JOIN enrolments e ON e.school_id = s.school_id AND e.id = NEW.enrolment_id AND e.section_id = s.section_id
    WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id
      AND s.status IN ('approved', 'published')
      AND s.academic_year_id = NEW.academic_year_id
      AND s.term_id IS NOT DISTINCT FROM NEW.term_id
  ) THEN
    RAISE EXCEPTION 'a result is written only onto its approved sheet, for an enrolment of its section'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'results_sheet_approved',
            DETAIL = 'constraint: results_sheet_approved',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "results_insert_guard" BEFORE INSERT ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_result_insert_guard();

-- Frozen after insert except published_at, superseded_at, superseded_by and notified_at.
CREATE TRIGGER "results_columns_immutable" BEFORE UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'sheet_id', 'enrolment_id', 'student_id', 'academic_year_id', 'term_id', 'total_obtained',
    'total_max', 'percent_bp', 'grade', 'passed', 'failed_subjects', 'position', 'position_of',
    'attendance_bp', 'remark', 'own_child_flags', 'revised', 'supersedes_id', 'created_at');

CREATE TRIGGER "results_published_frozen" BEFORE UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('published_at');

CREATE TRIGGER "results_superseded_frozen" BEFORE UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at', 'superseded_by');

CREATE TRIGGER "results_notified_frozen" BEFORE UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('notified_at');

CREATE TRIGGER "results_no_delete" BEFORE DELETE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "results_no_truncate" BEFORE TRUNCATE ON "results"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "results_school_id_immutable" BEFORE UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- result_subjects ----------------------------------------------------------------------------

ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_bp_check"
  CHECK (
    ("test_bp" IS NULL OR "test_bp" BETWEEN 0 AND 10000)
    AND ("exam_bp" IS NULL OR "exam_bp" BETWEEN 0 AND 10000)
    AND ("percent_bp" IS NULL OR "percent_bp" BETWEEN 0 AND 10000)
  );

-- not_assessed iff no percentage, printed "—": no mark and no grade either.
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_status_check"
  CHECK (
    ("status" = 'not_assessed') = ("percent_bp" IS NULL)
    AND ("percent_bp" IS NULL) = ("obtained" IS NULL)
    AND ("percent_bp" IS NULL) = ("grade" IS NULL)
  );

ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_marks_check"
  CHECK ("max" >= 1 AND ("obtained" IS NULL OR "obtained" BETWEEN 0 AND "max") AND "sort_order" >= 0);

-- The exam as the student met it: an absence has no mark, an excusal is an absence, and no exam
-- (none set up, or a final result) is none of these.
ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_exam_check"
  CHECK (
    NOT ("exam_absent" AND "exam_obtained" IS NOT NULL)
    AND (NOT "exam_excused" OR "exam_absent")
    AND ("exam_max" IS NOT NULL OR ("exam_obtained" IS NULL AND NOT "exam_absent"))
    AND ("exam_max" IS NULL OR "exam_max" >= 1)
    AND ("exam_obtained" IS NULL OR "exam_obtained" BETWEEN 0 AND "exam_max")
    AND ("exam_max" IS NULL OR "exam_obtained" IS NOT NULL OR "exam_absent")
  );

ALTER TABLE "result_subjects" ADD CONSTRAINT "result_subjects_subject_name_check"
  CHECK ("subject_name" = btrim("subject_name") AND "subject_name" <> '');

CREATE TRIGGER "result_subjects_columns_immutable" BEFORE UPDATE ON "result_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'result_id', 'class_id', 'class_subject_id', 'subject_name', 'sort_order', 'test_bp', 'exam_bp',
    'exam_obtained', 'exam_max', 'exam_absent', 'exam_excused', 'percent_bp', 'obtained', 'max', 'grade',
    'status', 'own_child_of', 'created_at');

CREATE TRIGGER "result_subjects_no_delete" BEFORE DELETE ON "result_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_subjects_no_truncate" BEFORE TRUNCATE ON "result_subjects"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_subjects_school_id_immutable" BEFORE UPDATE ON "result_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- the wave-O deferrals of waves M and N -----------------------------------------------------

-- R256: a year's composition settings (weights, pass mark and rule, bands) are frozen once any
-- sheet of the year is approved or published. The display, withholding and notification toggles
-- stay editable (they are read at print and send time, never stored on a result).
CREATE FUNCTION asms_result_settings_locked() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.test_weight, NEW.exam_weight, NEW.pass_percent, NEW.pass_rule, NEW.bands)
       IS DISTINCT FROM (OLD.test_weight, OLD.exam_weight, OLD.pass_percent, OLD.pass_rule, OLD.bands)
     AND EXISTS (
       SELECT 1 FROM result_sheets s
       WHERE s.school_id = NEW.school_id AND s.academic_year_id = NEW.academic_year_id
         AND s.status IN ('approved', 'published')
     ) THEN
    RAISE EXCEPTION 'a sheet of the year is approved; its result settings are frozen'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'result_settings_locked',
            DETAIL = 'constraint: result_settings_locked',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_settings_locked" BEFORE UPDATE ON "result_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_result_settings_locked();

-- TERM_IN_USE (R254): a term's dates and weight are also fixed once a sheet of the term has been
-- submitted (any status but draft); R256: and once any sheet of its year is approved or published
-- (academic_terms_results_locked, RESULT_SETTINGS_LOCKED). Replaces wave N's function.
CREATE OR REPLACE FUNCTION asms_academic_term_in_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF (NEW.starts_on, NEW.ends_on, NEW.weight) IS NOT DISTINCT FROM (OLD.starts_on, OLD.ends_on, OLD.weight) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
       SELECT 1 FROM result_sheets s
       WHERE s.school_id = NEW.school_id AND s.academic_year_id = NEW.academic_year_id
         AND s.status IN ('approved', 'published')
     ) THEN
    v_refusal := 'academic_terms_results_locked';
  ELSIF EXISTS (
       SELECT 1 FROM assessments a
       WHERE a.school_id = NEW.school_id AND a.term_id = NEW.id AND a.voided_at IS NULL
     ) OR EXISTS (
       SELECT 1 FROM result_sheets s
       WHERE s.school_id = NEW.school_id AND s.term_id = NEW.id AND s.status <> 'draft'
     ) THEN
    v_refusal := 'academic_terms_in_use';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the term''s dates and weight are fixed (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- A new term in a year whose results are frozen would change the final's weights (R256).
CREATE FUNCTION asms_academic_term_results_locked() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = NEW.school_id AND s.academic_year_id = NEW.academic_year_id
      AND s.status IN ('approved', 'published')
  ) THEN
    RAISE EXCEPTION 'a sheet of the year is approved; its terms are frozen'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'academic_terms_results_locked',
            DETAIL = 'constraint: academic_terms_results_locked',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "academic_terms_results_locked" BEFORE INSERT ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_academic_term_results_locked();

-- CLASS_SUBJECT_IN_USE: also a class-subject on a published result. Replaces wave N's function.
CREATE OR REPLACE FUNCTION asms_class_subject_in_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND (EXISTS (
       SELECT 1 FROM assessments a
       JOIN marks m ON m.school_id = a.school_id AND m.assessment_id = a.id AND m.status = 'live'
       WHERE a.school_id = NEW.school_id AND a.class_subject_id = NEW.id AND a.voided_at IS NULL
     ) OR EXISTS (
       SELECT 1 FROM result_subjects rs
       JOIN results r ON r.school_id = rs.school_id AND r.id = rs.result_id AND r.published_at IS NOT NULL
       WHERE rs.school_id = NEW.school_id AND rs.class_subject_id = NEW.id
     )) THEN
    RAISE EXCEPTION 'the class subject has marks or published results and cannot be archived'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'class_subjects_in_use',
            DETAIL = 'constraint: class_subjects_in_use',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- CLASS_SUBJECTS_FROZEN (R257): a class's subject list does not change while a sheet of the class
-- is submitted or approved (under review: the preview the approver reads must hold).
CREATE FUNCTION asms_class_subjects_frozen() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.sort_order, NEW.exam_max_marks, NEW.archived_at) IS NOT DISTINCT FROM (OLD.sort_order, OLD.exam_max_marks, OLD.archived_at) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = NEW.school_id AND s.class_id = NEW.class_id AND s.status IN ('submitted', 'approved')
  ) THEN
    RAISE EXCEPTION 'a result sheet of the class is under review; its subject list is frozen'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'class_subjects_frozen',
            DETAIL = 'constraint: class_subjects_frozen',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "class_subjects_frozen" BEFORE INSERT OR UPDATE ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_class_subjects_frozen();

-- The lock predicate (§3.2, R265), one definition: an assessment is locked when its section-term
-- sheet has been submitted and not returned (submitted, approved or published, any version).
CREATE FUNCTION asms_assessment_sheet_locked(p_school_id bigint, p_section_id bigint, p_term_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM result_sheets s
    WHERE s.school_id = p_school_id AND s.section_id = p_section_id AND s.term_id = p_term_id
      AND s.status IN ('submitted', 'approved', 'published')
  );
$$;

-- A mark is born live (an entry, an excusal) or pending (a correction); never on a voided
-- assessment; and a locked assessment (a test with locked_at, or any assessment whose
-- section-term sheet is submitted or later) takes no live mark except an excusal. Replaces wave
-- N's function with the exam half.
CREATE OR REPLACE FUNCTION asms_mark_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_voided_at timestamptz;
  v_locked_at timestamptz;
  v_section_id bigint;
  v_term_id bigint;
BEGIN
  SELECT a.voided_at, a.locked_at, a.section_id, a.term_id
    INTO v_voided_at, v_locked_at, v_section_id, v_term_id
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

-- RESULT_SHEET_NOT_DRAFT (§5 slice 30): no new assessment for a section-term whose sheet is
-- submitted or later; ASSESSMENT_LOCKED: no void either (an exam's set-up recreates a voided exam
-- only while the sheet is open).
CREATE FUNCTION asms_assessment_sheet_guard() RETURNS trigger
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
        AND asms_assessment_sheet_locked(NEW.school_id, NEW.section_id, NEW.term_id) THEN
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

CREATE TRIGGER "assessments_sheet_guard" BEFORE INSERT OR UPDATE OF "voided_at" ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_assessment_sheet_guard();

-- R269: a return unlocks the section's tests, so locked_at is set once and may be cleared, never
-- moved (replaces wave N's assessments_locked_frozen, which forbade the clearing).
DROP TRIGGER "assessments_locked_frozen" ON "assessments";

CREATE FUNCTION asms_assessment_locked_at_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT NULL AND NEW.locked_at <> OLD.locked_at THEN
    RAISE EXCEPTION 'locked_at is set once and only cleared'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assessments_locked_at_frozen',
            DETAIL = 'constraint: assessments_locked_at_frozen',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assessments_locked_at_guard" BEFORE UPDATE OF "locked_at" ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_assessment_locked_at_guard();
