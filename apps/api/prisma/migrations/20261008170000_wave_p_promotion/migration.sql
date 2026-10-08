-- Phase 4 wave P (phase-4-academic.md §3.2 "Promotion", "Enrolments and students", §4 "Slice 35"):
-- the promotion_outcome and promotion_sheet_status enums, the promotion_sheets and
-- promotion_decisions tables, the enrolment status edges, and the trigger that marks an applied
-- decision revised when its result is later superseded. Generated DDL first (prisma migrate diff
-- against the migrated database), hand-written SQL after the marker.
-- CreateEnum
CREATE TYPE "promotion_outcome" AS ENUM ('promote', 'detain', 'complete', 'not_continuing');

-- CreateEnum
CREATE TYPE "promotion_sheet_status" AS ENUM ('open', 'applied');

-- CreateTable
CREATE TABLE "promotion_sheets" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "target_year_id" BIGINT NOT NULL,
    "status" "promotion_sheet_status" NOT NULL DEFAULT 'open',
    "opened_by" BIGINT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" BIGINT,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_decisions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "sheet_id" BIGINT NOT NULL,
    "target_year_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "result_id" BIGINT,
    "proposed" "promotion_outcome",
    "decision" "promotion_outcome",
    "reason" VARCHAR(500),
    "target_class_id" BIGINT,
    "target_section_id" BIGINT,
    "new_enrolment_id" BIGINT,
    "arrears_flag" BOOLEAN NOT NULL DEFAULT false,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "revised_after_apply" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_academic_year_id_idx" ON "promotion_sheets"("school_id", "academic_year_id", "opened_at");

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_target_year_id_idx" ON "promotion_sheets"("school_id", "target_year_id");

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_class_id_idx" ON "promotion_sheets"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_section_id_idx" ON "promotion_sheets"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_opened_by_idx" ON "promotion_sheets"("school_id", "opened_by");

