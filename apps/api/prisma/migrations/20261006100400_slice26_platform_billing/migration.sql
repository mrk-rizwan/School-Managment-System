-- Slice 26 (wave I groundwork): the five non-tenant platform billing tables (phase-3-financial.md
-- §3.7, §4 "Platform billing", R219-R224).
-- Generated DDL first (prisma migrate diff), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('issued', 'paid', 'void');

-- CreateTable
CREATE TABLE "platform_plans" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "min_students" INTEGER NOT NULL,
    "max_students" INTEGER,
    "monthly_price" INTEGER NOT NULL,
    "sms_allowance" INTEGER NOT NULL,
    "status" "plan_status" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "plan_id" BIGINT NOT NULL,
    "started_on" DATE NOT NULL,
    "ended_on" DATE,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "assigned_by" BIGINT,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_school_metrics" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "active_students" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_school_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "invoice_no" VARCHAR(14) NOT NULL,
    "year_month" CHAR(7) NOT NULL,
    "plan_id" BIGINT NOT NULL,
    "student_count" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'issued',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overdue_at" TIMESTAMPTZ(3),
    "suspension_eligible_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_payments" (
    "id" BIGSERIAL NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "received_on" DATE NOT NULL,
    "reference" VARCHAR(60) NOT NULL,
    "recorded_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_plans_status_min_students_idx" ON "platform_plans"("status", "min_students");

-- CreateIndex
CREATE INDEX "platform_subscriptions_school_id_started_on_idx" ON "platform_subscriptions"("school_id", "started_on");

-- CreateIndex
CREATE INDEX "platform_subscriptions_plan_id_ended_on_idx" ON "platform_subscriptions"("plan_id", "ended_on");

-- CreateIndex
CREATE INDEX "platform_subscriptions_assigned_by_idx" ON "platform_subscriptions"("assigned_by");

-- CreateIndex
CREATE UNIQUE INDEX "platform_school_metrics_school_id_day_key" ON "platform_school_metrics"("school_id", "day");

-- CreateIndex
CREATE INDEX "platform_invoices_school_id_year_month_idx" ON "platform_invoices"("school_id", "year_month");

-- CreateIndex
CREATE INDEX "platform_invoices_status_due_on_idx" ON "platform_invoices"("status", "due_on");

-- CreateIndex
CREATE INDEX "platform_invoices_plan_id_idx" ON "platform_invoices"("plan_id");

-- CreateIndex
CREATE INDEX "platform_invoices_voided_by_idx" ON "platform_invoices"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_invoice_no_key" ON "platform_invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "platform_payments_recorded_by_idx" ON "platform_payments"("recorded_by");

-- CreateIndex
CREATE UNIQUE INDEX "platform_payments_invoice_id_key" ON "platform_payments"("invoice_id");

-- AddForeignKey
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_school_metrics" ADD CONSTRAINT "platform_school_metrics_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform_invoices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.7, §4 "Platform billing", R219-R224).
-- Generated SQL above (prisma migrate diff) reviewed: no drift lines. The five tables are
-- non-tenant (NON_TENANT_MODELS in src/repositories/query-guard.ts): no school_id immutability
-- trigger is required, but the money discipline of rule 0.19 holds. Every object here is listed in
-- test/guardrails/schema-checks.ts (WAVE_I_OBJECTS).
-- =============================================================================================

-- ---- platform_plans (R219) ---------------------------------------------------------------------

ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_band_check"
  CHECK ("min_students" >= 0 AND ("max_students" IS NULL OR "max_students" >= "min_students"));

ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_money_check"
  CHECK ("monthly_price" >= 0 AND "sms_allowance" >= 0);

ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_archived_check"
  CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));

-- R219: active bands never overlap. Inclusive; a null max is unbounded. SQLSTATE 23P01, the name
-- in the message (PLAN_BAND_OVERLAPS).
ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_band_excl"
  EXCLUDE USING gist (int4range("min_students", "max_students", '[]') WITH &&)
  WHERE ("status" = 'active');

-- Bands are frozen; an archived plan is frozen whole.
CREATE TRIGGER "platform_plans_columns_immutable" BEFORE UPDATE ON "platform_plans"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('min_students', 'max_students', 'created_at');

CREATE TRIGGER "platform_plans_archived_frozen" BEFORE UPDATE ON "platform_plans"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'archived_at', 'status', 'name', 'monthly_price', 'sms_allowance');

