-- Phase 2 groundwork, slice 10's schema (phase-2-daily-operations.md §5 "Calendar", §4.5;
-- contracts/slice-9.md §4, contracts/slice-10.md §12). Generated with
-- `prisma migrate diff --from-config-datasource --to-schema` (migrate dev refuses the unique-index
-- warnings non-interactively); no drift lines.

-- CreateEnum
CREATE TYPE "holiday_kind" AS ENUM ('public', 'school');

-- CreateEnum
CREATE TYPE "holiday_status" AS ENUM ('draft', 'published', 'cancelled');

-- CreateEnum
CREATE TYPE "late_counts_as" AS ENUM ('present', 'half_day', 'absent_after_cutoff');

-- CreateEnum
CREATE TYPE "leave_counts_as" AS ENUM ('excused', 'absent');

-- CreateEnum
CREATE TYPE "remark_visibility" AS ENUM ('internal', 'guardian', 'student');

-- AlterTable
ALTER TABLE "school_settings" ADD COLUMN     "absence_alert_time" TIME(0) NOT NULL DEFAULT '09:30:00'::time without time zone,
ADD COLUMN     "attendance_amend_window_days" SMALLINT NOT NULL DEFAULT 3,
ADD COLUMN     "late_advice_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "late_counts_as" "late_counts_as" NOT NULL DEFAULT 'present',
ADD COLUMN     "late_cutoff_time" TIME(0),
ADD COLUMN     "leave_counts_as" "leave_counts_as" NOT NULL DEFAULT 'excused',
ADD COLUMN     "periods_per_day" SMALLINT NOT NULL DEFAULT 8,
ADD COLUMN     "register_deadline_time" TIME(0) NOT NULL DEFAULT '10:00:00'::time without time zone,
ADD COLUMN     "remark_default_visibility" "remark_visibility" NOT NULL DEFAULT 'guardian',
ADD COLUMN     "remark_notify_guardians" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sms_allowed_types" "message_type"[] DEFAULT ARRAY['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice']::"message_type"[],
ADD COLUMN     "weekly_off_days" SMALLINT[] DEFAULT ARRAY[0]::SMALLINT[];

-- AlterTable
ALTER TABLE "teacher_assignments" ADD COLUMN     "covers_assignment_id" BIGINT;

-- CreateTable
CREATE TABLE "holidays" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "kind" "holiday_kind" NOT NULL,
    "applies_to_staff" BOOLEAN NOT NULL DEFAULT true,
    "status" "holiday_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(3),
    "published_by" BIGINT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" VARCHAR(500),
    "announcement_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holidays_school_id_status_starts_on_idx" ON "holidays"("school_id", "status", "starts_on");

-- CreateIndex
CREATE INDEX "holidays_school_id_published_by_idx" ON "holidays"("school_id", "published_by");

-- CreateIndex
CREATE INDEX "holidays_school_id_cancelled_by_idx" ON "holidays"("school_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_school_id_id_key" ON "holidays"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_school_id_id_student_id_key" ON "enrolments"("school_id", "id", "student_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_covers_assignment_id_idx" ON "teacher_assignments"("school_id", "covers_assignment_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignments_school_id_id_section_id_key" ON "teacher_assignments"("school_id", "id", "section_id");

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_covers_assignment_id_fkey" FOREIGN KEY ("school_id", "covers_assignment_id", "section_id") REFERENCES "teacher_assignments"("school_id", "id", "section_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_published_by_fkey" FOREIGN KEY ("school_id", "published_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_cancelled_by_fkey" FOREIGN KEY ("school_id", "cancelled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line: CHECKs, the holiday exclusion constraint, freeze and history
-- triggers, school_id immutability. Prisma emits scalar-list columns without NOT NULL, so "never
-- NULL, no NULL element" is a CHECK on each array column.
-- =============================================================================================

-- ---- school_settings (plan §4.5, contracts/slice-9.md §4) -----------------------------------

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_periods_per_day_check"
  CHECK ("periods_per_day" BETWEEN 1 AND 12);

-- 0 = Sunday ... 6 = Saturday, never all seven (a school with no teaching day is not a school).
-- The API stores them distinct and ascending; a duplicate cannot reach seven distinct days.
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_weekly_off_days_check"
  CHECK (
    "weekly_off_days" IS NOT NULL
    AND array_position("weekly_off_days", NULL) IS NULL
    AND "weekly_off_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
    AND cardinality("weekly_off_days") < 7
  );

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_attendance_amend_window_days_check"
  CHECK ("attendance_amend_window_days" BETWEEN 0 AND 30);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_late_cutoff_time_check"
  CHECK ("late_counts_as" <> 'absent_after_cutoff' OR "late_cutoff_time" IS NOT NULL);

-- Only the SMS-eligible types (contracts/slice-9.md §4, §7.2; packages/shared SMS_ELIGIBLE_TYPES):
-- diary, remark, internal, test and platform types never reach SMS through the allow list.
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_sms_allowed_types_check"
  CHECK (
    "sms_allowed_types" IS NOT NULL
    AND array_position("sms_allowed_types", NULL) IS NULL
    AND "sms_allowed_types" <@ ARRAY[
      'absence_alert', 'late_advice', 'attendance_corrected',
      'announcement_urgent', 'announcement_normal', 'holiday_notice'
    ]::message_type[]
  );

-- ---- teacher_assignments: cover (R132, contracts/slice-10.md §6, §12 item 3) ------------------

-- A cover is a dated class-teacher scope for one section: no subject, and it always ends.
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_cover_check"
  CHECK ("role" <> 'cover' OR ("section_id" IS NOT NULL AND "subject_id" IS NULL AND "ends_on" IS NOT NULL));

-- Only a cover names the row it covers; the composite FK keeps that row in the same section.
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_covers_check"
  CHECK ("covers_assignment_id" IS NULL OR "role" = 'cover');

-- The cover link is part of the row's identity, frozen like the rest.
DROP TRIGGER "teacher_assignments_columns_immutable" ON "teacher_assignments";

CREATE TRIGGER "teacher_assignments_columns_immutable" BEFORE UPDATE ON "teacher_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'academic_year_id', 'class_id', 'section_id', 'subject_id', 'role', 'starts_on',
    'covers_assignment_id');

