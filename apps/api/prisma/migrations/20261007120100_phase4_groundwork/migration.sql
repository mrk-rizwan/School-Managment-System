-- Phase 4 groundwork (phase-4-academic.md §3.2, §3.7, §4 migration (2), §5.1): the pass_rule enum,
-- the set-up tables of slice 29 (academic_terms, term_skips, result_settings, class_subjects),
-- classes.next_class_id and is_final, the two certificate settings, the SMS allow list widened to
-- the two result types, and asms_seed_year_results with its backfill. Generated DDL first (prisma
-- migrate diff against the migrated database, the create-only equivalent in a non-interactive
-- shell; the three message_type values are in the previous migration), hand-written SQL after the
-- marker.

-- CreateEnum
CREATE TYPE "pass_rule" AS ENUM ('all_subjects', 'overall');

-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "is_final" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "next_class_id" BIGINT;

-- AlterTable
ALTER TABLE "school_settings" ADD COLUMN     "certificate_show_identity_no" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "certificate_signatory_name" VARCHAR(100),
ALTER COLUMN "sms_allowed_types" SET DEFAULT ARRAY['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice', 'fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected', 'result_published', 'result_revised']::"message_type"[];

-- CreateTable
CREATE TABLE "academic_terms" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "weight" SMALLINT NOT NULL,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_skips" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "term_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_skips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_settings" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "test_weight" SMALLINT NOT NULL DEFAULT 20,
    "exam_weight" SMALLINT NOT NULL DEFAULT 80,
    "pass_percent" SMALLINT NOT NULL DEFAULT 40,
    "pass_rule" "pass_rule" NOT NULL DEFAULT 'all_subjects',
    "bands" JSONB NOT NULL DEFAULT '[{"grade": "A+", "minPercent": 90}, {"grade": "A", "minPercent": 80}, {"grade": "B", "minPercent": 70}, {"grade": "C", "minPercent": 60}, {"grade": "D", "minPercent": 50}, {"grade": "E", "minPercent": 40}, {"grade": "F", "minPercent": 0}]',
    "show_position" BOOLEAN NOT NULL DEFAULT true,
    "show_attendance" BOOLEAN NOT NULL DEFAULT true,
    "show_remark" BOOLEAN NOT NULL DEFAULT true,
    "withhold_card_for_dues" BOOLEAN NOT NULL DEFAULT false,
    "notify_class_tests" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_subjects" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "subject_id" BIGINT NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "exam_max_marks" SMALLINT NOT NULL DEFAULT 100,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "academic_terms_school_id_created_by_idx" ON "academic_terms"("school_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "academic_terms_school_id_id_key" ON "academic_terms"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_terms_school_id_id_academic_year_id_key" ON "academic_terms"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE INDEX "academic_terms_school_id_academic_year_id_starts_on_idx" ON "academic_terms"("school_id", "academic_year_id", "starts_on");

-- CreateIndex
CREATE INDEX "term_skips_school_id_term_id_idx" ON "term_skips"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "term_skips_school_id_class_id_idx" ON "term_skips"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "term_skips_school_id_created_by_idx" ON "term_skips"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "term_skips_school_id_ended_by_idx" ON "term_skips"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "term_skips_school_id_id_key" ON "term_skips"("school_id", "id");

-- CreateIndex
CREATE INDEX "result_settings_school_id_updated_by_idx" ON "result_settings"("school_id", "updated_by");

