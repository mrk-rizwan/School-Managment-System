-- Phase 2 wave E groundwork, the schema of slices 11, 12 and 13 (phase-2-daily-operations.md
-- §4.6, §5 "Attendance", "Diary and remarks"). Generated with `pnpm db:migration:new`, renamed
-- to sort after 20261004090100; the generated part has no drift lines.

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('present', 'absent', 'late', 'on_leave');

-- CreateEnum
CREATE TYPE "day_status" AS ENUM ('present', 'absent', 'late', 'on_leave', 'partial');

-- CreateEnum
CREATE TYPE "staff_attendance_status" AS ENUM ('present', 'absent', 'late', 'on_leave');

-- CreateEnum
CREATE TYPE "register_source" AS ENUM ('app', 'web');

-- CreateEnum
CREATE TYPE "attendance_alert_kind" AS ENUM ('absence', 'late', 'corrected');

-- CreateEnum
CREATE TYPE "attendance_alert_status" AS ENUM ('pending', 'sent', 'cancelled');

-- CreateEnum
CREATE TYPE "attendance_alert_cancel_reason" AS ENUM ('mark_changed', 'holiday', 'link_ended', 'backdated');

-- CreateEnum
CREATE TYPE "remark_category" AS ENUM ('academic', 'behaviour', 'homework', 'attendance', 'participation', 'general');

-- CreateTable
CREATE TABLE "attendance_registers" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "period" SMALLINT NOT NULL,
    "mode" "attendance_mode" NOT NULL,
    "submitted_by" BIGINT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_amended_by" BIGINT,
    "last_amended_at" TIMESTAMPTZ(3),
    "source" "register_source" NOT NULL,

    CONSTRAINT "attendance_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_marks" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "register_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "period" SMALLINT NOT NULL,
    "status" "attendance_status" NOT NULL,
    "arrived_at" TIME(0),
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_mark_changes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "mark_id" BIGINT NOT NULL,
    "old_status" "attendance_status" NOT NULL,
    "new_status" "attendance_status" NOT NULL,
    "old_note" VARCHAR(200),
    "new_note" VARCHAR(200),
    "changed_by" BIGINT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500) NOT NULL,

    CONSTRAINT "attendance_mark_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_arrivals" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "mark_id" BIGINT NOT NULL,
    "arrived_at" TIME(0) NOT NULL,
    "recorded_by" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_arrivals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_alerts" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "attendance_alert_kind" NOT NULL,
    "seq" SMALLINT NOT NULL DEFAULT 1,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "attendance_alert_status" NOT NULL DEFAULT 'pending',
    "cancel_reason" "attendance_alert_cancel_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_day_status" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "status" "day_status" NOT NULL,
    "periods_recorded" SMALLINT NOT NULL,
    "periods_present" SMALLINT NOT NULL,
    "periods_late" SMALLINT NOT NULL,
    "periods_absent" SMALLINT NOT NULL,
    "periods_leave" SMALLINT NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_day_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_daily_summary" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "mode" "attendance_mode" NOT NULL,
    "registers_expected" SMALLINT NOT NULL DEFAULT 0,
    "registers_recorded" SMALLINT NOT NULL DEFAULT 0,
    "roster_count" INTEGER NOT NULL DEFAULT 0,
    "present" INTEGER NOT NULL DEFAULT 0,
    "absent" INTEGER NOT NULL DEFAULT 0,
    "late" INTEGER NOT NULL DEFAULT 0,
    "on_leave" INTEGER NOT NULL DEFAULT 0,
    "partial" INTEGER NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 1,
    "computed_version" BIGINT NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(3),

    CONSTRAINT "attendance_daily_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "status" "staff_attendance_status" NOT NULL,
    "marked_by" BIGINT NOT NULL,
    "marked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(200),

    CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance_changes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_attendance_id" BIGINT NOT NULL,
    "old_status" "staff_attendance_status" NOT NULL,
    "new_status" "staff_attendance_status" NOT NULL,
    "old_note" VARCHAR(200),
    "new_note" VARCHAR(200),
    "changed_by" BIGINT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500) NOT NULL,

    CONSTRAINT "staff_attendance_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diary_entries" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "subject_id" BIGINT NOT NULL,
    "author_staff_id" BIGINT NOT NULL,
    "topic" VARCHAR(500) NOT NULL,
    "assignment" VARCHAR(1000),
    "learning_outcome" VARCHAR(500),
    "due_on" DATE,
    "attachment_object_key" VARCHAR(64),
    "attachment_mime" VARCHAR(32),
    "attachment_size_bytes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diary_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diary_entry_changes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "diary_entry_id" BIGINT NOT NULL,
    "old_topic" VARCHAR(500) NOT NULL,
    "new_topic" VARCHAR(500) NOT NULL,
    "old_assignment" VARCHAR(1000),
    "new_assignment" VARCHAR(1000),
    "old_learning_outcome" VARCHAR(500),
    "new_learning_outcome" VARCHAR(500),
    "old_due_on" DATE,
    "new_due_on" DATE,
    "old_attachment_object_key" VARCHAR(64),
    "new_attachment_object_key" VARCHAR(64),
    "changed_by" BIGINT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500),

    CONSTRAINT "diary_entry_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remarks" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "author_staff_id" BIGINT NOT NULL,
    "subject_id" BIGINT,
    "date" DATE NOT NULL,
    "category" "remark_category" NOT NULL,
    "text" VARCHAR(1000) NOT NULL,
    "visibility" "remark_visibility" NOT NULL,
    "supersedes_id" BIGINT,
    "correction_reason" VARCHAR(500),
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_registers_school_id_date_section_id_idx" ON "attendance_registers"("school_id", "date", "section_id");

