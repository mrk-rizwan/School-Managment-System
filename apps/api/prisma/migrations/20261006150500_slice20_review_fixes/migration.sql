-- Slice 20 review fixes (contracts/slice-20.md §7, wave J review 2026-10-06). Hand-written; no
-- table changes. Every object here is listed in test/guardrails/schema-checks.ts (WAVE_J_OBJECTS).
--
-- 1. The own-child check on an allocation, and on a later binding of a payment's advance, keyed on
--    the payment's recorder: once that recorder was linked as the child's guardian, every later
--    movement of the payment's money (a job's advance application, a credit's de-allocation, a
--    carry-forward) failed for good, and the class's nightly generation with it. Both now read the
--    ACTING user, the transaction-local asms.actor_user_id (ChangeContextRepository.setChangeContext,
--    set by every request path that moves money), and are skipped when it is unset: a job, the
--    system actor. The INSERT branch of payments_own_child (the recorder against the payer and the
--    advance child) is unchanged, and the services keep their own checks (R232).
-- 2. A carried_forward payment is never voided (payment_reversals_carried_forward_void): its money
--    came from another year's advance, so a void would destroy it; refund it instead.

CREATE OR REPLACE FUNCTION asms_payment_own_child() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor bigint := NULLIF(current_setting('asms.actor_user_id', true), '')::bigint;
BEGIN
  IF (TG_OP = 'INSERT' AND (
        asms_user_is_guardian(NEW.school_id, NEW.recorded_by, NEW.payer_guardian_id)
        OR (NEW.advance_for_student_id IS NOT NULL
            AND asms_user_is_guardian_of(NEW.school_id, NEW.recorded_by, NEW.advance_for_student_id))))
     OR (TG_OP = 'UPDATE' AND v_actor IS NOT NULL
         AND NEW.advance_for_student_id IS NOT NULL AND OLD.advance_for_student_id IS NULL
         AND asms_user_is_guardian_of(NEW.school_id, v_actor, NEW.advance_for_student_id)) THEN
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

CREATE OR REPLACE FUNCTION asms_payment_allocations_apply() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_actor bigint := NULLIF(current_setting('asms.actor_user_id', true), '')::bigint;
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
  ELSIF v_actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM new_rows n
    WHERE asms_user_is_guardian_of(n.school_id, v_actor, n.student_id)
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

CREATE OR REPLACE FUNCTION asms_payment_reversal_not_self() RETURNS trigger
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
  ELSIF NEW.kind = 'void' AND v_payment.method = 'carried_forward' THEN
    v_refusal := 'payment_reversals_carried_forward_void';
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
