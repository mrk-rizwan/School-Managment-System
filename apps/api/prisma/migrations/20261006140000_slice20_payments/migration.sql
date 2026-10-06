-- Slice 20 (wave J groundwork): payments, payment allocations, receipts and their lines, payment
-- reversals (void, refund, refund reversal, carry-forward) and cash handovers
-- (phase-3-financial.md §3.2, §3.4, §3.5, §4 "Payments", R187-R195, R228-R232, R236, R251).
-- Generated DDL first (prisma migrate diff, the create-only equivalent in a non-interactive
-- shell), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('verified', 'voided');

-- CreateEnum
CREATE TYPE "reversal_kind" AS ENUM ('void', 'refund', 'refund_reversal', 'carried_forward');

-- CreateEnum
CREATE TYPE "handover_status" AS ENUM ('open', 'confirmed');

-- CreateEnum
CREATE TYPE "shortfall_resolution" AS ENUM ('recovered', 'written_off', 'explained_by_void');

-- CreateTable
CREATE TABLE "payments" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "payer_guardian_id" BIGINT,
    "payer_name" VARCHAR(100),
    "method" "payment_method" NOT NULL,
    "amount" INTEGER NOT NULL,
    "unallocated_amount" INTEGER NOT NULL DEFAULT 0,
    "received_on" DATE NOT NULL,
    "reference" VARCHAR(60),
    "carried_from_reversal_id" BIGINT,
    "recorded_by" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" BIGINT NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handover_id" BIGINT,
    "advance_for_student_id" BIGINT,
    "status" "payment_status" NOT NULL DEFAULT 'verified',
    "voided_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "payment_id" BIGINT NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "payment_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "receipt_no" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" BIGINT NOT NULL,
    "voided_at" TIMESTAMPTZ(3),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "receipt_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "charge_id" BIGINT,
    "fee_head_name" VARCHAR(60),
    "period" CHAR(7),
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reversals" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "payment_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "kind" "reversal_kind" NOT NULL,
    "reverses_id" BIGINT,
    "carried_to_payment_id" BIGINT,
    "amount" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" BIGINT NOT NULL,
    "approved_by" BIGINT,
    "refund_method" "payment_method",
    "refund_reference" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_handovers" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "collector_user_id" BIGINT NOT NULL,
    "collector_staff_id" BIGINT NOT NULL,
    "opened_by" BIGINT NOT NULL,
    "on_behalf" BOOLEAN NOT NULL DEFAULT false,
    "expected_amount" INTEGER NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(500),
    "status" "handover_status" NOT NULL DEFAULT 'open',
    "confirmed_by" BIGINT,
    "confirmed_at" TIMESTAMPTZ(3),
    "counted_amount" INTEGER,
    "shortfall_amount" INTEGER,
    "surplus_amount" INTEGER,
    "confirm_note" VARCHAR(500),
    "shortfall_resolution" "shortfall_resolution",
    "shortfall_resolved_at" TIMESTAMPTZ(3),
    "shortfall_resolved_by" BIGINT,
    "shortfall_resolution_reason" VARCHAR(500),
    "shortfall_expense_id" BIGINT,
    "shortfall_reversal_id" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_school_id_received_on_idx" ON "payments"("school_id", "received_on");

-- CreateIndex
CREATE INDEX "payments_school_id_payer_guardian_id_received_on_idx" ON "payments"("school_id", "payer_guardian_id", "received_on");

-- CreateIndex
CREATE INDEX "payments_school_id_recorded_by_received_on_idx" ON "payments"("school_id", "recorded_by", "received_on");

-- CreateIndex
CREATE INDEX "payments_school_id_handover_id_idx" ON "payments"("school_id", "handover_id", "recorded_by");

-- CreateIndex
CREATE INDEX "payments_school_id_status_received_on_idx" ON "payments"("school_id", "status", "received_on");

-- CreateIndex
CREATE INDEX "payments_school_id_advance_for_student_id_idx" ON "payments"("school_id", "advance_for_student_id");

-- CreateIndex
CREATE INDEX "payments_school_id_verified_by_idx" ON "payments"("school_id", "verified_by");

-- CreateIndex
CREATE INDEX "payments_school_id_academic_year_id_received_on_idx" ON "payments"("school_id", "academic_year_id", "received_on");

