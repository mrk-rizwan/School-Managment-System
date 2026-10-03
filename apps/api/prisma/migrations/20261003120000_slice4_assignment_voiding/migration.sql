-- AlterTable
ALTER TABLE "teacher_assignments" ADD COLUMN     "voided_at" TIMESTAMPTZ(3),
ADD COLUMN     "voided_by" BIGINT;

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_voided_by_idx" ON "teacher_assignments"("school_id", "voided_by");

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line. Follows docs/plans/contracts/slice-4.md §4.1: "ending" means no
-- longer counts from today (ends_on = today - 1, so ends_on >= starts_on needs a row that began
-- before today); "voided" means never counted, for a row that had not begun or began today. Rule 4
-- forbids deleting it. 20261003093413_slice4_teacher_assignments was already applied, so it is not
-- edited. Generated SQL above reviewed: no drift lines.
-- =============================================================================================

ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_voided_check"
  CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL));

-- A voided row never counted, so it cannot hold the section: it leaves the exclusion. Renamed to
-- the name the API maps (CLASS_TEACHER_EXISTS, SQLSTATE 23P01; the name is in the message).
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_one_class_teacher_excl";

ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_class_teacher_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "section_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  ) WHERE ("role" = 'class_teacher' AND "voided_at" IS NULL);

-- With voiding available, starts_on no longer needs to be editable: a wrong start is voided and
-- re-inserted. Only ends_on, voided_at and voided_by (and updated_at) change after insert.
DROP TRIGGER "teacher_assignments_columns_immutable" ON "teacher_assignments";

CREATE TRIGGER "teacher_assignments_columns_immutable" BEFORE UPDATE ON "teacher_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'academic_year_id', 'class_id', 'section_id', 'subject_id', 'role', 'starts_on');
