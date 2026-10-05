-- Slice 24 (wave I groundwork): leave types and leave requests (phase-3-financial.md §3.2, §4
-- "Leave", R209-R212, R248, R253), the leave-type seeds and their backfill.
-- Generated DDL first (prisma migrate diff), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "leave_code" AS ENUM ('casual', 'sick', 'unpaid', 'other');

-- CreateEnum
CREATE TYPE "leave_type_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "leave_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'ended_early');

-- CreateTable
CREATE TABLE "leave_types" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "code" "leave_code" NOT NULL,
    "days_per_year" SMALLINT,
    "paid" BOOLEAN NOT NULL,
    "status" "leave_type_status" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" BIGINT,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "leave_type_id" BIGINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "working_days" SMALLINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "leave_status" NOT NULL DEFAULT 'pending',
    "requested_by" BIGINT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "on_behalf" BOOLEAN NOT NULL DEFAULT false,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "cover_assignment_id" BIGINT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" VARCHAR(500),
    "ended_early_on" DATE,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_types_school_id_status_name_idx" ON "leave_types"("school_id", "status", "name");

-- CreateIndex
CREATE INDEX "leave_types_school_id_created_by_idx" ON "leave_types"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "leave_types_school_id_archived_by_idx" ON "leave_types"("school_id", "archived_by");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_school_id_id_key" ON "leave_types"("school_id", "id");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_staff_id_starts_on_idx" ON "leave_requests"("school_id", "staff_id", "starts_on");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_status_requested_at_idx" ON "leave_requests"("school_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_leave_type_id_idx" ON "leave_requests"("school_id", "leave_type_id");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_cover_assignment_id_idx" ON "leave_requests"("school_id", "cover_assignment_id");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_requested_by_idx" ON "leave_requests"("school_id", "requested_by");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_decided_by_idx" ON "leave_requests"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "leave_requests_school_id_cancelled_by_idx" ON "leave_requests"("school_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_school_id_id_key" ON "leave_requests"("school_id", "id");

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_archived_by_fkey" FOREIGN KEY ("school_id", "archived_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey" FOREIGN KEY ("school_id", "leave_type_id") REFERENCES "leave_types"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_fkey" FOREIGN KEY ("school_id", "requested_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancelled_by_fkey" FOREIGN KEY ("school_id", "cancelled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cover_assignment_id_fkey" FOREIGN KEY ("school_id", "cover_assignment_id") REFERENCES "teacher_assignments"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.1, §3.2, §4 "Leave", R209-R212, R248,
-- R253). Generated SQL above (prisma migrate diff) reviewed: no drift lines. Every object here is
-- listed in test/guardrails/schema-checks.ts (WAVE_I_OBJECTS). Trigger functions raise SQLSTATE
-- 23514 with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- leave_types (R209) ------------------------------------------------------------------------

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Null = unlimited.
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_days_per_year_check"
  CHECK ("days_per_year" IS NULL OR "days_per_year" BETWEEN 1 AND 366);

-- Unpaid leave is never paid.
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_paid_check"
  CHECK ("code" <> 'unpaid' OR NOT "paid");

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_archived_check"
  CHECK (
    ("status" = 'archived') = ("archived_at" IS NOT NULL)
    AND ("archived_at" IS NULL) = ("archived_by" IS NULL)
  );

-- Live names are unique per school, case-insensitively (LEAVE_TYPE_NAME_TAKEN); archiving frees one.
CREATE UNIQUE INDEX "leave_types_live_name_key" ON "leave_types" ("school_id", lower("name"))
  WHERE "status" = 'active';

-- A type is what balances were counted against: a different entitlement is a new type.
CREATE TRIGGER "leave_types_columns_immutable" BEFORE UPDATE ON "leave_types"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'name', 'code', 'days_per_year', 'paid', 'created_by', 'created_at');

CREATE TRIGGER "leave_types_archived_frozen" BEFORE UPDATE ON "leave_types"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('archived_at', 'archived_by', 'status');

CREATE TRIGGER "leave_types_no_delete" BEFORE DELETE ON "leave_types"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "leave_types_no_truncate" BEFORE TRUNCATE ON "leave_types"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "leave_types_school_id_immutable" BEFORE UPDATE ON "leave_types"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- leave_requests (R209-R212, R248) ----------------------------------------------------------

-- At most 60 days, inclusive.
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_dates_check"
  CHECK ("ends_on" >= "starts_on" AND "ends_on" - "starts_on" <= 59);

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_working_days_check"
  CHECK ("working_days" BETWEEN 0 AND 60);

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decision_reason_no_id_check"
  CHECK ("decision_reason" !~ '[0-9]{13}' AND "decision_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancel_reason_no_id_check"
  CHECK ("cancel_reason" !~ '[0-9]{13}' AND "cancel_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Decided once approved, rejected or ended early; never while pending (a cancelled request may be
-- either); a rejection says why.
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_check"
  CHECK (
    ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" NOT IN ('approved', 'rejected', 'ended_early') OR "decided_at" IS NOT NULL)
    AND ("status" <> 'pending' OR "decided_at" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
  );

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancelled_check"
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
  );

-- R248: ended early on a day inside the request, iff ended_early.
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_ended_early_check"
  CHECK (
    ("status" = 'ended_early') = ("ended_early_on" IS NOT NULL)
    AND ("ended_early_on" IS NULL OR "ended_early_on" BETWEEN "starts_on" AND "ends_on")
  );

-- Only an approval is self-approved (it stays so once cancelled or ended early).
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_self_approved_check"
  CHECK (NOT "self_approved" OR ("status" IN ('approved', 'cancelled', 'ended_early') AND "decided_at" IS NOT NULL));

-- R211: one staff member's live requests never overlap; a cancelled or rejected one frees the
-- dates, an ended-early one keeps only the days taken. Inclusive ranges (btree_gist, slice 4).
-- SQLSTATE 23P01; the name is in the message (LEAVE_OVERLAPS).
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_live_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "staff_id" WITH =,
    daterange("starts_on", coalesce("ended_early_on", "ends_on"), '[]') WITH &&
  ) WHERE ("status" IN ('pending', 'approved', 'ended_early'));

-- pending -> approved | rejected | cancelled; approved -> cancelled (before it starts, the
-- service) | ended_early.
CREATE TRIGGER "leave_requests_status_transition" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'pending:approved', 'pending:rejected', 'pending:cancelled', 'approved:cancelled',
    'approved:ended_early');