-- CreateIndex
CREATE INDEX "attendance_registers_school_id_section_id_class_id_idx" ON "attendance_registers"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "attendance_registers_school_id_class_id_academic_year_id_idx" ON "attendance_registers"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "attendance_registers_school_id_submitted_by_idx" ON "attendance_registers"("school_id", "submitted_by");

-- CreateIndex
CREATE INDEX "attendance_registers_school_id_last_amended_by_idx" ON "attendance_registers"("school_id", "last_amended_by");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_registers_school_id_id_key" ON "attendance_registers"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_registers_natural_key" ON "attendance_registers"("school_id", "section_id", "date", "period");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_registers_school_id_id_date_period_key" ON "attendance_registers"("school_id", "id", "date", "period");

-- CreateIndex
CREATE INDEX "attendance_marks_school_id_register_id_date_period_idx" ON "attendance_marks"("school_id", "register_id", "date", "period");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_marks_school_id_id_key" ON "attendance_marks"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_marks_natural_key" ON "attendance_marks"("school_id", "enrolment_id", "date", "period");

-- CreateIndex
CREATE INDEX "attendance_mark_changes_school_id_mark_id_idx" ON "attendance_mark_changes"("school_id", "mark_id");

-- CreateIndex
CREATE INDEX "attendance_mark_changes_school_id_changed_by_idx" ON "attendance_mark_changes"("school_id", "changed_by");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_mark_changes_school_id_id_key" ON "attendance_mark_changes"("school_id", "id");

-- CreateIndex
CREATE INDEX "attendance_arrivals_school_id_mark_id_idx" ON "attendance_arrivals"("school_id", "mark_id");

-- CreateIndex
CREATE INDEX "attendance_arrivals_school_id_recorded_by_idx" ON "attendance_arrivals"("school_id", "recorded_by");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_arrivals_school_id_id_key" ON "attendance_arrivals"("school_id", "id");