CREATE TRIGGER "platform_plans_no_delete" BEFORE DELETE ON "platform_plans"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_plans_no_truncate" BEFORE TRUNCATE ON "platform_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- ---- platform_subscriptions (R220, R223) -------------------------------------------------------

ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_dates_check"
  CHECK ("ended_on" IS NULL OR "ended_on" >= "started_on");

-- A pin is a manual override and says why.
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_pinned_check"
  CHECK (NOT "pinned" OR ("reason" IS NOT NULL AND "assigned_by" IS NOT NULL));

ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_reason_check"
  CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND "reason" <> ''));

ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live subscription per school.
CREATE UNIQUE INDEX "platform_subscriptions_live_key" ON "platform_subscriptions" ("school_id")
  WHERE "ended_on" IS NULL;

-- Only ended_on moves, once: the history of a school's tiers.
CREATE TRIGGER "platform_subscriptions_columns_immutable" BEFORE UPDATE ON "platform_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'school_id', 'plan_id', 'started_on', 'pinned', 'assigned_by', 'reason', 'created_at');

CREATE TRIGGER "platform_subscriptions_ended_on_frozen" BEFORE UPDATE ON "platform_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_on');

CREATE TRIGGER "platform_subscriptions_no_delete" BEFORE DELETE ON "platform_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_subscriptions_no_truncate" BEFORE TRUNCATE ON "platform_subscriptions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- ---- platform_school_metrics (named exception 6's shape) ---------------------------------------

ALTER TABLE "platform_school_metrics" ADD CONSTRAINT "platform_school_metrics_active_students_check"
  CHECK ("active_students" >= 0);

-- A re-run rewrites the day's count; which school and day it describes never changes.
CREATE TRIGGER "platform_school_metrics_columns_immutable" BEFORE UPDATE ON "platform_school_metrics"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'day');

CREATE TRIGGER "platform_school_metrics_no_delete" BEFORE DELETE ON "platform_school_metrics"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_school_metrics_no_truncate" BEFORE TRUNCATE ON "platform_school_metrics"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- ---- platform_invoices (R220, R221) ------------------------------------------------------------

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_invoice_no_check"
  CHECK ("invoice_no" ~ '^INV-[0-9]{4}-[0-9]{5}$');

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_year_month_check"
  CHECK ("year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_amounts_check"
  CHECK ("amount" >= 0 AND "student_count" >= 0);

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_paid_check"
  CHECK (("status" = 'paid') = ("paid_at" IS NOT NULL));

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_voided_check"
  CHECK (
    ("status" = 'void') = ("voided_at" IS NOT NULL)
    AND ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R220: one non-void invoice per school per month (the monthly run is idempotent on it).
CREATE UNIQUE INDEX "platform_invoices_month_key" ON "platform_invoices" ("school_id", "year_month")
  WHERE "status" <> 'void';

-- issued -> paid | void.
CREATE TRIGGER "platform_invoices_status_transition" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('issued:paid', 'issued:void');

CREATE TRIGGER "platform_invoices_columns_immutable" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'school_id', 'invoice_no', 'year_month', 'plan_id', 'student_count', 'amount', 'due_on',
    'issued_at');

CREATE TRIGGER "platform_invoices_paid_frozen" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('paid_at');

CREATE TRIGGER "platform_invoices_voided_frozen" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

CREATE TRIGGER "platform_invoices_overdue_frozen" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('overdue_at');

CREATE TRIGGER "platform_invoices_suspension_eligible_frozen" BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('suspension_eligible_at');

CREATE TRIGGER "platform_invoices_no_delete" BEFORE DELETE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_invoices_no_truncate" BEFORE TRUNCATE ON "platform_invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- ---- platform_payments (append-only) -----------------------------------------------------------

ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_amount_check"
  CHECK ("amount" > 0);

ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_reference_check"
  CHECK ("reference" = btrim("reference") AND "reference" <> '');

ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_reference_no_id_check"
  CHECK ("reference" !~ '[0-9]{13}' AND "reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "platform_payments_columns_immutable" BEFORE UPDATE ON "platform_payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'invoice_id', 'amount', 'received_on', 'reference', 'recorded_by', 'created_at');

CREATE TRIGGER "platform_payments_no_delete" BEFORE DELETE ON "platform_payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_payments_no_truncate" BEFORE TRUNCATE ON "platform_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();
