-- AlterTable
ALTER TABLE "classes" ALTER COLUMN "attendance_mode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "office_reset_at" TIMESTAMPTZ(3);

-- =============================================================================================
-- Hand-written below this line. Follows the wave-A contracts (docs/plans/contracts/slice-2.md,
-- slice-3.md). The three earlier wave-A migrations were already applied, so they are not edited.
-- =============================================================================================

-- Contract slice-2 decision 5: voiding a token sets expires_at = now() (used_at means consumed
-- only). A void in the same transaction as the insert, or an application clock behind the
-- database's, would break "expires_at > created_at", so the CHECK goes.
ALTER TABLE "user_tokens" DROP CONSTRAINT "user_tokens_expires_at_check";

-- Contract slice-3 §3.4: a class's academic year changes only while nothing references it. Rows
-- that carry the year (teacher_assignments, enrolments) refuse it through their composite FKs to
-- (school_id, id, academic_year_id) ON UPDATE RESTRICT. A section carries no year, so its FK
-- cannot; this trigger is the database's line for sections, archived ones included. The UPDATE
-- holds the class row lock before the trigger runs and a section insert's FK check takes KEY
-- SHARE on the same row, so the two serialise; plpgsql takes a fresh snapshot per statement under
-- READ COMMITTED, so a section committed while the UPDATE waited is seen.
CREATE FUNCTION asms_forbid_class_year_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM sections s WHERE s.school_id = OLD.school_id AND s.class_id = OLD.id) THEN
    RAISE EXCEPTION 'academic_year_id cannot change on a class that has sections'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'classes_academic_year_immutable',
            DETAIL = 'constraint: classes_academic_year_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'academic_year_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "classes_academic_year_immutable" BEFORE UPDATE OF "academic_year_id" ON "classes"
  FOR EACH ROW WHEN (OLD."academic_year_id" IS DISTINCT FROM NEW."academic_year_id")
  EXECUTE FUNCTION asms_forbid_class_year_change();