-- CreateIndex
CREATE INDEX "attendance_alerts_school_id_status_due_at_idx" ON "attendance_alerts"("school_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "attendance_alerts_school_id_enrolment_id_student_id_idx" ON "attendance_alerts"("school_id", "enrolment_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_alerts_school_id_id_key" ON "attendance_alerts"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_alerts_natural_key" ON "attendance_alerts"("school_id", "student_id", "date", "kind", "seq");

-- CreateIndex
CREATE INDEX "attendance_day_status_school_id_student_id_date_idx" ON "attendance_day_status"("school_id", "student_id", "date");

-- CreateIndex
CREATE INDEX "attendance_day_status_school_id_enrolment_id_student_id_idx" ON "attendance_day_status"("school_id", "enrolment_id", "student_id");

-- CreateIndex
CREATE INDEX "attendance_day_status_school_id_section_id_date_idx" ON "attendance_day_status"("school_id", "section_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_day_status_school_id_id_key" ON "attendance_day_status"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_day_status_natural_key" ON "attendance_day_status"("school_id", "enrolment_id", "date");

-- CreateIndex
CREATE INDEX "attendance_daily_summary_school_id_date_idx" ON "attendance_daily_summary"("school_id", "date");

-- CreateIndex
CREATE INDEX "attendance_daily_summary_school_id_section_id_class_id_idx" ON "attendance_daily_summary"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "attendance_daily_summary_class_id_academic_year_id_idx" ON "attendance_daily_summary"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_daily_summary_school_id_id_key" ON "attendance_daily_summary"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_daily_summary_natural_key" ON "attendance_daily_summary"("school_id", "section_id", "date");

-- CreateIndex
CREATE INDEX "staff_attendance_school_id_marked_by_idx" ON "staff_attendance"("school_id", "marked_by");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_school_id_id_key" ON "staff_attendance"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_natural_key" ON "staff_attendance"("school_id", "staff_id", "date");

-- CreateIndex
CREATE INDEX "staff_attendance_changes_school_id_staff_attendance_id_idx" ON "staff_attendance_changes"("school_id", "staff_attendance_id");

-- CreateIndex
CREATE INDEX "staff_attendance_changes_school_id_changed_by_idx" ON "staff_attendance_changes"("school_id", "changed_by");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_changes_school_id_id_key" ON "staff_attendance_changes"("school_id", "id");

-- CreateIndex
CREATE INDEX "diary_entries_school_id_author_staff_id_date_idx" ON "diary_entries"("school_id", "author_staff_id", "date");

-- CreateIndex
CREATE INDEX "diary_entries_school_id_subject_id_idx" ON "diary_entries"("school_id", "subject_id");

-- CreateIndex
CREATE INDEX "diary_entries_school_id_section_id_class_id_idx" ON "diary_entries"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "diary_entries_school_id_class_id_academic_year_id_idx" ON "diary_entries"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "diary_entries_school_id_id_key" ON "diary_entries"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "diary_entries_natural_key" ON "diary_entries"("school_id", "section_id", "date", "subject_id");

-- CreateIndex
CREATE INDEX "diary_entry_changes_school_id_diary_entry_id_idx" ON "diary_entry_changes"("school_id", "diary_entry_id");

-- CreateIndex
CREATE INDEX "diary_entry_changes_school_id_changed_by_idx" ON "diary_entry_changes"("school_id", "changed_by");

-- CreateIndex
CREATE UNIQUE INDEX "diary_entry_changes_school_id_id_key" ON "diary_entry_changes"("school_id", "id");

-- CreateIndex
CREATE INDEX "remarks_school_id_student_id_date_idx" ON "remarks"("school_id", "student_id", "date");

-- CreateIndex
CREATE INDEX "remarks_school_id_author_staff_id_date_idx" ON "remarks"("school_id", "author_staff_id", "date");

-- CreateIndex
CREATE INDEX "remarks_school_id_subject_id_idx" ON "remarks"("school_id", "subject_id");

-- CreateIndex
CREATE INDEX "remarks_school_id_enrolment_id_student_id_idx" ON "remarks"("school_id", "enrolment_id", "student_id");

-- CreateIndex
CREATE INDEX "remarks_school_id_supersedes_id_student_id_idx" ON "remarks"("school_id", "supersedes_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "remarks_school_id_id_key" ON "remarks"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "remarks_school_id_id_student_id_key" ON "remarks"("school_id", "id", "student_id");

-- AddForeignKey
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_submitted_by_fkey" FOREIGN KEY ("school_id", "submitted_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_last_amended_by_fkey" FOREIGN KEY ("school_id", "last_amended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_register_id_fkey" FOREIGN KEY ("school_id", "register_id", "date", "period") REFERENCES "attendance_registers"("school_id", "id", "date", "period") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id") REFERENCES "enrolments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_mark_changes" ADD CONSTRAINT "attendance_mark_changes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_mark_changes" ADD CONSTRAINT "attendance_mark_changes_mark_id_fkey" FOREIGN KEY ("school_id", "mark_id") REFERENCES "attendance_marks"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_mark_changes" ADD CONSTRAINT "attendance_mark_changes_changed_by_fkey" FOREIGN KEY ("school_id", "changed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_arrivals" ADD CONSTRAINT "attendance_arrivals_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_arrivals" ADD CONSTRAINT "attendance_arrivals_mark_id_fkey" FOREIGN KEY ("school_id", "mark_id") REFERENCES "attendance_marks"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_arrivals" ADD CONSTRAINT "attendance_arrivals_recorded_by_fkey" FOREIGN KEY ("school_id", "recorded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_alerts" ADD CONSTRAINT "attendance_alerts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_alerts" ADD CONSTRAINT "attendance_alerts_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id") REFERENCES "enrolments"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_day_status" ADD CONSTRAINT "attendance_day_status_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_day_status" ADD CONSTRAINT "attendance_day_status_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id") REFERENCES "enrolments"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_day_status" ADD CONSTRAINT "attendance_day_status_section_id_fkey" FOREIGN KEY ("school_id", "section_id") REFERENCES "sections"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_daily_summary" ADD CONSTRAINT "attendance_daily_summary_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_daily_summary" ADD CONSTRAINT "attendance_daily_summary_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_daily_summary" ADD CONSTRAINT "attendance_daily_summary_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_marked_by_fkey" FOREIGN KEY ("school_id", "marked_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_changes" ADD CONSTRAINT "staff_attendance_changes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_changes" ADD CONSTRAINT "staff_attendance_changes_staff_attendance_id_fkey" FOREIGN KEY ("school_id", "staff_attendance_id") REFERENCES "staff_attendance"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_changes" ADD CONSTRAINT "staff_attendance_changes_changed_by_fkey" FOREIGN KEY ("school_id", "changed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_subject_id_fkey" FOREIGN KEY ("school_id", "subject_id") REFERENCES "subjects"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_author_staff_id_fkey" FOREIGN KEY ("school_id", "author_staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entry_changes" ADD CONSTRAINT "diary_entry_changes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entry_changes" ADD CONSTRAINT "diary_entry_changes_diary_entry_id_fkey" FOREIGN KEY ("school_id", "diary_entry_id") REFERENCES "diary_entries"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "diary_entry_changes" ADD CONSTRAINT "diary_entry_changes_changed_by_fkey" FOREIGN KEY ("school_id", "changed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id") REFERENCES "enrolments"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_author_staff_id_fkey" FOREIGN KEY ("school_id", "author_staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_subject_id_fkey" FOREIGN KEY ("school_id", "subject_id") REFERENCES "subjects"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_supersedes_id_fkey" FOREIGN KEY ("school_id", "supersedes_id", "student_id") REFERENCES "remarks"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (phase-2-daily-operations.md §4.6, §5 "Attendance", "Diary and
-- remarks"): CHECKs, the §4.6 history trigger, the summary version bump, freeze and append-only
-- triggers, not-self, the remark supersede chain, school_id immutability. Generated SQL above
-- reviewed: no drift lines. Every trigger function raises SQLSTATE 23514 with
-- DETAIL 'constraint: <name>' (migration 20261002163440_trigger_errors_name_constraint).
-- =============================================================================================

-- ---- shared functions -----------------------------------------------------------------------

-- §4.6: history on a table with a natural key. BEFORE UPDATE row trigger. TG_ARGV:
--   [0] the changes table, [1] its column naming the changed row, [2] 'reason_required' or
--   'reason_optional', [3..] the tracked columns; the changes table has old_<col> and new_<col>
--   for each, plus school_id, changed_by, changed_at and reason.
-- An update that changes no tracked column writes nothing and needs no actor (a replay is free,
-- R125). Otherwise the actor and reason are the TRANSACTION-LOCAL settings asms.actor_user_id and
-- asms.change_reason (set_config(..., true) through ChangeContextRepository): a missing actor
-- raises '<changes table>_actor_required', a missing reason (when required)
-- '<changes table>_reason_required' (e.g. attendance_mark_changes_actor_required; the naming of
-- contracts/slice-13.md §10 item 2, which wins over plan §4.6's '<table>_change_actor_required').
-- changed_by is a composite FK to users, so an actor from another school fails there. Outside a
-- transaction the setting dies with its own statement, so the update is refused: fail-closed.
CREATE FUNCTION asms_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changes_table CONSTANT text := TG_ARGV[0];
  row_column CONSTANT text := TG_ARGV[1];
  reason_required CONSTANT boolean := TG_ARGV[2] = 'reason_required';
  old_row CONSTANT jsonb := to_jsonb(OLD);
  new_row CONSTANT jsonb := to_jsonb(NEW);
  v_actor text := NULLIF(current_setting('asms.actor_user_id', true), '');
  v_reason text := NULLIF(btrim(current_setting('asms.change_reason', true)), '');
  v_refusal text;
  v_changed boolean := false;
  v_record jsonb;
  v_columns text;
  i int;
BEGIN
  FOR i IN 3 .. TG_NARGS - 1 LOOP
    IF old_row -> TG_ARGV[i] IS DISTINCT FROM new_row -> TG_ARGV[i] THEN
      v_changed := true;
    END IF;
  END LOOP;
  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NULL OR v_actor !~ '^[1-9][0-9]{0,18}$' THEN
    v_refusal := changes_table || '_actor_required';
    RAISE EXCEPTION 'a change to % needs the acting user (asms.actor_user_id)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  IF reason_required AND v_reason IS NULL THEN
    v_refusal := changes_table || '_reason_required';
    RAISE EXCEPTION 'a change to % needs a reason (asms.change_reason)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;

  v_record := jsonb_build_object(
    'school_id', OLD.school_id, row_column, OLD.id, 'changed_by', v_actor,
    'changed_at', now(), 'reason', v_reason);
  v_columns := format('school_id, %I, changed_by, changed_at, reason', row_column);
  FOR i IN 3 .. TG_NARGS - 1 LOOP
    v_record := v_record || jsonb_build_object(
      'old_' || TG_ARGV[i], old_row -> TG_ARGV[i], 'new_' || TG_ARGV[i], new_row -> TG_ARGV[i]);
    v_columns := v_columns || format(', %I, %I', 'old_' || TG_ARGV[i], 'new_' || TG_ARGV[i]);
  END LOOP;
  EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I, $1)',
                 changes_table, v_columns, v_columns, changes_table)
    USING v_record;
  RETURN NEW;
END;
$$;

-- ---- attendance_registers -------------------------------------------------------------------

ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_period_check"
  CHECK ("period" BETWEEN 1 AND 12);

ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_daily_period_check"
  CHECK ("mode" <> 'daily' OR "period" = 1);

ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_amended_check"
  CHECK (("last_amended_by" IS NULL) = ("last_amended_at" IS NULL));

-- Which section, day and period a register records, and who first submitted it, never change.
CREATE TRIGGER "attendance_registers_columns_immutable" BEFORE UPDATE ON "attendance_registers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'section_id', 'class_id', 'academic_year_id', 'date', 'period', 'mode', 'submitted_by',
    'submitted_at', 'source');

CREATE TRIGGER "attendance_registers_no_delete" BEFORE DELETE ON "attendance_registers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_registers_no_truncate" BEFORE TRUNCATE ON "attendance_registers"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_registers_school_id_immutable" BEFORE UPDATE ON "attendance_registers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_marks -----------------------------------------------------------------------

-- Rule 14's key as a real constraint, so slice 11's register upsert can name it
-- (INSERT ... ON CONFLICT ON CONSTRAINT attendance_marks_natural_key, plan §4.6). Same name, same
-- columns: the Prisma diff still reads it as the @@unique.
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_natural_key"
  UNIQUE USING INDEX "attendance_marks_natural_key";

ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Which child, register, day and period a mark records never change; status, note and
-- arrived_at do.
CREATE TRIGGER "attendance_marks_columns_immutable" BEFORE UPDATE ON "attendance_marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'register_id', 'enrolment_id', 'date', 'period', 'created_at');

-- R122: every status or note change writes attendance_mark_changes, with a reason.
CREATE TRIGGER "attendance_marks_history" BEFORE UPDATE ON "attendance_marks"
  FOR EACH ROW EXECUTE FUNCTION asms_record_change(
    'attendance_mark_changes', 'mark_id', 'reason_required', 'status', 'note');

-- R131: any mark write bumps its section-day summary's version, creating the row on first write.
-- Statement-level with a transition table (one upsert per statement, however many marks); two
-- triggers because a transition table allows one event per trigger. DISTINCT ON keeps one row per
-- section-day, so a statement never updates a summary row twice.
CREATE FUNCTION asms_attendance_summary_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO attendance_daily_summary
    (school_id, section_id, class_id, academic_year_id, date, mode)
  SELECT DISTINCT ON (r.school_id, r.section_id, r.date)
         r.school_id, r.section_id, r.class_id, r.academic_year_id, r.date, r.mode
    FROM changed_marks m
    JOIN attendance_registers r ON r.school_id = m.school_id AND r.id = m.register_id
   ORDER BY r.school_id, r.section_id, r.date, r.period
  ON CONFLICT (school_id, section_id, date)
  DO UPDATE SET version = attendance_daily_summary.version + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "attendance_marks_summary_bump_insert" AFTER INSERT ON "attendance_marks"
  REFERENCING NEW TABLE AS changed_marks
  FOR EACH STATEMENT EXECUTE FUNCTION asms_attendance_summary_bump();

CREATE TRIGGER "attendance_marks_summary_bump_update" AFTER UPDATE ON "attendance_marks"
  REFERENCING NEW TABLE AS changed_marks
  FOR EACH STATEMENT EXECUTE FUNCTION asms_attendance_summary_bump();

CREATE TRIGGER "attendance_marks_no_delete" BEFORE DELETE ON "attendance_marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_marks_no_truncate" BEFORE TRUNCATE ON "attendance_marks"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_marks_school_id_immutable" BEFORE UPDATE ON "attendance_marks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_mark_changes (append-only) --------------------------------------------------

ALTER TABLE "attendance_mark_changes" ADD CONSTRAINT "attendance_mark_changes_reason_check"
  CHECK ("reason" <> '');

ALTER TABLE "attendance_mark_changes" ADD CONSTRAINT "attendance_mark_changes_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "attendance_mark_changes_append_only" BEFORE UPDATE OR DELETE ON "attendance_mark_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "attendance_mark_changes_no_truncate" BEFORE TRUNCATE ON "attendance_mark_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "attendance_mark_changes_school_id_immutable" BEFORE UPDATE ON "attendance_mark_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_arrivals (append-only) ------------------------------------------------------

CREATE TRIGGER "attendance_arrivals_append_only" BEFORE UPDATE OR DELETE ON "attendance_arrivals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "attendance_arrivals_no_truncate" BEFORE TRUNCATE ON "attendance_arrivals"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "attendance_arrivals_school_id_immutable" BEFORE UPDATE ON "attendance_arrivals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_alerts ----------------------------------------------------------------------

ALTER TABLE "attendance_alerts" ADD CONSTRAINT "attendance_alerts_seq_check" CHECK ("seq" >= 1);

ALTER TABLE "attendance_alerts" ADD CONSTRAINT "attendance_alerts_cancelled_check"
  CHECK (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL));

CREATE TRIGGER "attendance_alerts_columns_immutable" BEFORE UPDATE ON "attendance_alerts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'enrolment_id', 'student_id', 'date', 'kind', 'seq', 'created_at');

-- pending -> sent | cancelled; sent and cancelled are final (an update that changes nothing but
-- updated_at passes).
CREATE FUNCTION asms_attendance_alert_status_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'a sent or cancelled attendance alert is final'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'attendance_alerts_status_final',
            DETAIL = 'constraint: attendance_alerts_status_final',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "attendance_alerts_status_final" BEFORE UPDATE ON "attendance_alerts"
  FOR EACH ROW EXECUTE FUNCTION asms_attendance_alert_status_final();

CREATE TRIGGER "attendance_alerts_no_delete" BEFORE DELETE ON "attendance_alerts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_alerts_no_truncate" BEFORE TRUNCATE ON "attendance_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_alerts_school_id_immutable" BEFORE UPDATE ON "attendance_alerts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_day_status ------------------------------------------------------------------

ALTER TABLE "attendance_day_status" ADD CONSTRAINT "attendance_day_status_periods_check"
  CHECK (
    "periods_recorded" BETWEEN 1 AND 12
    AND "periods_present" >= 0 AND "periods_late" >= 0
    AND "periods_absent" >= 0 AND "periods_leave" >= 0
    AND "periods_present" + "periods_late" + "periods_absent" + "periods_leave" = "periods_recorded"
  );

CREATE TRIGGER "attendance_day_status_columns_immutable" BEFORE UPDATE ON "attendance_day_status"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'enrolment_id', 'student_id', 'section_id', 'date');

