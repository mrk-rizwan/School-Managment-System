-- Phase 3 close (business-rules review G1): undoing a carry-forward (R251), in the reversal model.
-- Hand-written. Every object here is listed in test/guardrails/schema-checks.ts
-- (PHASE_CLOSE_OBJECTS).
--
-- A carry_forward_reversal is a new row on the SOURCE payment naming the carried_forward reversal
-- it undoes (reverses_id, same payment, same amount; once: payment_reversals_reverses_key). It is
-- admitted only while the carried payment in the target year is live and wholly unallocated, with
-- no refund or carry-forward of its own standing (payment_reversals_carried_spent). Its effect,
-- under the locks of R236 (the source by payment_reversals_not_self, then the carried payment):
-- the source's unallocated_amount rises by the amount (the advance is back in its year) and the
-- carried payment is voided (it never had a receipt or an allocation, so nothing else moves).
-- Nothing is edited or deleted: the carry-forward, its carried payment and the undo all stay.

-- 1. Only a refund reversal and a carry-forward reversal name the row they undo.
ALTER TABLE "payment_reversals" DROP CONSTRAINT "payment_reversals_reverses_check";
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reverses_check"
  CHECK (("kind" IN ('refund_reversal', 'carry_forward_reversal')) = ("reverses_id" IS NOT NULL));

-- 2. The refusals: as 20261006150500_slice20_review_fixes, plus the carry-forward reversal's two,
--    and a void nets a carry-forward reversal against the carry-forward it undid.
CREATE OR REPLACE FUNCTION asms_payment_reversal_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_carried payments;
  v_refusal text;
  v_actor bigint;
BEGIN
  SELECT * INTO v_payment FROM payments p
  WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id
  FOR UPDATE;

  IF v_payment.status <> 'verified' THEN
    v_refusal := 'payment_reversals_payment_voided';
  ELSIF NEW.kind = 'void' AND v_payment.method = 'carried_forward' THEN
    v_refusal := 'payment_reversals_carried_forward_void';
  ELSIF NEW.kind = 'void' AND NEW.requested_by = v_payment.recorded_by THEN
    v_refusal := 'payment_reversals_not_self';
  ELSIF NEW.kind = 'void' AND NEW.amount <> v_payment.amount THEN
    v_refusal := 'payment_reversals_void_amount';
  ELSIF NEW.kind = 'void' AND (
    SELECT coalesce(sum(CASE WHEN r.kind IN ('refund_reversal', 'carry_forward_reversal') THEN -r.amount ELSE r.amount END), 0)
    FROM payment_reversals r
    WHERE r.school_id = NEW.school_id AND r.payment_id = NEW.payment_id
      AND r.kind IN ('refund', 'refund_reversal', 'carried_forward', 'carry_forward_reversal')
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
  ELSIF NEW.kind = 'carry_forward_reversal' AND NOT EXISTS (
    SELECT 1 FROM payment_reversals r
    WHERE r.school_id = NEW.school_id AND r.id = NEW.reverses_id
      AND r.kind = 'carried_forward' AND r.amount = NEW.amount
  ) THEN
    v_refusal := 'payment_reversals_reverses_carry_forward';
  ELSIF NEW.kind = 'carry_forward_reversal' THEN
    SELECT q.* INTO v_carried FROM payment_reversals r
    JOIN payments q ON q.school_id = r.school_id AND q.id = r.carried_to_payment_id
    WHERE r.school_id = NEW.school_id AND r.id = NEW.reverses_id
    FOR UPDATE OF q;
    IF v_carried.id IS NULL OR v_carried.status <> 'verified'
       OR v_carried.unallocated_amount <> v_carried.amount
       OR EXISTS (
         SELECT 1 FROM payment_reversals r
         WHERE r.school_id = NEW.school_id AND r.payment_id = v_carried.id
           AND r.kind IN ('refund', 'carried_forward')
           AND NOT EXISTS (SELECT 1 FROM payment_reversals u
                           WHERE u.school_id = r.school_id AND u.reverses_id = r.id)) THEN
      v_refusal := 'payment_reversals_carried_spent';
    END IF;
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

-- 3. The effect: as 20261006170000_slice21_payment_claims, plus the carry-forward reversal (the
--    advance back on the source, the carried payment voided).
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
          + CASE WHEN NEW.kind IN ('refund_reversal', 'carry_forward_reversal') THEN NEW.amount ELSE -NEW.amount END
    WHERE p.school_id = NEW.school_id AND p.id = NEW.payment_id;

    IF NEW.kind = 'carry_forward_reversal' THEN
      -- Phase close G1: the carried payment (wholly unallocated, checked by
      -- payment_reversals_not_self under its lock) is voided; its money is back on the source.
      UPDATE payments q SET status = 'voided', voided_at = now()
      FROM payment_reversals r
      WHERE r.school_id = NEW.school_id AND r.id = NEW.reverses_id
        AND q.school_id = r.school_id AND q.id = r.carried_to_payment_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
