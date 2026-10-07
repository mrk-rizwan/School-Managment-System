-- Phase 4 wave N (phase-4-academic.md §3.2, §4 "Slice 30" and "Slice 34"): the assessment_kind,
-- test_type, assessment_mark_status, certificate_type and dues_status enums, the assessments,
-- marks and certificates tables, and two of wave M's deferred locks that need them (TERM_IN_USE on
-- academic_terms, CLASS_SUBJECT_IN_USE on class_subjects). Generated DDL first (prisma migrate
-- diff against the migrated database), hand-written SQL after the marker.
-- CreateEnum
CREATE TYPE "assessment_kind" AS ENUM ('test', 'exam');

-- CreateEnum
CREATE TYPE "test_type" AS ENUM ('daily', 'weekly', 'monthly', 'other');

-- CreateEnum
CREATE TYPE "assessment_mark_status" AS ENUM ('live', 'pending', 'superseded', 'rejected');

-- CreateEnum
CREATE TYPE "certificate_type" AS ENUM ('leaving', 'character', 'academic', 'completion', 'other');

-- CreateEnum
CREATE TYPE "dues_status" AS ENUM ('not_required', 'cleared', 'override');

-- CreateTable
CREATE TABLE "assessments" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "term_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_subject_id" BIGINT NOT NULL,
    "kind" "assessment_kind" NOT NULL,
    "test_type" "test_type",
    "name" VARCHAR(80) NOT NULL,
    "max_marks" SMALLINT NOT NULL,
    "held_on" DATE NOT NULL,
    "created_by" BIGINT NOT NULL,
    "locked_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marks" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "assessment_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "max_marks" SMALLINT NOT NULL,
    "obtained" SMALLINT,
    "absent" BOOLEAN NOT NULL DEFAULT false,
    "excused" BOOLEAN NOT NULL DEFAULT false,
    "status" "assessment_mark_status" NOT NULL,
    "supersedes_id" BIGINT,
    "correction_reason" VARCHAR(500),
    "entered_by" BIGINT NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_entry_key" VARCHAR(64),
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "type" "certificate_type" NOT NULL,
    "number" INTEGER NOT NULL,
    "issue_no" SMALLINT NOT NULL DEFAULT 1,
    "reissue_of_id" BIGINT,
    "academic_year_id" BIGINT,
    "title" VARCHAR(80),
    "body" JSONB NOT NULL,
    "reason" VARCHAR(500),
    "dues_status" "dues_status" NOT NULL,
    "issued_by" BIGINT NOT NULL,
    "issued_on" DATE NOT NULL,
    "printed_count" INTEGER NOT NULL DEFAULT 0,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessments_school_id_section_id_term_id_kind_idx" ON "assessments"("school_id", "section_id", "term_id", "kind");

-- CreateIndex
CREATE INDEX "assessments_school_id_term_id_class_subject_id_idx" ON "assessments"("school_id", "term_id", "class_subject_id");

-- CreateIndex
CREATE INDEX "assessments_school_id_term_id_academic_year_id_idx" ON "assessments"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "assessments_school_id_class_id_academic_year_id_idx" ON "assessments"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "assessments_school_id_section_id_class_id_idx" ON "assessments"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "assessments_school_id_class_subject_id_class_id_idx" ON "assessments"("school_id", "class_subject_id", "class_id");