CREATE TRIGGER "attendance_day_status_no_delete" BEFORE DELETE ON "attendance_day_status"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_day_status_no_truncate" BEFORE TRUNCATE ON "attendance_day_status"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_day_status_school_id_immutable" BEFORE UPDATE ON "attendance_day_status"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- attendance_daily_summary ---------------------------------------------------------------

ALTER TABLE "attendance_daily_summary" ADD CONSTRAINT "attendance_daily_summary_counts_check"
  CHECK (
    "registers_expected" >= 0 AND "registers_recorded" >= 0 AND "roster_count" >= 0
    AND "present" >= 0 AND "absent" >= 0 AND "late" >= 0 AND "on_leave" >= 0 AND "partial" >= 0
  );

-- Stale iff computed_version <> version; the worker never records a version it has not read.
ALTER TABLE "attendance_daily_summary" ADD CONSTRAINT "attendance_daily_summary_version_check"
  CHECK ("version" >= 1 AND "computed_version" >= 0 AND "computed_version" <= "version");

CREATE TRIGGER "attendance_daily_summary_columns_immutable" BEFORE UPDATE ON "attendance_daily_summary"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'section_id', 'class_id', 'academic_year_id', 'date');

CREATE TRIGGER "attendance_daily_summary_no_delete" BEFORE DELETE ON "attendance_daily_summary"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_daily_summary_no_truncate" BEFORE TRUNCATE ON "attendance_daily_summary"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "attendance_daily_summary_school_id_immutable" BEFORE UPDATE ON "attendance_daily_summary"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- staff_attendance (slice 12) ------------------------------------------------------------

ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "staff_attendance_columns_immutable" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'date');