-- CreateIndex
CREATE INDEX "payments_school_id_carried_from_reversal_id_idx" ON "payments"("school_id", "carried_from_reversal_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_school_id_id_key" ON "payments"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_school_id_id_academic_year_id_key" ON "payments"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE INDEX "payment_allocations_school_id_payment_id_idx" ON "payment_allocations"("school_id", "payment_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "payment_allocations_school_id_charge_id_idx" ON "payment_allocations"("school_id", "charge_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE INDEX "payment_allocations_school_id_student_id_created_at_idx" ON "payment_allocations"("school_id", "student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_school_id_id_key" ON "payment_allocations"("school_id", "id");

-- CreateIndex
CREATE INDEX "receipts_school_id_issued_by_idx" ON "receipts"("school_id", "issued_by");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_school_id_id_key" ON "receipts"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_school_id_id_academic_year_id_key" ON "receipts"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_payment_key" ON "receipts"("school_id", "payment_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_number_key" ON "receipts"("school_id", "academic_year_id", "receipt_no");

-- CreateIndex
CREATE INDEX "receipt_lines_school_id_receipt_id_idx" ON "receipt_lines"("school_id", "receipt_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "receipt_lines_school_id_student_id_idx" ON "receipt_lines"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "receipt_lines_school_id_charge_id_idx" ON "receipt_lines"("school_id", "charge_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_lines_school_id_id_key" ON "receipt_lines"("school_id", "id");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_payment_id_idx" ON "payment_reversals"("school_id", "payment_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_reverses_id_idx" ON "payment_reversals"("school_id", "reverses_id", "payment_id");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_carried_to_payment_id_idx" ON "payment_reversals"("school_id", "carried_to_payment_id");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_requested_by_idx" ON "payment_reversals"("school_id", "requested_by");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_approved_by_idx" ON "payment_reversals"("school_id", "approved_by");

-- CreateIndex
CREATE INDEX "payment_reversals_school_id_kind_created_at_idx" ON "payment_reversals"("school_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversals_school_id_id_key" ON "payment_reversals"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversals_school_id_id_payment_id_key" ON "payment_reversals"("school_id", "id", "payment_id");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_status_opened_at_idx" ON "cash_handovers"("school_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_confirmed_by_idx" ON "cash_handovers"("school_id", "confirmed_by");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_collector_user_id_idx" ON "cash_handovers"("school_id", "collector_user_id", "collector_staff_id");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_opened_by_idx" ON "cash_handovers"("school_id", "opened_by");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_shortfall_resolved_by_idx" ON "cash_handovers"("school_id", "shortfall_resolved_by");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_shortfall_expense_id_idx" ON "cash_handovers"("school_id", "shortfall_expense_id");

-- CreateIndex
CREATE INDEX "cash_handovers_school_id_shortfall_reversal_id_idx" ON "cash_handovers"("school_id", "shortfall_reversal_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_handovers_school_id_id_key" ON "cash_handovers"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_handovers_school_id_id_collector_user_id_key" ON "cash_handovers"("school_id", "id", "collector_user_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_guardian_id_fkey" FOREIGN KEY ("school_id", "payer_guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_carried_from_reversal_id_fkey" FOREIGN KEY ("school_id", "carried_from_reversal_id") REFERENCES "payment_reversals"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_fkey" FOREIGN KEY ("school_id", "recorded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_fkey" FOREIGN KEY ("school_id", "verified_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_handover_id_fkey" FOREIGN KEY ("school_id", "handover_id", "recorded_by") REFERENCES "cash_handovers"("school_id", "id", "collector_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_advance_for_student_id_fkey" FOREIGN KEY ("school_id", "advance_for_student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("school_id", "payment_id", "academic_year_id") REFERENCES "payments"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_charge_id_fkey" FOREIGN KEY ("school_id", "charge_id", "academic_year_id", "student_id") REFERENCES "charges"("school_id", "id", "academic_year_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("school_id", "payment_id", "academic_year_id") REFERENCES "payments"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_issued_by_fkey" FOREIGN KEY ("school_id", "issued_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_fkey" FOREIGN KEY ("school_id", "receipt_id", "academic_year_id") REFERENCES "receipts"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_charge_id_fkey" FOREIGN KEY ("school_id", "charge_id", "academic_year_id", "student_id") REFERENCES "charges"("school_id", "id", "academic_year_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_id_fkey" FOREIGN KEY ("school_id", "payment_id", "academic_year_id") REFERENCES "payments"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reverses_id_fkey" FOREIGN KEY ("school_id", "reverses_id", "payment_id") REFERENCES "payment_reversals"("school_id", "id", "payment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_carried_to_payment_id_fkey" FOREIGN KEY ("school_id", "carried_to_payment_id") REFERENCES "payments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_requested_by_fkey" FOREIGN KEY ("school_id", "requested_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_approved_by_fkey" FOREIGN KEY ("school_id", "approved_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_collector_user_id_fkey" FOREIGN KEY ("school_id", "collector_user_id", "collector_staff_id") REFERENCES "users"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_opened_by_fkey" FOREIGN KEY ("school_id", "opened_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_confirmed_by_fkey" FOREIGN KEY ("school_id", "confirmed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_shortfall_resolved_by_fkey" FOREIGN KEY ("school_id", "shortfall_resolved_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_shortfall_expense_id_fkey" FOREIGN KEY ("school_id", "shortfall_expense_id") REFERENCES "expenses"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_shortfall_reversal_id_fkey" FOREIGN KEY ("school_id", "shortfall_reversal_id") REFERENCES "payment_reversals"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.1, §3.2, §3.4, §3.5, §4 "Payments",
-- R187-R195, R228-R232, R236, R251). Generated SQL above (prisma migrate diff) reviewed: no drift
-- lines. Every object here is listed in test/guardrails/schema-checks.ts (WAVE_J_OBJECTS).
-- Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
--
-- Lock order (R236), kept by every trigger here: the payment rows by id, then their charges by
-- id; the receipt counter is the service's, always last.
-- =============================================================================================

-- ---- shared ------------------------------------------------------------------------------------

-- The user's own guardian record, merge-resolved (asms_guardian_merge_family), is p_guardian_id:
-- a payment whose payer is the recorder, or a reversal of one, is the actor's own money (R232).
CREATE FUNCTION asms_user_is_guardian(p_school_id bigint, p_user_id bigint, p_guardian_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT p_guardian_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM users u
    CROSS JOIN LATERAL asms_guardian_merge_family(p_school_id, u.guardian_id) AS fam(id)
    WHERE u.school_id = p_school_id
      AND u.id = p_user_id
      AND u.guardian_id IS NOT NULL
      AND fam.id = p_guardian_id
  );
$$;

-- ---- payments (R187, R189, R193, R232) ----------------------------------------------------------

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check"
  CHECK ("amount" > 0);

-- §3.2: the counter, maintained by the allocation and reversal triggers (23514 -> CONCURRENT_UPDATE
-- on a race, REFUND_EXCEEDS_UNALLOCATED on a refund).
ALTER TABLE "payments" ADD CONSTRAINT "payments_unallocated_amount_check"
  CHECK ("unallocated_amount" >= 0 AND "unallocated_amount" <= "amount");

ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_check"
  CHECK (num_nonnulls("payer_guardian_id", "payer_name") = 1);

ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_name_check"
  CHECK ("payer_name" IS NULL OR ("payer_name" = btrim("payer_name") AND "payer_name" <> ''));

ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_name_no_id_check"
  CHECK ("payer_name" !~ '[0-9]{13}' AND "payer_name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_check"
  CHECK ("reference" IS NULL OR ("reference" = btrim("reference") AND "reference" <> ''));

ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_no_id_check"
  CHECK ("reference" !~ '[0-9]{13}' AND "reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R187: a non-cash method carries the slip's reference.
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_required_check"
  CHECK ("method" NOT IN ('bank_transfer', 'jazzcash', 'easypaisa') OR "reference" IS NOT NULL);

-- R251: a carried-forward payment names the reversal that moved its money, and only it does.
ALTER TABLE "payments" ADD CONSTRAINT "payments_carried_forward_check"
  CHECK (("method" = 'carried_forward') = ("carried_from_reversal_id" IS NOT NULL));

-- §3.4: only cash is handed over.
ALTER TABLE "payments" ADD CONSTRAINT "payments_handover_cash_check"
  CHECK ("method" = 'cash' OR "handover_id" IS NULL);

ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_check"
  CHECK (("status" = 'voided') = ("voided_at" IS NOT NULL));

-- One carried-forward payment per carry-forward reversal.
CREATE UNIQUE INDEX "payments_carried_from_reversal_key" ON "payments" ("school_id", "carried_from_reversal_id")
  WHERE "carried_from_reversal_id" IS NOT NULL;

-- A payment is born verified, outside any handover, with everything unallocated; a
-- carried_forward one names a carry-forward reversal not yet linked to a payment
-- (payments_carried_from_check).
CREATE FUNCTION asms_payment_init() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.status <> 'verified' OR NEW.voided_at IS NOT NULL OR NEW.handover_id IS NOT NULL THEN
    v_refusal := 'payments_born_verified';
  ELSIF NEW.carried_from_reversal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_reversals r
    WHERE r.school_id = NEW.school_id AND r.id = NEW.carried_from_reversal_id
      AND r.kind = 'carried_forward' AND r.carried_to_payment_id IS NULL
  ) THEN
    v_refusal := 'payments_carried_from_check';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'a payment is born verified and unallocated (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  NEW.unallocated_amount := NEW.amount;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_unallocated_init" BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_init();

-- verified -> voided, by a void reversal only (payment_reversals_apply).
CREATE TRIGGER "payments_status_transition" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('verified:voided');

-- Rule 0.19: only status, unallocated_amount, voided_at, handover_id and advance_for_student_id
-- move.
CREATE TRIGGER "payments_columns_immutable" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'payer_guardian_id', 'payer_name', 'method', 'amount', 'received_on',
    'reference', 'carried_from_reversal_id', 'recorded_by', 'recorded_at', 'verified_by',
    'verified_at');

CREATE TRIGGER "payments_handover_id_frozen" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('handover_id');

CREATE TRIGGER "payments_advance_for_student_id_frozen" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('advance_for_student_id');

CREATE TRIGGER "payments_voided_at_frozen" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at');

-- §3.4, R193: a payment joins a handover once, while that handover is open and the payment is not
-- voided (the FK already binds the handover to the payment's recorder).
CREATE FUNCTION asms_payment_handover_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.handover_id IS NOT NULL AND OLD.handover_id IS NULL
     AND (NEW.status <> 'verified' OR NOT EXISTS (
       SELECT 1 FROM cash_handovers h
       WHERE h.school_id = NEW.school_id AND h.id = NEW.handover_id AND h.status = 'open')) THEN
    RAISE EXCEPTION 'a payment joins an open handover, unvoided'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payments_handover_open',
            DETAIL = 'constraint: payments_handover_open',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'handover_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_handover_open" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_handover_open();

-- R232 (no sole-principal exception for cash): nobody records a payment whose payer is their own
-- guardian record, or whose advance is for their own child. Allocations are checked per child by
-- payment_allocations_apply.
CREATE FUNCTION asms_payment_own_child() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND asms_user_is_guardian(NEW.school_id, NEW.recorded_by, NEW.payer_guardian_id))
     OR (NEW.advance_for_student_id IS NOT NULL
         AND (TG_OP = 'INSERT' OR OLD.advance_for_student_id IS NULL)
         AND asms_user_is_guardian_of(NEW.school_id, NEW.recorded_by, NEW.advance_for_student_id)) THEN
    RAISE EXCEPTION 'nobody records a payment for their own child'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payments_own_child',
            DETAIL = 'constraint: payments_own_child',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_own_child" BEFORE INSERT OR UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_own_child();

-- R189: by commit, an unallocated remainder on a live payment names the child it is an advance
-- for. Deferred, so it reads the row as the transaction leaves it (the
-- idempotency_keys_subject_required precedent).
CREATE FUNCTION asms_payment_advance_student_required() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payments p
    WHERE p.school_id = NEW.school_id AND p.id = NEW.id
      AND p.status = 'verified' AND p.unallocated_amount > 0 AND p.advance_for_student_id IS NULL
  ) THEN
    RAISE EXCEPTION 'an unallocated remainder must name the child it is an advance for'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payments_advance_student_required',
            DETAIL = 'constraint: payments_advance_student_required',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'advance_for_student_id';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_advance_student_required" AFTER INSERT OR UPDATE ON "payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asms_payment_advance_student_required();

CREATE TRIGGER "payments_no_delete" BEFORE DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payments_no_truncate" BEFORE TRUNCATE ON "payments"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payments_school_id_immutable" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payment_allocations (R188, R189, R191, R192, §3.2) ---------------------------------------

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_amount_check"
  CHECK ("amount" > 0);

-- One live allocation per payment and charge. Partial, so a credit's de-allocation (A6) can
-- reverse a row and write the part that stays, and a reopened charge can take the same payment's
-- advance again.
CREATE UNIQUE INDEX "payment_allocations_live_key" ON "payment_allocations" ("school_id", "payment_id", "charge_id")
  WHERE "reversed_at" IS NULL;

CREATE TRIGGER "payment_allocations_columns_immutable" BEFORE UPDATE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'payment_id', 'charge_id', 'student_id', 'academic_year_id', 'amount', 'created_at');

CREATE TRIGGER "payment_allocations_reversed_at_frozen" BEFORE UPDATE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('reversed_at');

-- §3.2: one statement's new allocations raise each charge's allocated_amount and lower each
-- payment's unallocated_amount by their sums, under the row locks taken in the R236 order. A
-- charge whose allocated + credited reaches its amount settles in the same UPDATE
-- (charges_settled_outstanding_check). Over-allocation fails charges_allocated_amount_check or
-- payments_unallocated_amount_check (23514, retried once); a voided or waived charge fails
-- charges_closed_unallocated_check. Refused here: a row born reversed, a voided payment, and the
-- recorder's own child (R232, no exception).
CREATE FUNCTION asms_payment_allocations_apply() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  PERFORM 1 FROM payments p
  WHERE (p.school_id, p.id) IN (SELECT n.school_id, n.payment_id FROM new_rows n)
  ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM charges c
  WHERE (c.school_id, c.id) IN (SELECT n.school_id, n.charge_id FROM new_rows n)
  ORDER BY c.id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM new_rows n WHERE n.reversed_at IS NOT NULL) THEN
    v_refusal := 'payment_allocations_born_live';
  ELSIF EXISTS (
    SELECT 1 FROM new_rows n
    JOIN payments p ON p.school_id = n.school_id AND p.id = n.payment_id
    WHERE p.status <> 'verified'
  ) THEN
    v_refusal := 'payment_allocations_payment_voided';
  ELSIF EXISTS (
    SELECT 1 FROM new_rows n
    JOIN payments p ON p.school_id = n.school_id AND p.id = n.payment_id
    WHERE asms_user_is_guardian_of(n.school_id, p.recorded_by, n.student_id)
  ) THEN
    v_refusal := 'payment_allocations_own_child';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'allocation refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;

  UPDATE charges c
  SET allocated_amount = c.allocated_amount + s.total,
      status = CASE WHEN c.status = 'open' AND c.allocated_amount + s.total + c.credited_amount = c.amount
                    THEN 'settled'::charge_status ELSE c.status END,
      settled_at = CASE WHEN c.status = 'open' AND c.allocated_amount + s.total + c.credited_amount = c.amount
                        THEN now() ELSE c.settled_at END
  FROM (SELECT n.school_id, n.charge_id, sum(n.amount) AS total
        FROM new_rows n GROUP BY n.school_id, n.charge_id) s
  WHERE c.school_id = s.school_id AND c.id = s.charge_id;

  UPDATE payments p
  SET unallocated_amount = p.unallocated_amount - s.total
  FROM (SELECT n.school_id, n.payment_id, sum(n.amount) AS total
        FROM new_rows n GROUP BY n.school_id, n.payment_id) s
  WHERE p.school_id = s.school_id AND p.id = s.payment_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "payment_allocations_apply" AFTER INSERT ON "payment_allocations"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION asms_payment_allocations_apply();

-- §3.2, R191, A6: allocations whose reversed_at is set by one statement lower each charge's
-- allocated_amount and raise each payment's unallocated_amount by their sums, under the locks in
-- the R236 order, and reopen a settled charge (settled -> open is admitted only while
-- asms.reversing_payment is 'on'; it is switched on for these updates and restored). An
-- admission-head allocation returns to its payment only when the payment is being voided
-- (payment_allocations_admission_reversal, R192): a credit never turns admission money into an
-- advance.
CREATE FUNCTION asms_payment_allocations_reverse() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_previous text := current_setting('asms.reversing_payment', true);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM payments p
  WHERE (p.school_id, p.id) IN (
    SELECT n.school_id, n.payment_id FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL)
  ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM charges c
  WHERE (c.school_id, c.id) IN (
    SELECT n.school_id, n.charge_id FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL)
  ORDER BY c.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM new_rows n
    JOIN old_rows o ON o.id = n.id
    JOIN payments p ON p.school_id = n.school_id AND p.id = n.payment_id
    JOIN charges c ON c.school_id = n.school_id AND c.id = n.charge_id
    JOIN fee_heads h ON h.school_id = c.school_id AND h.id = c.fee_head_id
    WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL
      AND h.category = 'admission' AND p.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'an admission-head allocation is never reversed into an advance'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payment_allocations_admission_reversal',
            DETAIL = 'constraint: payment_allocations_admission_reversal',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;

  PERFORM set_config('asms.reversing_payment', 'on', true);

  UPDATE charges c
  SET allocated_amount = c.allocated_amount - s.total,
      status = CASE WHEN c.status = 'settled' THEN 'open'::charge_status ELSE c.status END,
      settled_at = CASE WHEN c.status = 'settled' THEN NULL ELSE c.settled_at END
  FROM (SELECT n.school_id, n.charge_id, sum(n.amount) AS total
        FROM new_rows n JOIN old_rows o ON o.id = n.id
        WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL
        GROUP BY n.school_id, n.charge_id) s
  WHERE c.school_id = s.school_id AND c.id = s.charge_id;

  UPDATE payments p
  SET unallocated_amount = p.unallocated_amount + s.total
  FROM (SELECT n.school_id, n.payment_id, sum(n.amount) AS total
        FROM new_rows n JOIN old_rows o ON o.id = n.id
        WHERE o.reversed_at IS NULL AND n.reversed_at IS NOT NULL
        GROUP BY n.school_id, n.payment_id) s
  WHERE p.school_id = s.school_id AND p.id = s.payment_id;

  PERFORM set_config('asms.reversing_payment', coalesce(v_previous, ''), true);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "payment_allocations_reverse" AFTER UPDATE ON "payment_allocations"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION asms_payment_allocations_reverse();

CREATE TRIGGER "payment_allocations_no_delete" BEFORE DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_allocations_no_truncate" BEFORE TRUNCATE ON "payment_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_allocations_school_id_immutable" BEFORE UPDATE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- receipts (R190) ---------------------------------------------------------------------------

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_receipt_no_check"
  CHECK ("receipt_no" > 0);

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_amount_check"
  CHECK ("amount" > 0);

CREATE TRIGGER "receipts_columns_immutable" BEFORE UPDATE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'payment_id', 'academic_year_id', 'receipt_no', 'amount', 'issued_at', 'issued_by');

CREATE TRIGGER "receipts_voided_at_frozen" BEFORE UPDATE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at');

CREATE TRIGGER "receipts_no_delete" BEFORE DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "receipts_no_truncate" BEFORE TRUNCATE ON "receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "receipts_school_id_immutable" BEFORE UPDATE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- receipt_lines (append-only, §3.5) ---------------------------------------------------------

ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_amount_check"
  CHECK ("amount" > 0);

-- A charge line snapshots its head's name; the advance line (no charge) has neither name nor
-- period.
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_advance_check"
  CHECK (
    ("charge_id" IS NULL) = ("fee_head_name" IS NULL)
    AND ("charge_id" IS NOT NULL OR "period" IS NULL)
  );

ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_period_check"
  CHECK ("period" IS NULL OR "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_fee_head_name_no_id_check"
  CHECK ("fee_head_name" !~ '[0-9]{13}' AND "fee_head_name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "receipt_lines_columns_immutable" BEFORE UPDATE ON "receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'receipt_id', 'academic_year_id', 'student_id', 'charge_id', 'fee_head_name', 'period',
    'amount', 'created_at');

CREATE TRIGGER "receipt_lines_no_delete" BEFORE DELETE ON "receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "receipt_lines_no_truncate" BEFORE TRUNCATE ON "receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "receipt_lines_school_id_immutable" BEFORE UPDATE ON "receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payment_reversals (R191, R192, R232, R251) -------------------------------------------------

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_amount_check"
  CHECK ("amount" > 0);

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_refund_reference_check"
  CHECK ("refund_reference" IS NULL OR ("refund_reference" = btrim("refund_reference") AND "refund_reference" <> ''));

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_refund_reference_no_id_check"
  CHECK ("refund_reference" !~ '[0-9]{13}' AND "refund_reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reverses_check"
  CHECK (("kind" = 'refund_reversal') = ("reverses_id" IS NOT NULL));

-- Only a carry-forward names a target payment (set once it exists; checked at commit by
-- payment_reversals_carry_forward_linked).
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_carried_to_check"
  CHECK ("kind" = 'carried_forward' OR "carried_to_payment_id" IS NULL);

-- Rule 20: refunds and their reversals are approved (by a principal: the service's
-- requirePrincipal); a void and a carry-forward are not.
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_approved_check"
  CHECK (("kind" IN ('refund', 'refund_reversal')) = ("approved_by" IS NOT NULL));

-- A refund says how the money went back (never carried_forward); nothing else carries a method or
-- a refund reference.
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_refund_method_check"
  CHECK (
    ("kind" = 'refund') = ("refund_method" IS NOT NULL)
    AND ("refund_method" IS NULL OR "refund_method" <> 'carried_forward')
    AND ("kind" = 'refund' OR "refund_reference" IS NULL)
  );

-- One void per payment.
CREATE UNIQUE INDEX "payment_reversals_void_key" ON "payment_reversals" ("school_id", "payment_id")
  WHERE "kind" = 'void';

-- A refund is reversed at most once.
CREATE UNIQUE INDEX "payment_reversals_reverses_key" ON "payment_reversals" ("school_id", "reverses_id")
  WHERE "reverses_id" IS NOT NULL;

-- A carried-forward payment comes from one carry-forward.
CREATE UNIQUE INDEX "payment_reversals_carried_to_key" ON "payment_reversals" ("school_id", "carried_to_payment_id")
  WHERE "carried_to_payment_id" IS NOT NULL;

CREATE TRIGGER "payment_reversals_columns_immutable" BEFORE UPDATE ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'payment_id', 'academic_year_id', 'kind', 'reverses_id', 'amount', 'reason', 'requested_by',
    'approved_by', 'refund_method', 'refund_reference', 'created_at');

CREATE TRIGGER "payment_reversals_carried_to_payment_id_frozen" BEFORE UPDATE ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('carried_to_payment_id');

-- R191, R192, R232: the refusals that need the payment, taken under its row lock (the first lock
-- of R236). Every kind needs a live payment (payment_reversals_payment_voided). A void is never
-- requested by the payment's recorder (payment_reversals_not_self), is for the whole amount
-- (payment_reversals_void_amount), waits while a refund or carry-forward stands
-- (payment_reversals_payment_has_refund) and while the cash sits inside an open handover
-- (payment_reversals_payment_in_handover). A refund reversal reverses a refund of the same
-- payment, in full (payment_reversals_reverses_refund). Nobody requests or approves a reversal of
-- money paid for their own child or by their own guardian record (payment_reversals_own_child);
-- cash keeps no sole-principal exception.
CREATE FUNCTION asms_payment_reversal_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_refusal text;
  v_actor bigint;
BEGIN
  SELECT * INTO v_payment FROM payments p
  WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id
  FOR UPDATE;

  IF v_payment.status <> 'verified' THEN
    v_refusal := 'payment_reversals_payment_voided';
  ELSIF NEW.kind = 'void' AND NEW.requested_by = v_payment.recorded_by THEN
    v_refusal := 'payment_reversals_not_self';
  ELSIF NEW.kind = 'void' AND NEW.amount <> v_payment.amount THEN
    v_refusal := 'payment_reversals_void_amount';
  ELSIF NEW.kind = 'void' AND (
    SELECT coalesce(sum(CASE r.kind WHEN 'refund_reversal' THEN -r.amount ELSE r.amount END), 0)
    FROM payment_reversals r
    WHERE r.school_id = NEW.school_id AND r.payment_id = NEW.payment_id
      AND r.kind IN ('refund', 'refund_reversal', 'carried_forward')
  ) > 0 THEN
    v_refusal := 'payment_reversals_payment_has_refund';
  ELSIF NEW.kind = 'void' AND EXISTS (
    SELECT 1 FROM cash_handovers h
    WHERE h.school_id = NEW.school_id AND h.id = v_payment.handover_id AND h.status = 'open'
  ) THEN
    v_refusal := 'payment_reversals_payment_in_handover';
  ELSIF NEW.kind = 'refund_reversal' AND NEW.reverses_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_reversals r
    WHERE r.school_id = NEW.school_id AND r.id = NEW.reverses_id
      AND r.kind = 'refund' AND r.amount = NEW.amount
  ) THEN
    v_refusal := 'payment_reversals_reverses_refund';
  END IF;

  IF v_refusal IS NULL THEN
    FOREACH v_actor IN ARRAY ARRAY[NEW.requested_by, NEW.approved_by] LOOP
      CONTINUE WHEN v_actor IS NULL;
      IF asms_user_is_guardian(NEW.school_id, v_actor, v_payment.payer_guardian_id)
         OR (v_payment.advance_for_student_id IS NOT NULL
             AND asms_user_is_guardian_of(NEW.school_id, v_actor, v_payment.advance_for_student_id))
         OR EXISTS (
           SELECT 1 FROM payment_allocations a
           WHERE a.school_id = NEW.school_id AND a.payment_id = NEW.payment_id
             AND asms_user_is_guardian_of(NEW.school_id, v_actor, a.student_id)) THEN
        v_refusal := 'payment_reversals_own_child';
      END IF;
    END LOOP;
  END IF;

  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'reversal refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_reversals_not_self" BEFORE INSERT ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_reversal_not_self();

-- §3.2: what a reversal does to its payment, under the payment's row lock (taken by
-- payment_reversals_not_self). A void marks the payment and its receipt voided, locks the charges
-- of its live allocations in id order and reverses them (payment_allocations_reverse reopens the
-- charges and restores unallocated_amount), all while asms.reversing_payment is 'on'. A refund
-- and a carry-forward lower unallocated_amount (payments_unallocated_amount_check refuses more
-- than is unallocated: REFUND_EXCEEDS_UNALLOCATED, NOTHING_TO_CARRY_FORWARD); a refund reversal
-- raises it back.
CREATE FUNCTION asms_payment_reversal_apply() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_previous text;
BEGIN
  IF NEW.kind = 'void' THEN
    v_previous := current_setting('asms.reversing_payment', true);
    PERFORM set_config('asms.reversing_payment', 'on', true);

    UPDATE payments p SET status = 'voided', voided_at = now()
    WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id;

    UPDATE receipts r SET voided_at = now()
    WHERE r.school_id = NEW.school_id AND r.payment_id = NEW.payment_id AND r.voided_at IS NULL;

    PERFORM 1 FROM charges c
    WHERE c.school_id = NEW.school_id
      AND c.id IN (SELECT a.charge_id FROM payment_allocations a
                   WHERE a.school_id = NEW.school_id AND a.payment_id = NEW.payment_id
                     AND a.reversed_at IS NULL)
    ORDER BY c.id FOR UPDATE;

    UPDATE payment_allocations a SET reversed_at = now()
    WHERE a.school_id = NEW.school_id AND a.payment_id = NEW.payment_id AND a.reversed_at IS NULL;

    -- >>> WAVE K HOOK (slice 21, payment_claims) <<<
    -- When payment_claims exists, slice 21 replaces this function (CREATE OR REPLACE) adding, here,
    -- under the same asms.reversing_payment: the claim that created this payment returns to
    -- pending (verified -> pending is admitted only while the setting is 'on'):
    --   UPDATE payment_claims c
    --   SET status = 'pending', payment_id = NULL, reopened_at = now()
    --   WHERE c.school_id = NEW.school_id AND c.payment_id = NEW.payment_id;
    -- >>> END WAVE K HOOK <<<

    PERFORM set_config('asms.reversing_payment', coalesce(v_previous, ''), true);
  ELSE
    UPDATE payments p
    SET unallocated_amount = p.unallocated_amount
          + CASE NEW.kind WHEN 'refund_reversal' THEN NEW.amount ELSE -NEW.amount END
    WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "payment_reversals_apply" AFTER INSERT ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_reversal_apply();

-- R251: by commit, a carry-forward names its target payment, which names it back, carries the same
-- amount and belongs to another academic year.
CREATE FUNCTION asms_payment_reversal_carry_forward_linked() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_reversals r
    JOIN payments q ON q.school_id = r.school_id AND q.id = r.carried_to_payment_id
    WHERE r.school_id = NEW.school_id AND r.id = NEW.id
      AND q.carried_from_reversal_id = r.id
      AND q.amount = r.amount
      AND q.academic_year_id <> r.academic_year_id
  ) THEN
    RAISE EXCEPTION 'a carry-forward is linked to its target payment by commit'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payment_reversals_carry_forward_linked',
            DETAIL = 'constraint: payment_reversals_carry_forward_linked',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'carried_to_payment_id';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_reversals_carry_forward_linked" AFTER INSERT ON "payment_reversals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'carried_forward')
  EXECUTE FUNCTION asms_payment_reversal_carry_forward_linked();

CREATE TRIGGER "payment_reversals_no_delete" BEFORE DELETE ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_reversals_no_truncate" BEFORE TRUNCATE ON "payment_reversals"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_reversals_school_id_immutable" BEFORE UPDATE ON "payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- cash_handovers (§3.4, R193, R194) ---------------------------------------------------------

-- On behalf iff someone other than the collector opened it.
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_on_behalf_check"
  CHECK ("on_behalf" = ("opened_by" <> "collector_user_id"));

-- A handover gathers at least one payment (HANDOVER_NOTHING_TO_HAND_OVER).
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_expected_check"
  CHECK ("payment_count" > 0 AND "expected_amount" > 0);

-- R194: never confirmed by the collector or the opener (a third user when opened on behalf).
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_not_self_check"
  CHECK ("confirmed_by" <> "collector_user_id" AND "confirmed_by" <> "opened_by");

-- Confirmed iff the confirmation is recorded, all of it at once.
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_confirmed_check"
  CHECK (
    ("status" = 'confirmed') = ("confirmed_at" IS NOT NULL)
    AND ("confirmed_at" IS NULL) = ("confirmed_by" IS NULL)
    AND ("confirmed_at" IS NULL) = ("counted_amount" IS NULL)
    AND ("confirmed_at" IS NULL) = ("shortfall_amount" IS NULL)
    AND ("confirmed_at" IS NULL) = ("surplus_amount" IS NULL)
    AND ("confirmed_at" IS NOT NULL OR "confirm_note" IS NULL)
  );

-- §3.4: counted - expected = surplus - shortfall, at most one of them above 0.
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_counted_check"
  CHECK (
    "counted_amount" >= 0 AND "shortfall_amount" >= 0 AND "surplus_amount" >= 0
    AND "counted_amount" - "expected_amount" = "surplus_amount" - "shortfall_amount"
    AND ("shortfall_amount" = 0 OR "surplus_amount" = 0)
  );

-- A shortfall is resolved once, with who, when and why; written_off names the expense and
-- explained_by_void the void, and nothing else names either.
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_resolution_check"
  CHECK (
    ("shortfall_resolution" IS NULL OR ("status" = 'confirmed' AND "shortfall_amount" > 0))
    AND ("shortfall_resolution" IS NULL) = ("shortfall_resolved_at" IS NULL)
    AND ("shortfall_resolution" IS NULL) = ("shortfall_resolved_by" IS NULL)
    AND ("shortfall_resolution" IS NULL) = ("shortfall_resolution_reason" IS NULL)
    AND ("shortfall_resolution" IS NOT DISTINCT FROM 'written_off') = ("shortfall_expense_id" IS NOT NULL)
    AND ("shortfall_resolution" IS NOT DISTINCT FROM 'explained_by_void') = ("shortfall_reversal_id" IS NOT NULL)
  );

ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_note_check"
  CHECK ("note" IS NULL OR ("note" = btrim("note") AND "note" <> ''));

ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_confirm_note_check"
  CHECK ("confirm_note" IS NULL OR ("confirm_note" = btrim("confirm_note") AND "confirm_note" <> ''));

ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_confirm_note_no_id_check"
  CHECK ("confirm_note" !~ '[0-9]{13}' AND "confirm_note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_shortfall_resolution_reason_no_id_check"
  CHECK ("shortfall_resolution_reason" !~ '[0-9]{13}' AND "shortfall_resolution_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One open handover per collector (HANDOVER_OPEN).
CREATE UNIQUE INDEX "cash_handovers_open_key" ON "cash_handovers" ("school_id", "collector_user_id")
  WHERE "status" = 'open';

CREATE TRIGGER "cash_handovers_status_transition" BEFORE UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:confirmed');

CREATE TRIGGER "cash_handovers_columns_immutable" BEFORE UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'collector_user_id', 'collector_staff_id', 'opened_by', 'on_behalf', 'expected_amount',
    'payment_count', 'opened_at', 'note');

CREATE TRIGGER "cash_handovers_confirmed_frozen" BEFORE UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'confirmed_at', 'confirmed_by', 'counted_amount', 'shortfall_amount', 'surplus_amount',
    'confirm_note');

CREATE TRIGGER "cash_handovers_shortfall_resolution_frozen" BEFORE UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'shortfall_resolution', 'shortfall_resolved_at', 'shortfall_resolved_by',
    'shortfall_resolution_reason', 'shortfall_expense_id', 'shortfall_reversal_id');

-- §3.4: a written-off shortfall is a cash_shortfall expense of the shortfall's amount
-- (cash_handovers_shortfall_expense); a shortfall explained by a void names the void of a payment
-- gathered in this handover (cash_handovers_shortfall_reversal).
CREATE FUNCTION asms_cash_handover_shortfall() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.shortfall_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.school_id = NEW.school_id AND e.id = NEW.shortfall_expense_id
      AND e.category = 'cash_shortfall' AND e.amount = NEW.shortfall_amount
  ) THEN
    v_refusal := 'cash_handovers_shortfall_expense';
  ELSIF NEW.shortfall_reversal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_reversals r
    JOIN payments p ON p.school_id = r.school_id AND p.id = r.payment_id
    WHERE r.school_id = NEW.school_id AND r.id = NEW.shortfall_reversal_id
      AND r.kind = 'void' AND p.handover_id = NEW.id
  ) THEN
    v_refusal := 'cash_handovers_shortfall_reversal';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'shortfall resolution refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cash_handovers_shortfall" BEFORE INSERT OR UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_cash_handover_shortfall();

-- §3.4: by commit, the stored expected_amount and payment_count are the gathered payments' sum and
-- count (the open locks the collector's custody payments by id and sets their handover_id in the
-- same transaction).
CREATE FUNCTION asms_cash_handover_expected_matches() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cash_handovers h
    WHERE h.school_id = NEW.school_id AND h.id = NEW.id
      AND (h.expected_amount, h.payment_count) = (
        SELECT coalesce(sum(p.amount), 0), count(*)
        FROM payments p WHERE p.school_id = h.school_id AND p.handover_id = h.id)
  ) THEN
    RAISE EXCEPTION 'a handover''s expected amount is the sum of the payments it gathered'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'cash_handovers_expected_matches',
            DETAIL = 'constraint: cash_handovers_expected_matches',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'expected_amount';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "cash_handovers_expected_matches" AFTER INSERT ON "cash_handovers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asms_cash_handover_expected_matches();

CREATE TRIGGER "cash_handovers_no_delete" BEFORE DELETE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "cash_handovers_no_truncate" BEFORE TRUNCATE ON "cash_handovers"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "cash_handovers_school_id_immutable" BEFORE UPDATE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