-- CreateIndex
CREATE INDEX "assessments_school_id_created_by_idx" ON "assessments"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "assessments_school_id_voided_by_idx" ON "assessments"("school_id", "voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_school_id_id_key" ON "assessments"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_school_id_id_academic_year_id_key" ON "assessments"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_school_id_id_max_marks_key" ON "assessments"("school_id", "id", "max_marks");

-- CreateIndex
CREATE INDEX "marks_school_id_assessment_id_academic_year_id_idx" ON "marks"("school_id", "assessment_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "marks_school_id_assessment_id_max_marks_idx" ON "marks"("school_id", "assessment_id", "max_marks");

-- CreateIndex
CREATE INDEX "marks_school_id_enrolment_id_idx" ON "marks"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "marks_school_id_student_id_academic_year_id_idx" ON "marks"("school_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "marks_school_id_supersedes_id_idx" ON "marks"("school_id", "supersedes_id", "assessment_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "marks_school_id_entered_by_idx" ON "marks"("school_id", "entered_by");

-- CreateIndex
CREATE INDEX "marks_school_id_decided_by_idx" ON "marks"("school_id", "decided_by");

-- CreateIndex
CREATE UNIQUE INDEX "marks_school_id_id_key" ON "marks"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marks_school_id_id_assessment_id_enrolment_id_key" ON "marks"("school_id", "id", "assessment_id", "enrolment_id");

-- CreateIndex
CREATE UNIQUE INDEX "marks_client_entry_key" ON "marks"("school_id", "assessment_id", "enrolment_id", "client_entry_key");

-- CreateIndex
CREATE INDEX "certificates_school_id_student_id_idx" ON "certificates"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "certificates_school_id_type_issued_on_idx" ON "certificates"("school_id", "type", "issued_on");

-- CreateIndex
CREATE INDEX "certificates_school_id_issued_on_idx" ON "certificates"("school_id", "issued_on");

-- CreateIndex
CREATE INDEX "certificates_school_id_academic_year_id_idx" ON "certificates"("school_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "certificates_school_id_reissue_of_id_idx" ON "certificates"("school_id", "reissue_of_id", "type", "number");

-- CreateIndex
CREATE INDEX "certificates_school_id_issued_by_idx" ON "certificates"("school_id", "issued_by");

-- CreateIndex
CREATE INDEX "certificates_school_id_voided_by_idx" ON "certificates"("school_id", "voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_school_id_id_key" ON "certificates"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_school_id_id_type_number_key" ON "certificates"("school_id", "id", "type", "number");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_school_id_type_number_issue_no_key" ON "certificates"("school_id", "type", "number", "issue_no");

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_class_subject_id_fkey" FOREIGN KEY ("school_id", "class_subject_id", "class_id") REFERENCES "class_subjects"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_assessment_id_fkey" FOREIGN KEY ("school_id", "assessment_id", "academic_year_id") REFERENCES "assessments"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_assessment_max_fkey" FOREIGN KEY ("school_id", "assessment_id", "max_marks") REFERENCES "assessments"("school_id", "id", "max_marks") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_supersedes_id_fkey" FOREIGN KEY ("school_id", "supersedes_id", "assessment_id", "enrolment_id") REFERENCES "marks"("school_id", "id", "assessment_id", "enrolment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_entered_by_fkey" FOREIGN KEY ("school_id", "entered_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_reissue_of_id_fkey" FOREIGN KEY ("school_id", "reissue_of_id", "type", "number") REFERENCES "certificates"("school_id", "id", "type", "number") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issued_by_fkey" FOREIGN KEY ("school_id", "issued_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-4-academic.md §3.2, §4 "Slice 30", "Slice 34"). Generated
-- SQL above reviewed: no drift lines. Every object here is listed in
-- test/guardrails/schema-checks.ts (WAVE_N_OBJECTS). Trigger functions raise SQLSTATE 23514 with
-- DETAIL 'constraint: <name>'. Deferred to wave O, which adds result_sheets: the exam half of
-- "a locked assessment takes no live mark" (an exam whose section-term sheet is submitted or
-- later), TERM_IN_USE for a submitted sheet, CLASS_SUBJECT_IN_USE for published results, the
-- class-subject freeze and result_settings_locked.
-- =============================================================================================

-- ---- assessments (R261, R264, R265) -----------------------------------------------------------

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_max_marks_check"
  CHECK ("max_marks" BETWEEN 1 AND 1000);

-- A test carries its label; an exam has none.
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_test_type_check"
  CHECK (("kind" = 'test') = ("test_type" IS NOT NULL));

-- Only a test is locked by a timestamp; an exam is locked by its section-term sheet (wave O).
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_locked_check"
  CHECK ("kind" = 'test' OR "locked_at" IS NULL);

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_voided_check"
  CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL) AND ("voided_at" IS NULL) = ("void_reason" IS NULL));

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_void_reason_check"
  CHECK ("void_reason" IS NULL OR ("void_reason" = btrim("void_reason") AND "void_reason" <> ''));

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live exam per section, class-subject and term; a voided exam frees the slot (set-up
-- recreates it).
CREATE UNIQUE INDEX "assessments_exam_key" ON "assessments" ("school_id", "section_id", "class_subject_id", "term_id")
  WHERE "kind" = 'exam' AND "voided_at" IS NULL;

-- held_on lies inside the assessment's term (R264). The reverse direction, a term's dates moving
-- past an assessment, is the academic_terms_in_use lock below.
CREATE FUNCTION asms_assessment_held_on_in_term() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM academic_terms t
    WHERE t.school_id = NEW.school_id AND t.id = NEW.term_id
      AND NEW.held_on BETWEEN t.starts_on AND t.ends_on
  ) THEN
    RAISE EXCEPTION 'an assessment is held inside its term'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assessments_held_on_in_term',
            DETAIL = 'constraint: assessments_held_on_in_term',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assessments_held_on_in_term" BEFORE INSERT OR UPDATE OF "held_on" ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_assessment_held_on_in_term();

-- name, held_on and max_marks change only while the assessment is not voided and has no mark of
-- any status (max_marks is also held by marks_assessment_max_fkey ON UPDATE RESTRICT). The
-- service locks the assessment row before writing marks or editing it.
CREATE FUNCTION asms_assessment_edit_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF (NEW.name, NEW.held_on, NEW.max_marks) IS NOT DISTINCT FROM (OLD.name, OLD.held_on, OLD.max_marks) THEN
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    v_refusal := 'assessments_voided_frozen';
  ELSIF EXISTS (SELECT 1 FROM marks m WHERE m.school_id = NEW.school_id AND m.assessment_id = NEW.id) THEN
    v_refusal := 'assessments_has_marks';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the assessment can no longer be edited (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assessments_edit_guard" BEFORE UPDATE OF "name", "held_on", "max_marks" ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_assessment_edit_guard();

CREATE TRIGGER "assessments_columns_immutable" BEFORE UPDATE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'term_id', 'class_id', 'section_id', 'class_subject_id', 'kind', 'test_type',
    'created_by', 'created_at');

CREATE TRIGGER "assessments_locked_frozen" BEFORE UPDATE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('locked_at');

CREATE TRIGGER "assessments_voided_frozen" BEFORE UPDATE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

CREATE TRIGGER "assessments_no_delete" BEFORE DELETE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "assessments_no_truncate" BEFORE TRUNCATE ON "assessments"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "assessments_school_id_immutable" BEFORE UPDATE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- marks (R261, R262, R265; §0.25) -----------------------------------------------------------

ALTER TABLE "marks" ADD CONSTRAINT "marks_obtained_check"
  CHECK ("obtained" IS NULL OR "obtained" BETWEEN 0 AND "max_marks");

-- Exactly one of a mark or an absence.
ALTER TABLE "marks" ADD CONSTRAINT "marks_absent_check"
  CHECK (("obtained" IS NULL) = "absent");

ALTER TABLE "marks" ADD CONSTRAINT "marks_excused_check"
  CHECK (NOT "excused" OR "absent");

-- A reason only on a row that supersedes another, and always on a correction (pending, and a
-- rejected one) and an excusal. A plain re-entry from the grid supersedes without a reason.
ALTER TABLE "marks" ADD CONSTRAINT "marks_correction_check"
  CHECK (
    ("correction_reason" IS NULL OR "supersedes_id" IS NOT NULL)
    AND ("status" NOT IN ('pending', 'rejected') OR "correction_reason" IS NOT NULL)
    AND (NOT "excused" OR "correction_reason" IS NOT NULL)
  );

ALTER TABLE "marks" ADD CONSTRAINT "marks_correction_reason_check"
  CHECK ("correction_reason" IS NULL OR ("correction_reason" = btrim("correction_reason") AND "correction_reason" <> ''));

ALTER TABLE "marks" ADD CONSTRAINT "marks_correction_reason_no_id_check"
  CHECK ("correction_reason" !~ '[0-9]{13}' AND "correction_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "marks" ADD CONSTRAINT "marks_superseded_check"
  CHECK (("status" = 'superseded') = ("superseded_at" IS NOT NULL));

-- A decision is recorded only on a correction: never on a pending row, always on a rejected one.
ALTER TABLE "marks" ADD CONSTRAINT "marks_decided_check"
  CHECK (
    ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" <> 'pending' OR "decided_at" IS NULL)
    AND ("status" <> 'rejected' OR "decided_at" IS NOT NULL)
    AND ("decided_at" IS NULL OR "correction_reason" IS NOT NULL)
  );

-- The phone's key (§3.8): 16-64 of [A-Za-z0-9_-], never a 13-digit run (an identity number).
ALTER TABLE "marks" ADD CONSTRAINT "marks_client_entry_key_check"
  CHECK ("client_entry_key" IS NULL OR ("client_entry_key" ~ '^[A-Za-z0-9_-]{16,64}$' AND "client_entry_key" !~ '[0-9]{13}'));

CREATE UNIQUE INDEX "marks_live_key" ON "marks" ("school_id", "assessment_id", "enrolment_id")
  WHERE "status" = 'live';

CREATE UNIQUE INDEX "marks_pending_key" ON "marks" ("school_id", "assessment_id", "enrolment_id")
  WHERE "status" = 'pending';

-- The chain is linear: a mark is superseded by at most one row that took effect.
CREATE UNIQUE INDEX "marks_supersedes_key" ON "marks" ("school_id", "supersedes_id")
  WHERE "supersedes_id" IS NOT NULL AND "status" IN ('live', 'superseded');

-- A mark is born live (an entry, an excusal) or pending (a correction); never on a voided
-- assessment; and a locked test takes no live mark except an excusal (decided by result.approve
-- while the sheet is under review). The exam half (its section-term sheet submitted or later)
-- arrives with result_sheets in wave O.
CREATE FUNCTION asms_mark_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_voided_at timestamptz;
  v_locked_at timestamptz;
BEGIN
  SELECT a.voided_at, a.locked_at INTO v_voided_at, v_locked_at FROM assessments a
  WHERE a.school_id = NEW.school_id AND a.id = NEW.assessment_id;
  IF NEW.status NOT IN ('live', 'pending') THEN
    v_refusal := 'marks_born_live_or_pending';
  ELSIF v_voided_at IS NOT NULL THEN
    v_refusal := 'marks_assessment_voided';
  ELSIF NEW.status = 'live' AND NOT NEW.excused AND v_locked_at IS NOT NULL THEN
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

CREATE TRIGGER "marks_insert_guard" BEFORE INSERT ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_mark_insert_guard();

-- Frozen after insert except status, superseded_at and decided_by/at.
CREATE TRIGGER "marks_columns_immutable" BEFORE UPDATE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'assessment_id', 'enrolment_id', 'student_id', 'academic_year_id', 'max_marks', 'obtained',
    'absent', 'excused', 'supersedes_id', 'correction_reason', 'entered_by', 'entered_at',
    'client_entry_key');

CREATE TRIGGER "marks_status_transition" BEFORE UPDATE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('pending:live', 'pending:rejected', 'live:superseded');

CREATE TRIGGER "marks_decided_frozen" BEFORE UPDATE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by');

CREATE TRIGGER "marks_superseded_frozen" BEFORE UPDATE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at');

CREATE TRIGGER "marks_no_delete" BEFORE DELETE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "marks_no_truncate" BEFORE TRUNCATE ON "marks"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "marks_school_id_immutable" BEFORE UPDATE ON "marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- certificates (R289-R293, rule 29) ---------------------------------------------------------

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_number_check"
  CHECK ("number" >= 1);

-- The original is issue 1; a reissue names the row it reissues.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issue_no_check"
  CHECK ("issue_no" >= 1 AND ("issue_no" > 1) = ("reissue_of_id" IS NOT NULL));

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_printed_count_check"
  CHECK ("printed_count" >= 0);

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_voided_check"
  CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL) AND ("voided_at" IS NULL) = ("void_reason" IS NULL));

-- Only the leaving certificate is gated on dues; an override carries its reason.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_dues_check"
  CHECK (("type" = 'leaving') = ("dues_status" <> 'not_required') AND ("dues_status" <> 'override' OR "reason" IS NOT NULL));

-- A reissue carries its reason.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_reissue_reason_check"
  CHECK ("issue_no" = 1 OR "reason" IS NOT NULL);

-- The academic year is optional only on an `other` certificate, which needs its own title.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_academic_year_check"
  CHECK ("type" = 'other' OR "academic_year_id" IS NOT NULL);

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_title_required_check"
  CHECK ("type" <> 'other' OR "title" IS NOT NULL);

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_title_check"
  CHECK ("title" IS NULL OR ("title" = btrim("title") AND "title" <> ''));

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_title_no_id_check"
  CHECK ("title" !~ '[0-9]{13}' AND "title" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_reason_check"
  CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND "reason" <> ''));

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_void_reason_check"
  CHECK ("void_reason" IS NULL OR ("void_reason" = btrim("void_reason") AND "void_reason" <> ''));

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_body_check"
  CHECK (jsonb_typeof("body") = 'object');