CREATE TRIGGER "leave_requests_columns_immutable" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'leave_type_id', 'starts_on', 'ends_on', 'working_days', 'reason',
    'requested_by', 'requested_at', 'on_behalf');

CREATE TRIGGER "leave_requests_decided_frozen" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'decided_at', 'decided_by', 'decision_reason', 'self_approved');

CREATE TRIGGER "leave_requests_cancelled_frozen" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason');

CREATE TRIGGER "leave_requests_ended_early_on_frozen" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_early_on');

CREATE TRIGGER "leave_requests_cover_assignment_id_frozen" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cover_assignment_id');

-- R210, R253: nobody approves, rejects or ends their own leave. A decision is refused when the
-- decider's login is the staff member's, except the sole active principal approving their own
-- leave with self_approved; self_approved on anyone else's request is refused
-- (leave_requests_self_approved_unwarranted). Ending early carries no *_by column, so the actor is
-- the TRANSACTION-LOCAL asms.actor_user_id (ChangeContextRepository.setChangeContext): missing is
-- refused (leave_requests_actor_required, fail-closed); the staff member's own login is refused
-- unless the request was the sole principal's self-approved leave and they still are.
CREATE FUNCTION asms_leave_request_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_actor text;
  v_self boolean;
BEGIN
  IF NEW.decided_by IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.decided_by IS NULL) THEN
    v_self := EXISTS (SELECT 1 FROM users u
                       WHERE u.school_id = NEW.school_id AND u.id = NEW.decided_by
                         AND u.staff_id = NEW.staff_id);
    IF v_self AND NOT (NEW.status = 'approved' AND NEW.self_approved
                       AND asms_is_sole_principal(NEW.school_id, NEW.decided_by)) THEN
      v_refusal := 'leave_requests_not_self';
    ELSIF NOT v_self AND NEW.self_approved THEN
      v_refusal := 'leave_requests_self_approved_unwarranted';
    END IF;
  END IF;

  IF v_refusal IS NULL AND TG_OP = 'UPDATE'
     AND NEW.status = 'ended_early' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_actor := NULLIF(current_setting('asms.actor_user_id', true), '');
    IF v_actor IS NULL OR v_actor !~ '^[1-9][0-9]{0,18}$' THEN
      v_refusal := 'leave_requests_actor_required';
    ELSIF EXISTS (SELECT 1 FROM users u
                   WHERE u.school_id = NEW.school_id AND u.id = v_actor::bigint
                     AND u.staff_id = NEW.staff_id)
          AND NOT (OLD.self_approved AND asms_is_sole_principal(NEW.school_id, v_actor::bigint)) THEN
      v_refusal := 'leave_requests_not_self';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'nobody decides or ends their own leave (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "leave_requests_not_self" BEFORE INSERT OR UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_leave_request_not_self();