-- R133: every status or note change writes staff_attendance_changes, with a reason.
CREATE TRIGGER "staff_attendance_history" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_record_change(
    'staff_attendance_changes', 'staff_attendance_id', 'reason_required', 'status', 'note');

-- R134: nobody marks or amends their own attendance, principals included. Refused when the row's
-- marked_by is a login of the same staff member, or (on a change) when the transaction's acting
-- user (asms.actor_user_id) is.
CREATE FUNCTION asms_staff_attendance_not_self() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor text := NULLIF(current_setting('asms.actor_user_id', true), '');
BEGIN
  IF EXISTS (SELECT 1 FROM users u
              WHERE u.school_id = NEW.school_id AND u.id = NEW.marked_by AND u.staff_id = NEW.staff_id)
     OR (TG_OP = 'UPDATE'
         AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
         AND v_actor ~ '^[1-9][0-9]{0,18}$'
         AND EXISTS (SELECT 1 FROM users u
                      WHERE u.school_id = NEW.school_id AND u.id = v_actor::bigint
                        AND u.staff_id = NEW.staff_id)) THEN
    RAISE EXCEPTION 'nobody marks their own staff attendance'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'staff_attendance_not_self',
            DETAIL = 'constraint: staff_attendance_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "staff_attendance_not_self" BEFORE INSERT OR UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_staff_attendance_not_self();