-- CreateIndex
CREATE INDEX "promotion_sheets_school_id_applied_by_idx" ON "promotion_sheets"("school_id", "applied_by");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_sheets_school_id_id_key" ON "promotion_sheets"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_sheets_school_id_id_target_year_id_key" ON "promotion_sheets"("school_id", "id", "target_year_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_sheet_id_idx" ON "promotion_decisions"("school_id", "sheet_id", "target_year_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_enrolment_id_idx" ON "promotion_decisions"("school_id", "enrolment_id", "student_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_result_id_idx" ON "promotion_decisions"("school_id", "result_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_target_class_id_idx" ON "promotion_decisions"("school_id", "target_class_id", "target_year_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_target_section_id_idx" ON "promotion_decisions"("school_id", "target_section_id", "target_class_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_new_enrolment_id_idx" ON "promotion_decisions"("school_id", "new_enrolment_id", "student_id", "target_year_id");

-- CreateIndex
CREATE INDEX "promotion_decisions_school_id_decided_by_idx" ON "promotion_decisions"("school_id", "decided_by");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_decisions_school_id_id_key" ON "promotion_decisions"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_decisions_school_id_sheet_id_enrolment_id_key" ON "promotion_decisions"("school_id", "sheet_id", "enrolment_id");

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_target_year_id_fkey" FOREIGN KEY ("school_id", "target_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_opened_by_fkey" FOREIGN KEY ("school_id", "opened_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_applied_by_fkey" FOREIGN KEY ("school_id", "applied_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_sheet_id_fkey" FOREIGN KEY ("school_id", "sheet_id", "target_year_id") REFERENCES "promotion_sheets"("school_id", "id", "target_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id") REFERENCES "enrolments"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_result_id_fkey" FOREIGN KEY ("school_id", "result_id", "enrolment_id") REFERENCES "results"("school_id", "id", "enrolment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_target_class_id_fkey" FOREIGN KEY ("school_id", "target_class_id", "target_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_target_section_id_fkey" FOREIGN KEY ("school_id", "target_section_id", "target_class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_new_enrolment_id_fkey" FOREIGN KEY ("school_id", "new_enrolment_id", "student_id", "target_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line (phase-4-academic.md §3.2 "Promotion", "Enrolments and students",
-- §4 "Slice 35"; contracts/slice-35.md §6). Generated SQL above reviewed: no drift lines. Every
-- object here is listed in test/guardrails/schema-checks.ts (WAVE_P_OBJECTS). Trigger functions
-- raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- promotion_sheets ---------------------------------------------------------------------------

-- A sheet promotes into another year.
ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_target_year_check"
  CHECK ("target_year_id" <> "academic_year_id");

ALTER TABLE "promotion_sheets" ADD CONSTRAINT "promotion_sheets_applied_check"
  CHECK (("status" = 'applied') = ("applied_at" IS NOT NULL) AND ("applied_at" IS NULL) = ("applied_by" IS NULL));

-- One open sheet per section (R294: PROMOTION_SHEET_OPEN).
CREATE UNIQUE INDEX "promotion_sheets_open_key" ON "promotion_sheets" ("school_id", "section_id")
  WHERE "status" = 'open';

CREATE TRIGGER "promotion_sheets_status_transition" BEFORE UPDATE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:applied');

CREATE TRIGGER "promotion_sheets_columns_immutable" BEFORE UPDATE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'class_id', 'section_id', 'target_year_id', 'opened_by', 'opened_at', 'created_at');

CREATE TRIGGER "promotion_sheets_applied_frozen" BEFORE UPDATE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('applied_at', 'applied_by', 'status');

CREATE TRIGGER "promotion_sheets_no_delete" BEFORE DELETE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "promotion_sheets_no_truncate" BEFORE TRUNCATE ON "promotion_sheets"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "promotion_sheets_school_id_immutable" BEFORE UPDATE ON "promotion_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- promotion_decisions (R294-R298) ------------------------------------------------------------

-- A decided promote or detain names its target class and section; complete and not_continuing
-- name none. Undecided, the row may carry the proposal's target.
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_target_check"
  CHECK (
    ("target_section_id" IS NULL OR "target_class_id" IS NOT NULL)
    AND ("decision" IS NULL OR (
      ("decision" IN ('promote', 'detain')) = ("target_class_id" IS NOT NULL)
      AND ("decision" IN ('promote', 'detain')) = ("target_section_id" IS NOT NULL)
    ))
  );

-- R295: a decision other than the proposal, or with no proposal, carries a reason.
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_reason_check"
  CHECK ("decision" IS NULL OR "decision" IS NOT DISTINCT FROM "proposed" OR "reason" IS NOT NULL);

ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_reason_trim_check"
  CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND "reason" <> ''));

ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_decided_check"
  CHECK (("decided_at" IS NULL) = ("decided_by" IS NULL));

-- R297: an applied row was decided; a promote or detain opened its new enrolment, and only those
-- do; revised_after_apply only on an applied row.
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_applied_check"
  CHECK (
    ("applied_at" IS NULL OR "decision" IS NOT NULL)
    AND ("applied_at" IS NULL OR "decision" NOT IN ('promote', 'detain') OR "new_enrolment_id" IS NOT NULL)
    AND ("new_enrolment_id" IS NULL OR ("applied_at" IS NOT NULL AND "decision" IN ('promote', 'detain')))
    AND (NOT "revised_after_apply" OR "applied_at" IS NOT NULL)
  );

-- Rows are written only while their sheet is open, for an enrolment of the sheet's section and
-- year; once a row is applied only revised_after_apply may change, and only to true. Apply sets
-- the rows' applied_at before the sheet becomes `applied`.
CREATE FUNCTION asms_promotion_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.applied_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'revised_after_apply' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revised_after_apply' - 'updated_at')
       OR (OLD.revised_after_apply AND NOT NEW.revised_after_apply) THEN
      v_refusal := 'promotion_decisions_applied_frozen';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM promotion_sheets s
    WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id AND s.status = 'open'
  ) THEN
    v_refusal := 'promotion_decisions_sheet_open';
  ELSIF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM promotion_sheets s
    JOIN enrolments e ON e.school_id = s.school_id AND e.section_id = s.section_id
      AND e.academic_year_id = s.academic_year_id
    WHERE s.school_id = NEW.school_id AND s.id = NEW.sheet_id AND e.id = NEW.enrolment_id
  ) THEN
    v_refusal := 'promotion_decisions_enrolment_of_section';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the promotion decision cannot be written (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotion_decisions_guard" BEFORE INSERT OR UPDATE ON "promotion_decisions"
  FOR EACH ROW EXECUTE FUNCTION asms_promotion_decision_guard();

CREATE TRIGGER "promotion_decisions_columns_immutable" BEFORE UPDATE ON "promotion_decisions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'sheet_id', 'target_year_id', 'enrolment_id', 'student_id', 'arrears_flag', 'created_at');

CREATE TRIGGER "promotion_decisions_no_delete" BEFORE DELETE ON "promotion_decisions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "promotion_decisions_no_truncate" BEFORE TRUNCATE ON "promotion_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "promotion_decisions_school_id_immutable" BEFORE UPDATE ON "promotion_decisions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- §1.1 "Correction cascade": a result superseded after its promotion row was applied (a slice-32
-- correction re-composing the final sheet, or a return) marks that row revised_after_apply; the
-- applied enrolments stand. An open row is re-checked by apply instead (PROMOTION_RESULT_SUPERSEDED).
CREATE FUNCTION asms_promotion_result_revised() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE promotion_decisions d
  SET revised_after_apply = true, updated_at = CURRENT_TIMESTAMP
  WHERE d.school_id = NEW.school_id AND d.result_id = NEW.id
    AND d.applied_at IS NOT NULL AND NOT d.revised_after_apply;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "results_promotion_revised" AFTER UPDATE OF "superseded_at" ON "results"
  FOR EACH ROW WHEN (OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL)
  EXECUTE FUNCTION asms_promotion_result_revised();

-- ---- enrolments (§3.2 "Enrolments and students") ------------------------------------------------

-- An enrolment ends once: `left` for exits and moves, `completed` at year end (promotion apply).
CREATE TRIGGER "enrolments_status_transition" BEFORE UPDATE ON "enrolments"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('active:completed', 'active:left');