-- The body never holds an identity number (§7.1): the B-Form prints only from the print view.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_body_no_id_check"
  CHECK ("body"::text !~ '[0-9]{13}' AND "body"::text !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Mutable after insert: printed_count and the void trio, once.
CREATE TRIGGER "certificates_columns_immutable" BEFORE UPDATE ON "certificates"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'type', 'number', 'issue_no', 'reissue_of_id', 'academic_year_id', 'title', 'body',
    'reason', 'dues_status', 'issued_by', 'issued_on', 'created_at');

CREATE TRIGGER "certificates_voided_frozen" BEFORE UPDATE ON "certificates"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

CREATE TRIGGER "certificates_no_delete" BEFORE DELETE ON "certificates"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "certificates_no_truncate" BEFORE TRUNCATE ON "certificates"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "certificates_school_id_immutable" BEFORE UPDATE ON "certificates"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- wave M's deferred locks that need these tables (R254, R257) ------------------------------

-- TERM_IN_USE: a term's dates and weight are fixed once any non-voided assessment names it. The
-- service locks the term before checking; this is the line.
CREATE FUNCTION asms_academic_term_in_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.starts_on, NEW.ends_on, NEW.weight) IS DISTINCT FROM (OLD.starts_on, OLD.ends_on, OLD.weight)
     AND EXISTS (
       SELECT 1 FROM assessments a
       WHERE a.school_id = NEW.school_id AND a.term_id = NEW.id AND a.voided_at IS NULL
     ) THEN
    RAISE EXCEPTION 'the term has assessments; its dates and weight are fixed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'academic_terms_in_use',
            DETAIL = 'constraint: academic_terms_in_use',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "academic_terms_in_use" BEFORE UPDATE OF "starts_on", "ends_on", "weight" ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_academic_term_in_use();

-- CLASS_SUBJECT_IN_USE: a class-subject with a live mark on a non-voided assessment cannot be
-- archived (published results join this in wave O).
CREATE FUNCTION asms_class_subject_in_use() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM assessments a
       JOIN marks m ON m.school_id = a.school_id AND m.assessment_id = a.id AND m.status = 'live'
       WHERE a.school_id = NEW.school_id AND a.class_subject_id = NEW.id AND a.voided_at IS NULL
     ) THEN
    RAISE EXCEPTION 'the class subject has marks and cannot be archived'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'class_subjects_in_use',
            DETAIL = 'constraint: class_subjects_in_use',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "class_subjects_in_use" BEFORE UPDATE OF "archived_at" ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_class_subject_in_use();