CREATE TRIGGER "leave_requests_no_delete" BEFORE DELETE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "leave_requests_no_truncate" BEFORE TRUNCATE ON "leave_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "leave_requests_school_id_immutable" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- the school's finance seeds gain the three leave types (§4, §1.1 item 22) ------------------

-- The slice-18 function, replaced with the leave types added (casual 10, sick 10, unpaid
-- unlimited; created_by null). Idempotent per part: a school holding any seeded head is not given
-- heads again, a school holding any seeded leave type is not given types again, the counter is
-- ON CONFLICT DO NOTHING. packages/shared SEEDED_LEAVE_TYPES mirrors the rows.
CREATE OR REPLACE FUNCTION asms_seed_school_finance(p_school_id bigint) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO "fee_heads" ("school_id", "name", "category", "frequency", "concession_eligible", "refundable")
  SELECT p_school_id, v.name, v.category::fee_head_category, v.frequency::fee_frequency, v.eligible, v.refundable
  FROM (VALUES
    (1, 'Tuition', 'tuition', 'monthly', true, true),
    (2, 'Admission', 'admission', 'once', true, false),
    (3, 'Annual charges', 'annual', 'yearly', true, true),
    (4, 'Exam', 'exam', 'per_term', true, true),
    (5, 'Fine', 'fine', 'ad_hoc', false, true)
  ) AS v(n, name, category, frequency, eligible, refundable)
  WHERE NOT EXISTS (
    SELECT 1 FROM "fee_heads" h WHERE h."school_id" = p_school_id AND h."created_by" IS NULL
  )
  ORDER BY v.n;

  INSERT INTO "leave_types" ("school_id", "name", "code", "days_per_year", "paid")
  SELECT p_school_id, v.name, v.code::leave_code, v.days, v.paid
  FROM (VALUES
    (1, 'Casual leave', 'casual', 10::smallint, true),
    (2, 'Sick leave', 'sick', 10::smallint, true),
    (3, 'Unpaid leave', 'unpaid', NULL::smallint, false)
  ) AS v(n, name, code, days, paid)
  WHERE NOT EXISTS (
    SELECT 1 FROM "leave_types" t WHERE t."school_id" = p_school_id AND t."created_by" IS NULL
  )
  ORDER BY v.n;

  INSERT INTO "school_counters" ("school_id", "name", "value")
  VALUES (p_school_id, 'expense_no', 0)
  ON CONFLICT ("school_id", "name") DO NOTHING;
$$;

-- Backfill: every existing school gets its three leave types. Written directly rather than by
-- calling the function: a school whose seeded fee heads were never written (its heads all made
-- by hand, e.g. one named 'Tuition') would otherwise be offered the five heads again and collide
-- with fee_heads_live_name_key. Heads and the counter exist since slice 18 and are left alone.
INSERT INTO "leave_types" ("school_id", "name", "code", "days_per_year", "paid")
SELECT s."id", v.name, v.code::leave_code, v.days, v.paid
FROM "schools" s
CROSS JOIN (VALUES
  (1, 'Casual leave', 'casual', 10::smallint, true),
  (2, 'Sick leave', 'sick', 10::smallint, true),
  (3, 'Unpaid leave', 'unpaid', NULL::smallint, false)
) AS v(n, name, code, days, paid)
WHERE NOT EXISTS (
  SELECT 1 FROM "leave_types" t WHERE t."school_id" = s."id" AND t."created_by" IS NULL
)
ORDER BY s."id", v.n;