CREATE TRIGGER "staff_attendance_no_delete" BEFORE DELETE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_attendance_no_truncate" BEFORE TRUNCATE ON "staff_attendance"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_attendance_school_id_immutable" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- staff_attendance_changes (append-only) -------------------------------------------------

ALTER TABLE "staff_attendance_changes" ADD CONSTRAINT "staff_attendance_changes_reason_check"
  CHECK ("reason" <> '');

ALTER TABLE "staff_attendance_changes" ADD CONSTRAINT "staff_attendance_changes_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "staff_attendance_changes_append_only" BEFORE UPDATE OR DELETE ON "staff_attendance_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "staff_attendance_changes_no_truncate" BEFORE TRUNCATE ON "staff_attendance_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "staff_attendance_changes_school_id_immutable" BEFORE UPDATE ON "staff_attendance_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- diary_entries (slice 13) ---------------------------------------------------------------

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_topic_check"
  CHECK ("topic" = btrim("topic") AND "topic" <> '');

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_topic_no_id_check"
  CHECK ("topic" !~ '[0-9]{13}' AND "topic" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_assignment_no_id_check"
  CHECK ("assignment" !~ '[0-9]{13}' AND "assignment" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_learning_outcome_no_id_check"
  CHECK ("learning_outcome" !~ '[0-9]{13}' AND "learning_outcome" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_due_on_check"
  CHECK ("due_on" IS NULL OR "due_on" >= "date");

-- The staged-upload rules (slice 6): key, mime and size together, the same key shape, types and cap.
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_attachment_check"
  CHECK (
    ("attachment_object_key" IS NULL) = ("attachment_mime" IS NULL)
    AND ("attachment_object_key" IS NULL) = ("attachment_size_bytes" IS NULL)
    AND ("attachment_object_key" IS NULL OR (
      "attachment_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$')
      AND "attachment_mime" IN ('image/jpeg', 'image/png', 'application/pdf')
      AND "attachment_size_bytes" BETWEEN 1 AND 5242880))
  );

-- A staged object is consumed once (contracts/slice-13.md §10 item 1). A replaced attachment's key
-- stays referenced by diary_entry_changes.old_attachment_object_key, never by a second entry.
CREATE UNIQUE INDEX "diary_entries_attachment_object_key_key"
  ON "diary_entries" ("school_id", "attachment_object_key")
  WHERE "attachment_object_key" IS NOT NULL;

CREATE TRIGGER "diary_entries_columns_immutable" BEFORE UPDATE ON "diary_entries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'section_id', 'class_id', 'academic_year_id', 'date', 'subject_id', 'author_staff_id',
    'created_at');

-- An edit of the five editable fields writes diary_entry_changes; the reason is optional here
-- (plan §4.6: the service demands one after the window).
CREATE TRIGGER "diary_entries_history" BEFORE UPDATE ON "diary_entries"
  FOR EACH ROW EXECUTE FUNCTION asms_record_change(
    'diary_entry_changes', 'diary_entry_id', 'reason_optional', 'topic', 'assignment',
    'learning_outcome', 'due_on', 'attachment_object_key');

CREATE TRIGGER "diary_entries_no_delete" BEFORE DELETE ON "diary_entries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "diary_entries_no_truncate" BEFORE TRUNCATE ON "diary_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "diary_entries_school_id_immutable" BEFORE UPDATE ON "diary_entries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- diary_entry_changes (append-only) ------------------------------------------------------

ALTER TABLE "diary_entry_changes" ADD CONSTRAINT "diary_entry_changes_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "diary_entry_changes_append_only" BEFORE UPDATE OR DELETE ON "diary_entry_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "diary_entry_changes_no_truncate" BEFORE TRUNCATE ON "diary_entry_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "diary_entry_changes_school_id_immutable" BEFORE UPDATE ON "diary_entry_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- remarks (slice 13) ---------------------------------------------------------------------

ALTER TABLE "remarks" ADD CONSTRAINT "remarks_text_check"
  CHECK ("text" = btrim("text") AND "text" <> '');

ALTER TABLE "remarks" ADD CONSTRAINT "remarks_text_no_id_check"
  CHECK ("text" !~ '[0-9]{13}' AND "text" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "remarks" ADD CONSTRAINT "remarks_supersedes_self_check"
  CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id");

-- A correction carries its own reason; an original has none (contracts/slice-13.md §10 item 3).
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_correction_check"
  CHECK (("supersedes_id" IS NULL) = ("correction_reason" IS NULL));

ALTER TABLE "remarks" ADD CONSTRAINT "remarks_correction_reason_no_id_check"
  CHECK ("correction_reason" !~ '[0-9]{13}' AND "correction_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R141: a chain, never a tree. One successor per remark.
CREATE UNIQUE INDEX "remarks_supersedes_id_key" ON "remarks" ("school_id", "supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;

-- A remark is never edited: everything but superseded_at is frozen, and superseded_at is written
-- once (remarks_superseded_at_frozen), only by remarks_mark_superseded.
CREATE TRIGGER "remarks_columns_immutable" BEFORE UPDATE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'enrolment_id', 'student_id', 'author_staff_id', 'subject_id', 'date', 'category', 'text',
    'visibility', 'supersedes_id', 'correction_reason', 'created_at');

CREATE TRIGGER "remarks_superseded_at_frozen" BEFORE UPDATE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at');

-- superseded_at is null on a new remark and is set only while a successor names the row.
CREATE FUNCTION asms_remark_superseded_by_successor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.superseded_at IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.superseded_at IS NOT NULL AND OLD.superseded_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM remarks s
                          WHERE s.school_id = NEW.school_id AND s.supersedes_id = NEW.id)) THEN
    RAISE EXCEPTION 'a remark is superseded only by a correction that names it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'remarks_superseded_by_successor',
            DETAIL = 'constraint: remarks_superseded_by_successor',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'superseded_at';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "remarks_superseded_by_successor" BEFORE INSERT OR UPDATE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_remark_superseded_by_successor();

-- The successor's insert stamps its predecessor (the partial unique index makes this happen once).
CREATE FUNCTION asms_remark_mark_superseded() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE remarks SET superseded_at = NEW.created_at
   WHERE school_id = NEW.school_id AND id = NEW.supersedes_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "remarks_mark_superseded" AFTER INSERT ON "remarks"
  FOR EACH ROW WHEN (NEW.supersedes_id IS NOT NULL)
  EXECUTE FUNCTION asms_remark_mark_superseded();

CREATE TRIGGER "remarks_no_delete" BEFORE DELETE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "remarks_no_truncate" BEFORE TRUNCATE ON "remarks"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "remarks_school_id_immutable" BEFORE UPDATE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
