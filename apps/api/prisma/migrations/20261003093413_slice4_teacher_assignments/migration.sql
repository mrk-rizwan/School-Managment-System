-- CreateEnum
CREATE TYPE "teacher_assignment_role" AS ENUM ('class_teacher', 'subject_teacher');

-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "left_on" DATE;

-- CreateTable
CREATE TABLE "teacher_assignments" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "section_id" BIGINT,
    "subject_id" BIGINT,
    "role" "teacher_assignment_role" NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_staff_id_idx" ON "teacher_assignments"("school_id", "staff_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_class_id_academic_year_id_idx" ON "teacher_assignments"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_section_id_class_id_idx" ON "teacher_assignments"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_subject_id_idx" ON "teacher_assignments"("school_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignments_school_id_id_key" ON "teacher_assignments"("school_id", "id");

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_id_fkey" FOREIGN KEY ("school_id", "subject_id") REFERENCES "subjects"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line: the extension, CHECKs, the exclusion constraint, a shared trigger
-- function and triggers. Generated SQL above reviewed: no drift lines.
-- =============================================================================================

-- ---- staff ----------------------------------------------------------------------------------

-- left_on exists only on a row that has left; re-hire (left -> active, R19) clears it. Deliberately
-- NOT the both-ways pairing (status = 'left') = (left_on IS NOT NULL): rows written as `left`
-- before this column existed (test fixtures, test/support/school-session.ts) carry no date. The
-- slice-4 status change sets it; tightening to the pairing is a later, data-checked migration.
ALTER TABLE "staff" ADD CONSTRAINT "staff_left_on_check"
  CHECK ("left_on" IS NULL OR "status" = 'left');

ALTER TABLE "staff" ADD CONSTRAINT "staff_left_on_after_joined_check"
  CHECK ("left_on" IS NULL OR "joined_on" IS NULL OR "left_on" >= "joined_on");

-- ---- shared: frozen columns -----------------------------------------------------------------

-- Refuses an UPDATE that changes any column named in the trigger's arguments. Raises 23514 with
-- DETAIL 'constraint: <table>_<column>_immutable' (the error mapper reads DETAIL; the pg adapter
-- drops CONSTRAINT for 23514, migration 20261002163440_trigger_errors_name_constraint). Used where
-- "corrections are new rows" (rule 4) applies to a row's identity but not to its end marker.
CREATE FUNCTION asms_forbid_columns_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION '% is immutable on %', col, TG_TABLE_NAME
        USING ERRCODE = 'check_violation',
              CONSTRAINT = TG_TABLE_NAME || '_' || col || '_immutable',
              DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_immutable',
              SCHEMA = TG_TABLE_SCHEMA,
              TABLE = TG_TABLE_NAME,
              COLUMN = col;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---- teacher_assignments --------------------------------------------------------------------

-- Trusted extension (PG 13+): needs CREATE on the database, not superuser. Gives gist the btree
-- equality operators for bigint, which the exclusion constraint below pairs with a range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_dates_check"
  CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on");

-- A class teacher owns one section and no subject.
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_class_teacher_check"
  CHECK ("role" <> 'class_teacher' OR ("section_id" IS NOT NULL AND "subject_id" IS NULL));

-- A subject teacher teaches a subject; a null section means every section of the class (R54).
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_teacher_check"
  CHECK ("role" <> 'subject_teacher' OR "subject_id" IS NOT NULL);

-- R23: one class teacher per section at any date. Inclusive ranges ('[]'): an assignment ending on
-- the 14th and its successor starting on the 15th do not overlap; both on the 14th do. A null
-- ends_on is an unbounded upper end. A conflict is SQLSTATE 23P01, which the pg adapter forwards
-- with no constraint field; the name is in the message:
--   conflicting key value violates exclusion constraint "teacher_assignments_one_class_teacher_excl"
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_one_class_teacher_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "section_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  ) WHERE ("role" = 'class_teacher');

-- Only the dates move. Who, where and what are the row's identity: a change is a new row (R23).
-- starts_on stays editable so a future-dated assignment can be corrected before it starts (an
-- assignment cannot be "ended" before its first day: ends_on >= starts_on).
CREATE TRIGGER "teacher_assignments_columns_immutable" BEFORE UPDATE ON "teacher_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'academic_year_id', 'class_id', 'section_id', 'subject_id', 'role');

CREATE TRIGGER "teacher_assignments_school_id_immutable" BEFORE UPDATE ON "teacher_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