-- CreateIndex
CREATE UNIQUE INDEX "result_settings_school_id_id_key" ON "result_settings"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "result_settings_school_id_academic_year_id_key" ON "result_settings"("school_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "class_subjects_school_id_class_id_idx" ON "class_subjects"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "class_subjects_school_id_subject_id_idx" ON "class_subjects"("school_id", "subject_id");

-- CreateIndex
CREATE INDEX "class_subjects_school_id_archived_by_idx" ON "class_subjects"("school_id", "archived_by");

-- CreateIndex
CREATE UNIQUE INDEX "class_subjects_school_id_id_key" ON "class_subjects"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_subjects_school_id_id_class_id_key" ON "class_subjects"("school_id", "id", "class_id");

-- CreateIndex
CREATE INDEX "classes_school_id_next_class_id_idx" ON "classes"("school_id", "next_class_id");

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_next_class_id_fkey" FOREIGN KEY ("school_id", "next_class_id") REFERENCES "classes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_updated_by_fkey" FOREIGN KEY ("school_id", "updated_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subject_id_fkey" FOREIGN KEY ("school_id", "subject_id") REFERENCES "subjects"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_archived_by_fkey" FOREIGN KEY ("school_id", "archived_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-4-academic.md §3.2, §4 "Slice 29"). Generated SQL above
-- reviewed: no drift lines. Every object here is listed in test/guardrails/schema-checks.ts
-- (PHASE_4_GROUNDWORK_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL
-- 'constraint: <name>'. Deferred to the wave that adds the tables they read: the
-- result_settings_locked trigger and the TERM_IN_USE lock on term dates and weight (result_sheets,
-- assessments; waves N and O), and the class-subject freeze while a sheet is submitted or
-- approved (wave O).
-- =============================================================================================

-- ---- school_settings: the SMS allow list gains the result types (§3.5) ------------------------

-- The eligible set gains result_published and result_revised (packages/shared SMS_ELIGIBLE_TYPES,
-- in table order); test_marked is never eligible (R266).
ALTER TABLE "school_settings" DROP CONSTRAINT "school_settings_sms_allowed_types_check";
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_sms_allowed_types_check"
  CHECK (
    "sms_allowed_types" IS NOT NULL
    AND array_position("sms_allowed_types", NULL) IS NULL
    AND "sms_allowed_types" <@ ARRAY[
      'absence_alert', 'late_advice', 'attendance_corrected',
      'announcement_urgent', 'announcement_normal', 'holiday_notice',
      'fee_charged', 'fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected',
      'result_published', 'result_revised'
    ]::message_type[]
  );

-- Backfill: every existing school gets the two result types the new default allows. They did not
-- exist before, so no school can have chosen to leave them out.
UPDATE "school_settings"
SET "sms_allowed_types" = "sms_allowed_types" || ARRAY(
  SELECT u.t FROM unnest(ARRAY['result_published', 'result_revised']::message_type[]) WITH ORDINALITY AS u(t, n)
  WHERE NOT (u.t = ANY ("sms_allowed_types"))
  ORDER BY u.n
);

-- ---- school_settings: the certificate settings (§3.7) ------------------------------------------

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_certificate_signatory_name_check"
  CHECK ("certificate_signatory_name" IS NULL OR ("certificate_signatory_name" = btrim("certificate_signatory_name") AND "certificate_signatory_name" <> ''));

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_certificate_signatory_name_no_id_check"
  CHECK ("certificate_signatory_name" !~ '[0-9]{13}' AND "certificate_signatory_name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- ---- classes: the next class and the final class (§3.2 "Classes", rule 30) ---------------------

ALTER TABLE "classes" ADD CONSTRAINT "classes_next_class_check"
  CHECK (NOT ("is_final" AND "next_class_id" IS NOT NULL) AND ("next_class_id" IS NULL OR "next_class_id" <> "id"));

-- ---- academic_terms (R254) ---------------------------------------------------------------------

ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- At most six terms a year: the order is the rank by date, 1-6, unique per year. Deferred, so the
-- service can renumber every term of the year in one transaction when a term is added or moved.
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_sort_order_check"
  CHECK ("sort_order" BETWEEN 1 AND 6);

ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_sort_order_excl"
  EXCLUDE USING btree ("school_id" WITH =, "academic_year_id" WITH =, "sort_order" WITH =)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_weight_check"
  CHECK ("weight" BETWEEN 0 AND 100);

ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_dates_check"
  CHECK ("ends_on" >= "starts_on");

-- Terms of a year never overlap (btree_gist exists since slice 4).
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_no_overlap"
  EXCLUDE USING gist ("school_id" WITH =, "academic_year_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);

CREATE UNIQUE INDEX "academic_terms_name_key" ON "academic_terms" ("school_id", "academic_year_id", lower("name"));

-- A term lies inside its year: checked when the term is written and when the year's dates move.
CREATE FUNCTION asms_academic_term_inside_year() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'academic_terms' THEN
    IF NOT EXISTS (
      SELECT 1 FROM academic_years y
      WHERE y.school_id = NEW.school_id AND y.id = NEW.academic_year_id
        AND NEW.starts_on >= y.starts_on AND NEW.ends_on <= y.ends_on
    ) THEN
      RAISE EXCEPTION 'a term lies inside its academic year'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'academic_terms_inside_year',
              DETAIL = 'constraint: academic_terms_inside_year',
              SCHEMA = TG_TABLE_SCHEMA,
              TABLE = TG_TABLE_NAME;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM academic_terms t
    WHERE t.school_id = NEW.school_id AND t.academic_year_id = NEW.id
      AND (t.starts_on < NEW.starts_on OR t.ends_on > NEW.ends_on)
  ) THEN
    RAISE EXCEPTION 'a term lies inside its academic year'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'academic_terms_inside_year',
            DETAIL = 'constraint: academic_terms_inside_year',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "academic_terms_inside_year" BEFORE INSERT OR UPDATE OF "starts_on", "ends_on" ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_academic_term_inside_year();

CREATE TRIGGER "academic_years_terms_inside" BEFORE UPDATE OF "starts_on", "ends_on" ON "academic_years"
  FOR EACH ROW EXECUTE FUNCTION asms_academic_term_inside_year();

CREATE TRIGGER "academic_terms_columns_immutable" BEFORE UPDATE ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'created_by', 'created_at');

CREATE TRIGGER "academic_terms_no_delete" BEFORE DELETE ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "academic_terms_no_truncate" BEFORE TRUNCATE ON "academic_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "academic_terms_school_id_immutable" BEFORE UPDATE ON "academic_terms"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- term_skips (§1.1 "Term not held for a class") ---------------------------------------------

ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "term_skips" ADD CONSTRAINT "term_skips_ended_check"
  CHECK (("ended_at" IS NULL) = ("ended_by" IS NULL));

-- One live skip per term and class; lifting it ends the row, and skipping again is a new row.
CREATE UNIQUE INDEX "term_skips_live_key" ON "term_skips" ("school_id", "term_id", "class_id")
  WHERE "ended_at" IS NULL;

CREATE TRIGGER "term_skips_columns_immutable" BEFORE UPDATE ON "term_skips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'term_id', 'class_id', 'reason', 'created_by', 'created_at');

CREATE TRIGGER "term_skips_ended_frozen" BEFORE UPDATE ON "term_skips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by');

CREATE TRIGGER "term_skips_no_delete" BEFORE DELETE ON "term_skips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "term_skips_no_truncate" BEFORE TRUNCATE ON "term_skips"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "term_skips_school_id_immutable" BEFORE UPDATE ON "term_skips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- result_settings (R255, §3.7) --------------------------------------------------------------

ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_weights_check"
  CHECK ("test_weight" BETWEEN 0 AND 100 AND "exam_weight" BETWEEN 0 AND 100 AND "test_weight" + "exam_weight" = 100);

ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_pass_percent_check"
  CHECK ("pass_percent" BETWEEN 0 AND 100);

-- The shape of each band (descending, one at 0, unique grades) is packages/shared bandsProblem's.
ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_bands_check"
  CHECK (jsonb_typeof("bands") = 'array' AND jsonb_array_length("bands") BETWEEN 1 AND 12);

CREATE TRIGGER "result_settings_columns_immutable" BEFORE UPDATE ON "result_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'created_at');

CREATE TRIGGER "result_settings_no_delete" BEFORE DELETE ON "result_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_settings_no_truncate" BEFORE TRUNCATE ON "result_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "result_settings_school_id_immutable" BEFORE UPDATE ON "result_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- class_subjects (R257) ---------------------------------------------------------------------

ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_sort_order_check"
  CHECK ("sort_order" BETWEEN 0 AND 999);

ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_exam_max_marks_check"
  CHECK ("exam_max_marks" BETWEEN 1 AND 1000);

ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_archived_check"
  CHECK (("archived_at" IS NULL) = ("archived_by" IS NULL));

-- One live row per class and subject; an archived row frees the subject for a new one.
CREATE UNIQUE INDEX "class_subjects_live_key" ON "class_subjects" ("school_id", "class_id", "subject_id")
  WHERE "archived_at" IS NULL;

CREATE TRIGGER "class_subjects_columns_immutable" BEFORE UPDATE ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'class_id', 'subject_id', 'created_at');

-- Archive is final and freezes the row.
CREATE TRIGGER "class_subjects_archived_frozen" BEFORE UPDATE ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'archived_at', 'archived_by', 'sort_order', 'exam_max_marks');

CREATE TRIGGER "class_subjects_no_delete" BEFORE DELETE ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "class_subjects_no_truncate" BEFORE TRUNCATE ON "class_subjects"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "class_subjects_school_id_immutable" BEFORE UPDATE ON "class_subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- a year's result seeds (R254, §3.7) --------------------------------------------------------

-- The year's result_settings row (the column defaults: weights 20/80, pass 40 %, all subjects,
-- rule 26's bands) and its two terms: Mid-term, the first half, and Annual, the rest, 50/50, with
-- created_by null. Called by the year-creation transaction (AcademicYearRepository.seedResults)
-- and by the backfill below, so the seed has one definition; packages/shared SEEDED_TERM_NAMES,
-- DEFAULT_GRADE_BANDS and the weight defaults mirror it, and test/academics/terms.e2e-spec.ts
-- compares the two. Idempotent: the settings row is ON CONFLICT DO NOTHING and a year holding
-- any term is not given terms again.
CREATE FUNCTION asms_seed_year_results(p_school_id bigint, p_year_id bigint) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO "result_settings" ("school_id", "academic_year_id")
  SELECT y."school_id", y."id" FROM "academic_years" y
  WHERE y."school_id" = p_school_id AND y."id" = p_year_id
  ON CONFLICT ("school_id", "academic_year_id") DO NOTHING;

  INSERT INTO "academic_terms" ("school_id", "academic_year_id", "name", "sort_order", "starts_on", "ends_on", "weight")
  SELECT y."school_id", y."id", v.name, v.n,
         CASE v.n WHEN 1 THEN y."starts_on" ELSE y."starts_on" + (y."ends_on" - y."starts_on") / 2 + 1 END,
         CASE v.n WHEN 1 THEN y."starts_on" + (y."ends_on" - y."starts_on") / 2 ELSE y."ends_on" END,
         50
  FROM "academic_years" y
  CROSS JOIN (VALUES (1, 'Mid-term'), (2, 'Annual')) AS v(n, name)
  WHERE y."school_id" = p_school_id AND y."id" = p_year_id
    AND NOT EXISTS (
      SELECT 1 FROM "academic_terms" t WHERE t."school_id" = p_school_id AND t."academic_year_id" = p_year_id
    )
  ORDER BY v.n;
$$;

-- Backfill: every existing academic year, closed ones included, gets its settings and terms.
SELECT asms_seed_year_results("school_id", "id") FROM "academic_years" ORDER BY "id";
