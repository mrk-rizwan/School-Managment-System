-- Phase 3 groundwork (phase-3-financial.md §3.8, §4, §5.1): the school settings of §3.8, the
-- platform billing settings and school columns of §4, the two four- and three-column uniques
-- Phase 3's composite foreign keys target, and the SMS allow list widened to the fee types.
-- Generated DDL first (prisma migrate diff against the migrated database, the create-only
-- equivalent in a non-interactive shell), hand-written SQL after the marker.

-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "grace_days" SMALLINT NOT NULL DEFAULT 15,
ADD COLUMN     "invoice_counter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invoice_due_day" SMALLINT NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "school_settings" ADD COLUMN     "expense_approval_threshold" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "fee_cutoff_day" SMALLINT NOT NULL DEFAULT 15,
ADD COLUMN     "fee_reminder_days_before" SMALLINT NOT NULL DEFAULT 3,
ADD COLUMN     "late_fee_amount" INTEGER,
ADD COLUMN     "late_fee_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "late_fee_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "late_fee_grace_days" SMALLINT NOT NULL DEFAULT 7,
ADD COLUMN     "overdue_reminder_every_days" SMALLINT NOT NULL DEFAULT 14,
ADD COLUMN     "pay_day" SMALLINT NOT NULL DEFAULT 1,
ALTER COLUMN "sms_allowed_types" SET DEFAULT ARRAY['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice', 'fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected']::"message_type"[];

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "sms_cap_overridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "terminated_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_school_id_id_student_id_academic_year_id_key" ON "enrolments"("school_id", "id", "student_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_id_staff_id_key" ON "users"("school_id", "id", "staff_id");

-- =============================================================================================
-- Hand-written below this line. Every object here is listed in test/guardrails/schema-checks.ts
-- (PHASE_3_GROUNDWORK_OBJECTS).
-- =============================================================================================

-- ---- school_settings.sms_allowed_types (§1.1, register item 22) -------------------------------

-- The eligible set gains the five SMS-eligible fee types (packages/shared SMS_ELIGIBLE_TYPES, in
-- table order); fee_charged is eligible but not allowed by default.
ALTER TABLE "school_settings" DROP CONSTRAINT "school_settings_sms_allowed_types_check";
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_sms_allowed_types_check"
  CHECK (
    "sms_allowed_types" IS NOT NULL
    AND array_position("sms_allowed_types", NULL) IS NULL
    AND "sms_allowed_types" <@ ARRAY[
      'absence_alert', 'late_advice', 'attendance_corrected',
      'announcement_urgent', 'announcement_normal', 'holiday_notice',
      'fee_charged', 'fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected'
    ]::message_type[]
  );

-- Backfill: every existing school gets the four fee types the new default allows. They did not
-- exist before, so no school can have chosen to leave them out. Order follows the type table.
UPDATE "school_settings"
SET "sms_allowed_types" = "sms_allowed_types" || ARRAY(
  SELECT u.t FROM unnest(
    ARRAY['fee_due_reminder', 'fee_overdue', 'receipt_issued', 'payment_claim_rejected']::message_type[]
  ) WITH ORDINALITY AS u(t, n)
  WHERE NOT (u.t = ANY ("sms_allowed_types"))
  ORDER BY u.n
);

-- ---- school_settings: the fee, late-fee, expense and payroll settings (§3.8) -----------------

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_fee_cutoff_day_check"
  CHECK ("fee_cutoff_day" BETWEEN 1 AND 28);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_late_fee_grace_days_check"
  CHECK ("late_fee_grace_days" BETWEEN 0 AND 30);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_late_fee_amount_check"
  CHECK ("late_fee_amount" IS NULL OR "late_fee_amount" > 0);

-- R178: the amount is required while late fees are on, and switching them on stamps the time.
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_late_fee_enabled_check"
  CHECK (NOT "late_fee_enabled" OR ("late_fee_amount" IS NOT NULL AND "late_fee_enabled_at" IS NOT NULL));

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_expense_approval_threshold_check"
  CHECK ("expense_approval_threshold" >= 0);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_pay_day_check"
  CHECK ("pay_day" BETWEEN 1 AND 28);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_fee_reminder_days_before_check"
  CHECK ("fee_reminder_days_before" BETWEEN 0 AND 10);

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_overdue_reminder_every_days_check"
  CHECK ("overdue_reminder_every_days" BETWEEN 7 AND 30);

-- ---- platform_settings (non-tenant, §4) --------------------------------------------------------

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_invoice_due_day_check"
  CHECK ("invoice_due_day" BETWEEN 1 AND 28);

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_grace_days_check"
  CHECK ("grace_days" BETWEEN 0 AND 90);

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_invoice_counter_check"
  CHECK ("invoice_counter" >= 0);

-- ---- schools.terminated_at (non-tenant, §4, R224) ---------------------------------------------

-- Backfill before the CHECK: the time of the status change to terminated from the platform audit
-- log (school.status_changed, metadata.to), else the row's last update.
UPDATE "schools" s
SET "terminated_at" = COALESCE(
  (SELECT max(a."created_at") FROM "platform_audit_log" a
    WHERE a."school_id" = s."id" AND a."action" = 'school.status_changed'
      AND a."metadata" ->> 'to' = 'terminated'),
  s."updated_at")
WHERE s."status" = 'terminated' AND s."terminated_at" IS NULL;

ALTER TABLE "schools" ADD CONSTRAINT "schools_terminated_at_check"
  CHECK (("status" = 'terminated') = ("terminated_at" IS NOT NULL));
