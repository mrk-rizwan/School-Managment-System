-- Wave K (slice 21 schema groundwork): payment claims, the deposit-slip claims a guardian makes and
-- the office verifies (phase-3-financial.md §3.2, §4 "Claims", R196-R200, R243, R249; decision
-- item 21), payments.claim_id (a payment keeps the claim it came from), the claim reopen in
-- asms_payment_reversal_apply (the wave K hook), and slice 22's payments (school_id, verified_at)
-- index for the collections report. Slice 22 needs no table: reminders are messages
-- (subject_type fee_reminder; R107's unique keys are the cadence caps) and the dues-clearance
-- override is an audit row. Generated DDL first (prisma migrate diff against the migrated
-- database, the create-only equivalent in a non-interactive shell), hand-written SQL after the
-- marker.

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('pending', 'verified', 'rejected', 'withdrawn', 'expired');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "claim_id" BIGINT;

-- CreateTable
CREATE TABLE "payment_claims" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "guardian_id" BIGINT NOT NULL,
    "method" "payment_method" NOT NULL,
    "claimed_amount" INTEGER NOT NULL,
    "paid_on" DATE NOT NULL,
    "reference" VARCHAR(60),
    "note" VARCHAR(300),
    "image_object_key" VARCHAR(64),
    "image_mime" VARCHAR(32),
    "image_size_bytes" INTEGER,
    "status" "claim_status" NOT NULL DEFAULT 'pending',
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "verified_amount" INTEGER,
    "verified_paid_on" DATE,
    "payment_id" BIGINT,
    "reopened_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_claims_school_id_status_created_at_idx" ON "payment_claims"("school_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "payment_claims_school_id_student_id_created_at_idx" ON "payment_claims"("school_id", "student_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_claims_school_id_guardian_id_created_at_idx" ON "payment_claims"("school_id", "guardian_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_claims_school_id_method_reference_paid_on_idx" ON "payment_claims"("school_id", "method", "reference", "paid_on");

-- CreateIndex
CREATE INDEX "payment_claims_school_id_decided_by_idx" ON "payment_claims"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "payment_claims_school_id_payment_id_idx" ON "payment_claims"("school_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_claims_school_id_id_key" ON "payment_claims"("school_id", "id");

-- CreateIndex
CREATE INDEX "payments_school_id_claim_id_idx" ON "payments"("school_id", "claim_id");

-- CreateIndex
CREATE INDEX "payments_school_id_verified_at_idx" ON "payments"("school_id", "verified_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_claim_id_fkey" FOREIGN KEY ("school_id", "claim_id") REFERENCES "payment_claims"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_payment_id_fkey" FOREIGN KEY ("school_id", "payment_id") REFERENCES "payments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.2, §4 "Claims", R196-R200, R243, R249;
-- decision item 21: the verifier may correct the paid date). Generated SQL above (prisma migrate
-- diff) reviewed: no drift lines. Every object here is listed in test/guardrails/schema-checks.ts
-- (WAVE_K_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
--
-- A claim and its payment are linked both ways: payment_claims.payment_id is the live link (set
-- iff verified, cleared by a void); payments.claim_id is the history, set at insert and never
-- changed, so a voided payment still names its claim (rule 4; coordinator decision 2026-10-06).
-- Lock order: a
-- verification locks the claim, then writes the payment in the counter's order (R236); a void
-- locks the payment and its charges and takes the claim last (asms_payment_reversal_apply). They
-- cannot deadlock: a claim whose payment is being voided is verified, so a verification holding
-- its lock is refused (CLAIM_NOT_PENDING) before it reaches a charge.
-- =============================================================================================

-- ---- payment_claims ----------------------------------------------------------------------------

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_claimed_amount_check"
  CHECK ("claimed_amount" > 0);

-- Rule 21: a deposit at a bank or a wallet; cash is paid at the counter.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_method_check"
  CHECK ("method" IN ('bank_transfer', 'jazzcash', 'easypaisa'));

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_reference_check"
  CHECK ("reference" IS NULL OR ("reference" = btrim("reference") AND "reference" <> ''));

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_note_check"
  CHECK ("note" IS NULL OR ("note" = btrim("note") AND "note" <> ''));

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_decision_reason_check"
  CHECK ("decision_reason" IS NULL OR ("decision_reason" = btrim("decision_reason") AND "decision_reason" <> ''));

-- R231: nothing identity-shaped in the reference, the note or the reason.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_reference_no_id_check"
  CHECK ("reference" !~ '[0-9]{13}' AND "reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_decision_reason_no_id_check"
  CHECK ("decision_reason" !~ '[0-9]{13}' AND "decision_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R196, decision item 21: the guardian's date and the verifier's correction fall on or before the
-- day the claim was made (school time); a correction differs from the guardian's date (the same
-- date is no correction: verified_paid_on stays null).
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_dates_check"
  CHECK (
    "paid_on" <= ("created_at" AT TIME ZONE 'Asia/Karachi')::date
    AND (
      "verified_paid_on" IS NULL
      OR ("verified_paid_on" <= ("created_at" AT TIME ZONE 'Asia/Karachi')::date AND "verified_paid_on" <> "paid_on")
    )
  );

-- The slip image: key, mime and size together; the staged-upload key shape of the school.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_image_check"
  CHECK (
    ("image_object_key" IS NULL) = ("image_mime" IS NULL)
    AND ("image_object_key" IS NULL) = ("image_size_bytes" IS NULL)
    AND (
      "image_object_key" IS NULL
      OR (
        "image_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$')
        AND "image_mime" IN ('image/jpeg', 'image/png', 'application/pdf')
        AND "image_size_bytes" BETWEEN 1 AND 5242880
      )
    )
  );

-- R200: an image-less claim is never verified, and only an image-less one expires.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_image_status_check"
  CHECK (
    ("status" <> 'verified' OR "image_object_key" IS NOT NULL)
    AND ("status" <> 'expired' OR "image_object_key" IS NULL)
  );

-- Decided iff not pending; a person decides everything but an expiry (the system); a rejection
-- says why; nothing pending or expired carries a reason.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_decided_check"
  CHECK (
    ("status" = 'pending') = ("decided_at" IS NULL)
    AND ("status" IN ('pending', 'expired')) = ("decided_by" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
    AND ("status" NOT IN ('pending', 'expired') OR "decision_reason" IS NULL)
  );

-- Verified iff the claim names its payment and the amount verified; a corrected date only on a
-- verified claim.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_verified_check"
  CHECK (
    ("status" = 'verified') = ("payment_id" IS NOT NULL)
    AND ("status" = 'verified') = ("verified_amount" IS NOT NULL)
    AND ("status" = 'verified' OR "verified_paid_on" IS NULL)
  );

-- A15, R196: never more than was claimed.
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_verified_amount_check"
  CHECK ("verified_amount" > 0 AND "verified_amount" <= "claimed_amount");

-- R196: a lower amount or a corrected date needs a reason (the guardian is told).
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_verified_reason_check"
  CHECK (
    "status" <> 'verified'
    OR "decision_reason" IS NOT NULL
    OR ("verified_amount" = "claimed_amount" AND "verified_paid_on" IS NULL)
  );

-- One claim per payment.
CREATE UNIQUE INDEX "payment_claims_payment_key" ON "payment_claims" ("school_id", "payment_id")
  WHERE "payment_id" IS NOT NULL;

-- R243: an upload is consumed by one claim.
CREATE UNIQUE INDEX "payment_claims_image_object_key_key" ON "payment_claims" ("school_id", "image_object_key")
  WHERE "image_object_key" IS NOT NULL;

-- R196, R198: a claim is born pending, undecided and never reopened, by a guardian with a live
-- can_login link to the student.
CREATE FUNCTION asms_payment_claim_init() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.status <> 'pending' OR NEW.reopened_at IS NOT NULL THEN
    v_refusal := 'payment_claims_born_pending';
  ELSIF NOT EXISTS (
    SELECT 1 FROM student_guardians sg
    WHERE sg.school_id = NEW.school_id AND sg.student_id = NEW.student_id
      AND sg.guardian_id = NEW.guardian_id AND sg.ended_at IS NULL AND sg.can_login
  ) THEN
    v_refusal := 'payment_claims_guardian_link';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'a claim is born pending, by a live login link of the child (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_claims_born_pending" BEFORE INSERT ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_claim_init();

-- pending -> verified | rejected | withdrawn | expired; verified -> pending only under a void.
CREATE TRIGGER "payment_claims_status_transition" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'pending:verified', 'pending:rejected', 'pending:withdrawn', 'pending:expired',
    'verified:pending:asms.reversing_payment');

-- What the guardian stated never changes.
CREATE TRIGGER "payment_claims_columns_immutable" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'guardian_id', 'method', 'claimed_amount', 'paid_on', 'reference', 'note',
    'created_at');

-- R243: the image is set once (CLAIM_IMAGE_EXISTS).
CREATE TRIGGER "payment_claims_image_frozen" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'image_object_key', 'image_mime', 'image_size_bytes');

-- §3.2: the image lands only while pending (payment_claims_image_not_pending, CLAIM_NOT_PENDING);
-- the decision columns are written by the decision (from pending) and cleared only by the reopen
-- (verified -> pending, which the transition trigger admits only under asms.reversing_payment),
-- which must move reopened_at (payment_claims_reopened_at_required); otherwise a decided claim's
-- decision is history (payment_claims_decision_frozen) and reopened_at moves only with a reopen
-- (payment_claims_reopened_at_frozen).
CREATE FUNCTION asms_payment_claim_frozen() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF OLD.status <> 'pending'
     AND (NEW.image_object_key, NEW.image_mime, NEW.image_size_bytes)
         IS DISTINCT FROM (OLD.image_object_key, OLD.image_mime, OLD.image_size_bytes) THEN
    v_refusal := 'payment_claims_image_not_pending';
  ELSIF OLD.status = 'verified' AND NEW.status = 'pending' THEN
    IF NEW.reopened_at IS NULL OR NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at THEN
      v_refusal := 'payment_claims_reopened_at_required';
    END IF;
  ELSIF NEW.reopened_at IS DISTINCT FROM OLD.reopened_at THEN
    v_refusal := 'payment_claims_reopened_at_frozen';
  ELSIF OLD.status <> 'pending'
        AND (NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.verified_amount,
             NEW.verified_paid_on, NEW.payment_id)
            IS DISTINCT FROM
            (OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.verified_amount,
             OLD.verified_paid_on, OLD.payment_id) THEN
    v_refusal := 'payment_claims_decision_frozen';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'a decided claim is history (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_claims_decision_frozen" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_claim_frozen();

-- R197, rule 0.21 (no exception): nobody verifies or rejects a claim of their own family. The
-- decider's user is never the submitting guardian's user (merge-resolved: asms_user_is_guardian)
-- nor a live guardian of the student (asms_user_is_guardian_of).
CREATE FUNCTION asms_payment_claim_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('verified', 'rejected') AND OLD.status IS DISTINCT FROM NEW.status
     AND (asms_user_is_guardian(NEW.school_id, NEW.decided_by, NEW.guardian_id)
          OR asms_user_is_guardian_of(NEW.school_id, NEW.decided_by, NEW.student_id)) THEN
    RAISE EXCEPTION 'nobody decides a claim of their own family'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payment_claims_not_self',
            DETAIL = 'constraint: payment_claims_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_claims_not_self" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_claim_not_self();

-- R196: the payment a verification names is the one it recorded for this claim (claim_id): live,
-- the claim's method, the verified amount, received on the verified date (the correction, else
-- the guardian's), verified by the decider, paid by the submitting guardian's family.
CREATE FUNCTION asms_payment_claim_payment_matches() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id
      AND p.status = 'verified'
      AND p.method = NEW.method
      AND p.amount = NEW.verified_amount
      AND p.received_on = coalesce(NEW.verified_paid_on, NEW.paid_on)
      AND p.verified_by = NEW.decided_by
      AND p.claim_id = NEW.id
      AND p.payer_guardian_id IN (SELECT asms_guardian_merge_family(NEW.school_id, NEW.guardian_id))
  ) THEN
    RAISE EXCEPTION 'a verified claim names the payment it recorded'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payment_claims_payment_matches',
            DETAIL = 'constraint: payment_claims_payment_matches',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'payment_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_claims_payment_matches" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_payment_claim_payment_matches();

CREATE TRIGGER "payment_claims_no_delete" BEFORE DELETE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_claims_no_truncate" BEFORE TRUNCATE ON "payment_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payment_claims_school_id_immutable" BEFORE UPDATE ON "payment_claims"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payments.claim_id ----------------------------------------------------------------------------

-- Only a deposit is verified from a claim.
ALTER TABLE "payments" ADD CONSTRAINT "payments_claim_method_check"
  CHECK ("claim_id" IS NULL OR "method" IN ('bank_transfer', 'jazzcash', 'easypaisa'));

-- Set at insert, never changed (payments_columns_immutable, wave J's, is left as it is).
CREATE TRIGGER "payments_claim_id_immutable" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('claim_id');

-- ---- payment_reversals: the wave K hook ----------------------------------------------------------

-- Replaces 20261006140000_slice20_payments' function (an applied migration is never edited),
-- filling its WAVE K HOOK: a void of a claim-backed payment returns the claim to pending with
-- reopened_at and clears its decision, under the same asms.reversing_payment. Everything else is
-- unchanged.
CREATE OR REPLACE FUNCTION asms_payment_reversal_apply() RETURNS trigger
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

    -- Slice 21 (R191): the claim that created this payment returns to the verifiers' queue.
    UPDATE payment_claims c
    SET status = 'pending', payment_id = NULL, verified_amount = NULL, verified_paid_on = NULL,
        decided_by = NULL, decided_at = NULL, decision_reason = NULL, reopened_at = now()
    WHERE c.school_id = NEW.school_id AND c.payment_id = NEW.payment_id;

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