-- ---- enrolments (contracts/slice-10.md §8.1, §12 item 1) ------------------------------------

-- A section or class change closes the old enrolment on effectiveOn - 1. When effectiveOn is the
-- old enrolment's first day (a same-day correction) that is started_on - 1: a zero-length
-- enrolment, in force on no date, kept as history instead of edited.
-- §12 item 2 (section_id frozen) is NOT here: the shipped slice-6 change-section still edits
-- section_id in place until slice 10 replaces it with close-old/open-new, so slice 10's migration
-- adds section_id to enrolments_columns_immutable with that code.
ALTER TABLE "enrolments" DROP CONSTRAINT "enrolments_ended_check";

ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_ended_check"
  CHECK (("status" = 'active') = ("ended_on" IS NULL) AND ("ended_on" IS NULL OR "ended_on" >= "started_on" - 1));

-- ---- holidays (plan §5 "Calendar", contracts/slice-10.md §4, §12 item 5) --------------------

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_dates_check" CHECK ("ends_on" >= "starts_on");

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_description_no_id_check"
  CHECK ("description" !~ '[0-9]{13}' AND "description" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_cancel_reason_no_id_check"
  CHECK ("cancel_reason" !~ '[0-9]{13}' AND "cancel_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- published_at/by together; a published holiday has them, a draft does not, a cancelled one has
-- them only if it was published first.
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_published_check"
  CHECK (
    ("published_at" IS NULL) = ("published_by" IS NULL)
    AND ("status" <> 'published' OR "published_at" IS NOT NULL)
    AND ("status" <> 'draft' OR "published_at" IS NULL)
  );

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_cancelled_check"
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
  );

-- Live (draft or published) ranges never overlap within a school; race-safe where a trigger is
-- not (the teacher_assignments precedent; btree_gist is installed). Inclusive bounds. A conflict
-- is SQLSTATE 23P01, the name in the message; mapped to 409 HOLIDAY_DATES_TAKEN.
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_live_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  ) WHERE ("status" <> 'cancelled');

-- R117: once published, the dates, kind and name are frozen (moving a date silently would move
-- R116's denominator); a wrong date is cancel plus a new holiday.
CREATE TRIGGER "holidays_published_frozen" BEFORE UPDATE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'published_at', 'published_by', 'starts_on', 'ends_on', 'kind', 'name');

-- Cancelled is final: nothing on the row changes again.
CREATE TRIGGER "holidays_cancelled_frozen" BEFORE UPDATE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'cancelled_at', 'cancelled_by', 'cancel_reason', 'status', 'starts_on', 'ends_on', 'name',
    'description', 'kind', 'applies_to_staff', 'announcement_id');

CREATE TRIGGER "holidays_no_delete" BEFORE DELETE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "holidays_no_truncate" BEFORE TRUNCATE ON "holidays"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "holidays_school_id_immutable" BEFORE UPDATE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
