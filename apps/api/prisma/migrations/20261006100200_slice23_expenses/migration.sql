-- Slice 23 (wave I groundwork): expenses (phase-3-financial.md §3.2, §4 "Expenses", R206-R208,
-- R244), and the payment_method enum that slice 20's payments reuse.
-- Generated DDL first (prisma migrate diff), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('cash', 'bank_transfer', 'jazzcash', 'easypaisa', 'carried_forward');

-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('recorded', 'pending_approval', 'approved', 'rejected', 'voided');

-- CreateTable
CREATE TABLE "expenses" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "expense_no" INTEGER NOT NULL,
    "category" "expense_category" NOT NULL,
    "amount" INTEGER NOT NULL,
    "spent_on" DATE NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "payee" VARCHAR(100),
    "method" "payment_method" NOT NULL,
    "reference" VARCHAR(60),
    "receipt_object_key" VARCHAR(64),
    "receipt_mime" VARCHAR(32),
    "receipt_size_bytes" INTEGER,
    "status" "expense_status" NOT NULL,
    "recorded_by" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_school_id_spent_on_idx" ON "expenses"("school_id", "spent_on");

-- CreateIndex
CREATE INDEX "expenses_school_id_status_recorded_at_idx" ON "expenses"("school_id", "status", "recorded_at");

-- CreateIndex
CREATE INDEX "expenses_school_id_category_spent_on_idx" ON "expenses"("school_id", "category", "spent_on");

-- CreateIndex
CREATE INDEX "expenses_school_id_recorded_by_spent_on_idx" ON "expenses"("school_id", "recorded_by", "spent_on");

-- CreateIndex
CREATE INDEX "expenses_school_id_decided_by_idx" ON "expenses"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "expenses_school_id_voided_by_idx" ON "expenses"("school_id", "voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_school_id_id_key" ON "expenses"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_school_id_expense_no_key" ON "expenses"("school_id", "expense_no");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_fkey" FOREIGN KEY ("school_id", "recorded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.2, §4 "Expenses", R206-R208, R244).
-- Generated SQL above (prisma migrate diff) reviewed: no drift lines. Every object here is listed
-- in test/guardrails/schema-checks.ts (WAVE_I_OBJECTS). Trigger functions raise SQLSTATE 23514
-- with DETAIL 'constraint: <name>'. The expense number comes from the school's 'expense_no'
-- counter (seeded with the school since slice 18), advanced with UPDATE ... RETURNING.
-- =============================================================================================

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expense_no_check"
  CHECK ("expense_no" > 0);

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_check"
  CHECK ("amount" > 0);

-- carried_forward is a payment-only method (A8).
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_method_check"
  CHECK ("method" <> 'carried_forward');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_description_check"
  CHECK ("description" = btrim("description") AND "description" <> '');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payee_check"
  CHECK ("payee" IS NULL OR ("payee" = btrim("payee") AND "payee" <> ''));

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reference_check"
  CHECK ("reference" IS NULL OR ("reference" = btrim("reference") AND "reference" <> ''));

-- R208: nothing identity-shaped in description, payee or reference (or the reasons).
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_description_no_id_check"
  CHECK ("description" !~ '[0-9]{13}' AND "description" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payee_no_id_check"
  CHECK ("payee" !~ '[0-9]{13}' AND "payee" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reference_no_id_check"
  CHECK ("reference" !~ '[0-9]{13}' AND "reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decision_reason_no_id_check"
  CHECK ("decision_reason" !~ '[0-9]{13}' AND "decision_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- The receipt image: key, mime and size together; the staged-upload key shape of the school.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_check"
  CHECK (
    ("receipt_object_key" IS NULL) = ("receipt_mime" IS NULL)
    AND ("receipt_object_key" IS NULL) = ("receipt_size_bytes" IS NULL)
    AND (
      "receipt_object_key" IS NULL
      OR (
        "receipt_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$')
        AND "receipt_mime" IN ('image/jpeg', 'image/png', 'application/pdf')
        AND "receipt_size_bytes" BETWEEN 1 AND 5242880
      )
    )
  );

CREATE UNIQUE INDEX "expenses_receipt_object_key_key" ON "expenses" ("school_id", "receipt_object_key")
  WHERE "receipt_object_key" IS NOT NULL;

-- Decided iff approved or rejected (an approved expense keeps its decision when voided); a
-- rejection says why.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decided_check"
  CHECK (
    ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" NOT IN ('approved', 'rejected') OR "decided_at" IS NOT NULL)
    AND ("status" NOT IN ('recorded', 'pending_approval') OR "decided_at" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
  );

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_check"
  CHECK (
    ("status" = 'voided') = ("voided_at" IS NOT NULL)
    AND ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

-- R206: self-approved is the recorder's own approval (a principal's, trigger expenses_not_self).
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_self_approved_check"
  CHECK (NOT "self_approved" OR ("decided_by" = "recorded_by" AND "status" IN ('approved', 'voided')));

-- recorded -> approved | rejected | voided; pending_approval -> approved | rejected | voided;
-- approved -> voided.
CREATE TRIGGER "expenses_status_transition" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'recorded:approved', 'recorded:rejected', 'recorded:voided',
    'pending_approval:approved', 'pending_approval:rejected', 'pending_approval:voided',
    'approved:voided');

CREATE TRIGGER "expenses_columns_immutable" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('expense_no', 'recorded_by', 'recorded_at');

-- PATCH edits the recorder's open expense; a decided or voided expense is history.
CREATE TRIGGER "expenses_content_frozen" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'recorded,pending_approval', 'category', 'amount', 'spent_on', 'description', 'payee',
    'method', 'reference');

CREATE TRIGGER "expenses_receipt_frozen" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'receipt_object_key', 'receipt_mime', 'receipt_size_bytes');

CREATE TRIGGER "expenses_decided_frozen" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'decided_at', 'decided_by', 'decision_reason', 'self_approved');

CREATE TRIGGER "expenses_voided_frozen" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

-- R244, rule 0.21: nobody approves or rejects their own expense, and nobody voids their own once
-- approved, except a principal's self-approval on record: a recorder who decides their own row
-- must be a principal (a live principal role; the role is read, not the count) writing
-- self_approved and approved, and only such a self-approved expense may be voided by its
-- recorder after approval.
CREATE FUNCTION asms_expense_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refuse boolean := false;
BEGIN
  IF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.recorded_by
     AND (TG_OP = 'INSERT' OR OLD.decided_by IS NULL) THEN
    v_refuse := NOT (
      NEW.self_approved AND NEW.status = 'approved'
      AND EXISTS (SELECT 1 FROM user_roles ur
                   WHERE ur.school_id = NEW.school_id AND ur.user_id = NEW.decided_by
                     AND ur.system_role = 'principal' AND ur.ended_at IS NULL));
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'voided' AND OLD.status = 'approved'
     AND NEW.voided_by = NEW.recorded_by THEN
    v_refuse := v_refuse OR NOT (
      OLD.self_approved
      AND EXISTS (SELECT 1 FROM user_roles ur
                   WHERE ur.school_id = NEW.school_id AND ur.user_id = NEW.voided_by
                     AND ur.system_role = 'principal' AND ur.ended_at IS NULL));
  END IF;
  IF v_refuse THEN
    RAISE EXCEPTION 'nobody decides or voids their own approved expense'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'expenses_not_self',
            DETAIL = 'constraint: expenses_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expenses_not_self" BEFORE INSERT OR UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_expense_not_self();

CREATE TRIGGER "expenses_no_delete" BEFORE DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "expenses_no_truncate" BEFORE TRUNCATE ON "expenses"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "expenses_school_id_immutable" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
