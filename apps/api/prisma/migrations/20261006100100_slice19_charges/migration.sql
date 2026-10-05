-- Slice 19 (wave I groundwork): concessions, concession heads, charge runs, charge campaigns and
-- their audiences, and charges (phase-3-financial.md §3.1, §3.2, §4 "Concessions, charges, runs",
-- R179-R186, R232, R239-R242, R252, R253), and the Phase 3 shared trigger functions.
-- Generated DDL first (prisma migrate diff, the create-only equivalent in a non-interactive
-- shell), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "concession_kind" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "concession_status" AS ENUM ('requested', 'approved', 'rejected', 'ended');

-- CreateEnum
CREATE TYPE "charge_kind" AS ENUM ('generated', 'campaign', 'manual', 'late_fee', 'adjustment');

-- CreateEnum
CREATE TYPE "charge_status" AS ENUM ('open', 'settled', 'voided', 'waived');

-- CreateEnum
CREATE TYPE "charge_run_kind" AS ENUM ('monthly', 'campaign');

-- CreateEnum
CREATE TYPE "charge_run_status" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('draft', 'generating', 'generated', 'cancelled');

-- CreateTable
CREATE TABLE "concessions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "kind" "concession_kind" NOT NULL,
    "value" INTEGER NOT NULL,
    "effective_from" CHAR(7) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "concession_status" NOT NULL DEFAULT 'requested',
    "requested_by" BIGINT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "end_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concession_heads" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "concession_id" BIGINT NOT NULL,
    "fee_head_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concession_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_runs" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "period" CHAR(7) NOT NULL,
    "kind" "charge_run_kind" NOT NULL,
    "campaign_id" BIGINT,
    "status" "charge_run_status" NOT NULL DEFAULT 'queued',
    "triggered_by" BIGINT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "students_charged" INTEGER NOT NULL DEFAULT 0,
    "charges_inserted" INTEGER NOT NULL DEFAULT 0,
    "charges_skipped" INTEGER NOT NULL DEFAULT 0,
    "skipped_classes" JSONB NOT NULL DEFAULT '[]',
    "regenerate_voided" BOOLEAN NOT NULL DEFAULT false,
    "error_code" VARCHAR(32),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_campaigns" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "fee_head_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "description" VARCHAR(500),
    "apply_concessions" BOOLEAN NOT NULL DEFAULT false,
    "status" "campaign_status" NOT NULL DEFAULT 'draft',
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_at" TIMESTAMPTZ(3),
    "generated_count" INTEGER,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_campaign_audiences" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "campaign_id" BIGINT NOT NULL,
    "kind" "audience_kind" NOT NULL,
    "class_id" BIGINT,
    "section_id" BIGINT,
    "student_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_campaign_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "fee_head_id" BIGINT NOT NULL,
    "head_frequency" "fee_frequency" NOT NULL,
    "kind" "charge_kind" NOT NULL,
    "period" CHAR(7),
    "campaign_id" BIGINT,
    "late_fee_for_charge_id" BIGINT,
    "adjusts_charge_id" BIGINT,
    "concession_id" BIGINT,
    "gross_amount" INTEGER NOT NULL,
    "concession_amount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "allocated_amount" INTEGER NOT NULL DEFAULT 0,
    "credited_amount" INTEGER NOT NULL DEFAULT 0,
    "description" VARCHAR(200) NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "charge_status" NOT NULL DEFAULT 'open',
    "settled_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "waived_at" TIMESTAMPTZ(3),
    "waived_by" BIGINT,
    "waive_reason" VARCHAR(500),
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concessions_school_id_student_id_academic_year_id_status_idx" ON "concessions"("school_id", "student_id", "academic_year_id", "status");

-- CreateIndex
CREATE INDEX "concessions_school_id_status_requested_at_idx" ON "concessions"("school_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "concessions_school_id_enrolment_id_idx" ON "concessions"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "concessions_school_id_requested_by_idx" ON "concessions"("school_id", "requested_by");

-- CreateIndex
CREATE INDEX "concessions_school_id_decided_by_idx" ON "concessions"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "concessions_school_id_ended_by_idx" ON "concessions"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "concessions_school_id_id_key" ON "concessions"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "concessions_school_id_id_student_id_academic_year_id_key" ON "concessions"("school_id", "id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "concession_heads_school_id_fee_head_id_idx" ON "concession_heads"("school_id", "fee_head_id");

-- CreateIndex
CREATE UNIQUE INDEX "concession_heads_school_id_id_key" ON "concession_heads"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "concession_heads_school_id_concession_id_fee_head_id_key" ON "concession_heads"("school_id", "concession_id", "fee_head_id");

-- CreateIndex
CREATE INDEX "charge_runs_school_id_academic_year_id_period_idx" ON "charge_runs"("school_id", "academic_year_id", "period");

-- CreateIndex
CREATE INDEX "charge_runs_school_id_status_queued_at_idx" ON "charge_runs"("school_id", "status", "queued_at");

-- CreateIndex
CREATE INDEX "charge_runs_school_id_campaign_id_idx" ON "charge_runs"("school_id", "campaign_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "charge_runs_school_id_triggered_by_idx" ON "charge_runs"("school_id", "triggered_by");

-- CreateIndex
CREATE UNIQUE INDEX "charge_runs_school_id_id_key" ON "charge_runs"("school_id", "id");

-- CreateIndex
CREATE INDEX "charge_campaigns_school_id_academic_year_id_status_idx" ON "charge_campaigns"("school_id", "academic_year_id", "status");

-- CreateIndex
CREATE INDEX "charge_campaigns_school_id_fee_head_id_idx" ON "charge_campaigns"("school_id", "fee_head_id");

-- CreateIndex
CREATE INDEX "charge_campaigns_school_id_created_by_idx" ON "charge_campaigns"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "charge_campaigns_school_id_cancelled_by_idx" ON "charge_campaigns"("school_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "charge_campaigns_school_id_id_key" ON "charge_campaigns"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_campaigns_school_id_id_academic_year_id_key" ON "charge_campaigns"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE INDEX "charge_campaign_audiences_school_id_campaign_id_idx" ON "charge_campaign_audiences"("school_id", "campaign_id");

-- CreateIndex
CREATE INDEX "charge_campaign_audiences_school_id_class_id_idx" ON "charge_campaign_audiences"("school_id", "class_id");

-- CreateIndex
CREATE INDEX "charge_campaign_audiences_school_id_section_id_idx" ON "charge_campaign_audiences"("school_id", "section_id");

-- CreateIndex
CREATE INDEX "charge_campaign_audiences_school_id_student_id_idx" ON "charge_campaign_audiences"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_campaign_audiences_school_id_id_key" ON "charge_campaign_audiences"("school_id", "id");

-- CreateIndex
CREATE INDEX "charges_school_id_student_id_due_on_idx" ON "charges"("school_id", "student_id", "due_on");

-- CreateIndex
CREATE INDEX "charges_school_id_status_due_on_idx" ON "charges"("school_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "charges_school_id_academic_year_id_period_idx" ON "charges"("school_id", "academic_year_id", "period");

-- CreateIndex
CREATE INDEX "charges_school_id_fee_head_id_idx" ON "charges"("school_id", "fee_head_id");

-- CreateIndex
CREATE INDEX "charges_school_id_enrolment_id_idx" ON "charges"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "charges_school_id_campaign_id_idx" ON "charges"("school_id", "campaign_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "charges_school_id_concession_id_idx" ON "charges"("school_id", "concession_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "charges_school_id_late_fee_for_charge_id_idx" ON "charges"("school_id", "late_fee_for_charge_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE INDEX "charges_school_id_adjusts_charge_id_idx" ON "charges"("school_id", "adjusts_charge_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE INDEX "charges_school_id_created_by_idx" ON "charges"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "charges_school_id_voided_by_idx" ON "charges"("school_id", "voided_by");

-- CreateIndex
CREATE INDEX "charges_school_id_waived_by_idx" ON "charges"("school_id", "waived_by");

-- CreateIndex
CREATE UNIQUE INDEX "charges_school_id_id_key" ON "charges"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "charges_school_id_id_academic_year_id_student_id_key" ON "charges"("school_id", "id", "academic_year_id", "student_id");

-- AddForeignKey
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_requested_by_fkey" FOREIGN KEY ("school_id", "requested_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concession_heads" ADD CONSTRAINT "concession_heads_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concession_heads" ADD CONSTRAINT "concession_heads_concession_id_fkey" FOREIGN KEY ("school_id", "concession_id") REFERENCES "concessions"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "concession_heads" ADD CONSTRAINT "concession_heads_fee_head_id_fkey" FOREIGN KEY ("school_id", "fee_head_id") REFERENCES "fee_heads"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_campaign_id_fkey" FOREIGN KEY ("school_id", "campaign_id", "academic_year_id") REFERENCES "charge_campaigns"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_triggered_by_fkey" FOREIGN KEY ("school_id", "triggered_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_fee_head_id_fkey" FOREIGN KEY ("school_id", "fee_head_id") REFERENCES "fee_heads"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_cancelled_by_fkey" FOREIGN KEY ("school_id", "cancelled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_campaign_id_fkey" FOREIGN KEY ("school_id", "campaign_id") REFERENCES "charge_campaigns"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_class_id_fkey" FOREIGN KEY ("school_id", "class_id") REFERENCES "classes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_section_id_fkey" FOREIGN KEY ("school_id", "section_id") REFERENCES "sections"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_fee_head_id_fkey" FOREIGN KEY ("school_id", "fee_head_id") REFERENCES "fee_heads"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_campaign_id_fkey" FOREIGN KEY ("school_id", "campaign_id", "academic_year_id") REFERENCES "charge_campaigns"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_late_fee_for_charge_id_fkey" FOREIGN KEY ("school_id", "late_fee_for_charge_id", "academic_year_id", "student_id") REFERENCES "charges"("school_id", "id", "academic_year_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_adjusts_charge_id_fkey" FOREIGN KEY ("school_id", "adjusts_charge_id", "academic_year_id", "student_id") REFERENCES "charges"("school_id", "id", "academic_year_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_concession_id_fkey" FOREIGN KEY ("school_id", "concession_id", "student_id", "academic_year_id") REFERENCES "concessions"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_waived_by_fkey" FOREIGN KEY ("school_id", "waived_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.1, §3.2, §4 "Concessions, charges, runs").
-- Generated SQL above (prisma migrate diff) reviewed: no drift lines. Every object here is listed
-- in test/guardrails/schema-checks.ts (WAVE_I_OBJECTS). Trigger functions raise SQLSTATE 23514
-- with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- shared trigger functions (Phase 3) ------------------------------------------------------

-- A status moves only along the transitions named in the trigger's arguments, each 'from:to', or
-- 'from:to:<setting>' for a transition allowed only while that TRANSACTION-LOCAL setting is 'on'
-- (set_config(<setting>, 'on', true), the attendance precedent). An update that keeps the status
-- passes. Constraint name '<table>_status_transition' (ILLEGAL_STATUS_TRANSITION).
CREATE FUNCTION asms_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rule text;
  v_parts text[];
  v_name CONSTANT text := TG_TABLE_NAME || '_status_transition';
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  FOREACH v_rule IN ARRAY TG_ARGV LOOP
    v_parts := string_to_array(v_rule, ':');
    IF v_parts[1] = OLD.status::text AND v_parts[2] = NEW.status::text
       AND (v_parts[3] IS NULL OR current_setting(v_parts[3], true) = 'on') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION '% may not move from % to %', TG_TABLE_NAME, OLD.status, NEW.status
    USING ERRCODE = 'check_violation',
          CONSTRAINT = v_name,
          DETAIL = 'constraint: ' || v_name,
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME,
          COLUMN = 'status';
END;
$$;

-- The columns named after the first argument may change only while the row's status (before the
-- update) is one of the comma-separated statuses in the first argument: a draft or open row is
-- edited in place, a decided one is history. Constraint name '<table>_<column>_frozen'.
CREATE FUNCTION asms_forbid_change_unless_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open CONSTANT text[] := string_to_array(TG_ARGV[0], ',');
  old_row CONSTANT jsonb := to_jsonb(OLD);
  new_row CONSTANT jsonb := to_jsonb(NEW);
  col text;
  i int;
BEGIN
  IF (old_row ->> 'status') = ANY (v_open) THEN
    RETURN NEW;
  END IF;
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    col := TG_ARGV[i];
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION '% is frozen on % outside status %', col, TG_TABLE_NAME, TG_ARGV[0]
        USING ERRCODE = 'check_violation',
              CONSTRAINT = TG_TABLE_NAME || '_' || col || '_frozen',
              DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_frozen',
              SCHEMA = TG_TABLE_SCHEMA,
              TABLE = TG_TABLE_NAME,
              COLUMN = col;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- R232 in SQL: the user's guardian record, merge-resolved (asms_guardian_merge_family), has a live
-- link to the student. The same predicate as StudentGuardianRepository.userIsLiveGuardianOf.
CREATE FUNCTION asms_user_is_guardian_of(p_school_id bigint, p_user_id bigint, p_student_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users u
    CROSS JOIN LATERAL asms_guardian_merge_family(p_school_id, u.guardian_id) AS fam(id)
    JOIN student_guardians sg ON sg.school_id = p_school_id AND sg.guardian_id = fam.id
    WHERE u.school_id = p_school_id
      AND u.id = p_user_id
      AND u.guardian_id IS NOT NULL
      AND sg.student_id = p_student_id
      AND sg.ended_at IS NULL
  );
$$;

-- R253: the user is the school's only active principal (a live principal role on an active user
-- whose staff record is active, as UserRoleRepository.countActivePrincipals counts). Takes the
-- lock on the school's school_settings row first, the lock every path that adds or removes a
-- principal takes (SchoolSettingsRepository.lock, PermissionsService.isSolePrincipal), so a second
-- principal appointed concurrently waits; VOLATILE, so the count after the lock reads a fresh
-- snapshot and sees a principal committed while it waited.
CREATE FUNCTION asms_is_sole_principal(p_school_id bigint, p_user_id bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM school_settings WHERE school_id = p_school_id FOR NO KEY UPDATE;
  RETURN EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN users u ON u.school_id = ur.school_id AND u.id = ur.user_id
           JOIN staff s ON s.school_id = u.school_id AND s.id = u.staff_id
           WHERE ur.school_id = p_school_id AND ur.user_id = p_user_id
             AND ur.system_role = 'principal' AND ur.ended_at IS NULL
             AND u.status = 'active' AND s.status = 'active')
     AND NOT EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN users u ON u.school_id = ur.school_id AND u.id = ur.user_id
           JOIN staff s ON s.school_id = u.school_id AND s.id = u.staff_id
           WHERE ur.school_id = p_school_id AND ur.user_id <> p_user_id
             AND ur.system_role = 'principal' AND ur.ended_at IS NULL
             AND u.status = 'active' AND s.status = 'active');
END;
$$;

-- ---- concessions (R182, R183, R232, R253) --------------------------------------------------------

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_value_check"
  CHECK (
    ("kind" = 'percentage' AND "value" BETWEEN 1 AND 100)
    OR ("kind" = 'fixed' AND "value" > 0)
  );

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_effective_from_check"
  CHECK ("effective_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_decision_reason_no_id_check"
  CHECK ("decision_reason" !~ '[0-9]{13}' AND "decision_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Decided iff no longer requested (an ended concession was approved first); a rejection says why.
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_decided_check"
  CHECK (
    ("status" <> 'requested') = ("decided_at" IS NOT NULL)
    AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
  );

ALTER TABLE "concessions" ADD CONSTRAINT "concessions_ended_check"
  CHECK (
    ("status" = 'ended') = ("ended_at" IS NOT NULL)
    AND ("ended_at" IS NULL) = ("ended_by" IS NULL)
    AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
  );

-- Only an approval is self-approved (it stays so once ended).
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_self_approved_check"
  CHECK (NOT "self_approved" OR "status" IN ('approved', 'ended'));

-- R183: requested -> approved | rejected; approved -> ended. A row is inserted requested, or
-- approved by a principal holding both keys.
CREATE TRIGGER "concessions_status_transition" BEFORE UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('requested:approved', 'requested:rejected', 'approved:ended');

CREATE TRIGGER "concessions_columns_immutable" BEFORE UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'academic_year_id', 'enrolment_id', 'kind', 'value', 'effective_from', 'reason',
    'requested_by', 'requested_at', 'created_at');

CREATE TRIGGER "concessions_decided_frozen" BEFORE UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'decided_at', 'decided_by', 'decision_reason', 'self_approved');

CREATE TRIGGER "concessions_ended_frozen" BEFORE UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by', 'end_reason');

-- R232, R253: approving (or creating approved) a concession for the decider's own child is refused
-- (concessions_own_child), except by the sole active principal recording self_approved; a
-- self_approved row that is not the decider's own child is refused too
-- (concessions_self_approved_unwarranted), so the dashboard's self-approved count is true.
CREATE FUNCTION asms_concession_own_child() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.status = 'approved' AND NEW.decided_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF asms_user_is_guardian_of(NEW.school_id, NEW.decided_by, NEW.student_id) THEN
      IF NOT (NEW.self_approved AND asms_is_sole_principal(NEW.school_id, NEW.decided_by)) THEN
        v_refusal := 'concessions_own_child';
      END IF;
    ELSIF NEW.self_approved THEN
      v_refusal := 'concessions_self_approved_unwarranted';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'a concession decision for the decider''s own child is refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "concessions_own_child" BEFORE INSERT OR UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_concession_own_child();

CREATE TRIGGER "concessions_no_delete" BEFORE DELETE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "concessions_no_truncate" BEFORE TRUNCATE ON "concessions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "concessions_school_id_immutable" BEFORE UPDATE ON "concessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- concession_heads (append-only) ----------------------------------------------------------

CREATE TRIGGER "concession_heads_columns_immutable" BEFORE UPDATE ON "concession_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('concession_id', 'fee_head_id', 'created_at');

CREATE TRIGGER "concession_heads_no_delete" BEFORE DELETE ON "concession_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "concession_heads_no_truncate" BEFORE TRUNCATE ON "concession_heads"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "concession_heads_school_id_immutable" BEFORE UPDATE ON "concession_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- charge_campaigns (R184) -------------------------------------------------------------------

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_description_check"
  CHECK ("description" IS NULL OR ("description" = btrim("description") AND "description" <> ''));

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_description_no_id_check"
  CHECK ("description" !~ '[0-9]{13}' AND "description" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_cancel_reason_no_id_check"
  CHECK ("cancel_reason" !~ '[0-9]{13}' AND "cancel_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_amount_check"
  CHECK ("amount" > 0);

-- Generated: both stamps, kept if the generated campaign is later cancelled.
ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_generated_check"
  CHECK (
    ("generated_at" IS NULL) = ("generated_count" IS NULL)
    AND ("generated_count" IS NULL OR "generated_count" >= 0)
    AND ("status" <> 'generated' OR "generated_at" IS NOT NULL)
    AND ("status" NOT IN ('draft', 'generating') OR "generated_at" IS NULL)
  );

ALTER TABLE "charge_campaigns" ADD CONSTRAINT "charge_campaigns_cancelled_check"
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
  );

-- draft -> generating | cancelled; generating -> generated, or back to draft when its run fails or
-- goes stale (R252); generated -> cancelled (voids nothing).
CREATE TRIGGER "charge_campaigns_status_transition" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'draft:generating', 'draft:cancelled', 'generating:generated', 'generating:draft', 'generated:cancelled');

CREATE TRIGGER "charge_campaigns_columns_immutable" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('created_by', 'created_at');

-- PATCH edits a draft; once generating, the campaign's content is what was charged.
CREATE TRIGGER "charge_campaigns_content_frozen" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'draft', 'name', 'academic_year_id', 'fee_head_id', 'amount', 'due_on', 'description',
    'apply_concessions');

CREATE TRIGGER "charge_campaigns_generated_frozen" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('generated_at', 'generated_count');

CREATE TRIGGER "charge_campaigns_cancelled_frozen" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason');

CREATE TRIGGER "charge_campaigns_no_delete" BEFORE DELETE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charge_campaigns_no_truncate" BEFORE TRUNCATE ON "charge_campaigns"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charge_campaigns_school_id_immutable" BEFORE UPDATE ON "charge_campaigns"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- charge_campaign_audiences -----------------------------------------------------------------

-- The student kinds of the slice-14 resolver only (§5 slice 19).
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_kind_check"
  CHECK ("kind" IN ('everyone', 'students', 'class', 'section', 'student'));

-- Exactly the foreign key the kind names is set (announcement_audiences_target_check's shape).
ALTER TABLE "charge_campaign_audiences" ADD CONSTRAINT "charge_campaign_audiences_target_check"
  CHECK (
    ("class_id" IS NOT NULL) = ("kind" = 'class')
    AND ("section_id" IS NOT NULL) = ("kind" = 'section')
    AND ("student_id" IS NOT NULL) = ("kind" = 'student')
  );

CREATE UNIQUE INDEX "charge_campaign_audiences_target_key" ON "charge_campaign_audiences" (
  "school_id", "campaign_id", "kind",
  COALESCE("class_id", 0), COALESCE("section_id", 0), COALESCE("student_id", 0));

CREATE TRIGGER "charge_campaign_audiences_columns_immutable" BEFORE UPDATE ON "charge_campaign_audiences"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'campaign_id', 'kind', 'class_id', 'section_id', 'student_id', 'created_at');

-- A draft's audience is a form field, replaced on PATCH (the announcement precedent, decision 12);
-- once the campaign leaves draft its audience is history: no insert, update or delete.
CREATE FUNCTION asms_charge_campaign_audience_draft_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row charge_campaign_audiences;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM charge_campaigns c
    WHERE c.school_id = v_row.school_id AND c.id = v_row.campaign_id AND c.status = 'draft'
  ) THEN
    RAISE EXCEPTION 'a campaign''s audience changes only while it is a draft'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_campaign_audiences_draft_only',
            DETAIL = 'constraint: charge_campaign_audiences_draft_only',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "charge_campaign_audiences_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "charge_campaign_audiences"
  FOR EACH ROW EXECUTE FUNCTION asms_charge_campaign_audience_draft_only();

CREATE TRIGGER "charge_campaign_audiences_no_truncate" BEFORE TRUNCATE ON "charge_campaign_audiences"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charge_campaign_audiences_school_id_immutable" BEFORE UPDATE ON "charge_campaign_audiences"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- charge_runs (§3.7, R179, R252) --------------------------------------------------------------

ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_period_check"
  CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_campaign_check"
  CHECK (("kind" = 'campaign') = ("campaign_id" IS NOT NULL));

ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_regenerate_voided_check"
  CHECK (NOT "regenerate_voided" OR "kind" = 'monthly');

ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_counts_check"
  CHECK ("students_charged" >= 0 AND "charges_inserted" >= 0 AND "charges_skipped" >= 0);

-- running has started; done and failed have finished; done ran (a stale queued run fails unstarted).
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_times_check"
  CHECK (
    ("status" IN ('done', 'failed')) = ("finished_at" IS NOT NULL)
    AND ("status" NOT IN ('running', 'done') OR "started_at" IS NOT NULL)
    AND ("status" <> 'queued' OR "started_at" IS NULL)
  );

-- A failed run says why ('stale' from the sweep); no other run carries a code.
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_error_code_check"
  CHECK (
    ("status" = 'failed') = ("error_code" IS NOT NULL)
    AND ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z_]{0,31}$')
  );

-- `[{ classId, reason }]`: an array of objects carrying no key outside the allowlist (§4).
ALTER TABLE "charge_runs" ADD CONSTRAINT "charge_runs_skipped_classes_check"
  CHECK (
    jsonb_typeof("skipped_classes") = 'array'
    AND NOT jsonb_path_exists("skipped_classes", '$[*] ? (@.type() != "object")', '{}', true)
    AND NOT jsonb_path_exists(
      "skipped_classes", '$[*].keyvalue() ? (@.key != "classId" && @.key != "reason")', '{}', true)
  );

-- At most one queued or running run per year, period and kind (§4).
CREATE UNIQUE INDEX "charge_runs_period_key" ON "charge_runs" ("school_id", "academic_year_id", "period", "kind")
  WHERE "status" IN ('queued', 'running');

-- queued -> running -> done | failed; queued -> failed (the stale sweep, R252).
CREATE TRIGGER "charge_runs_status_transition" BEFORE UPDATE ON "charge_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'queued:running', 'queued:failed', 'running:done', 'running:failed');

CREATE TRIGGER "charge_runs_columns_immutable" BEFORE UPDATE ON "charge_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'period', 'kind', 'campaign_id', 'triggered_by', 'queued_at',
    'regenerate_voided');

CREATE TRIGGER "charge_runs_finished_frozen" BEFORE UPDATE ON "charge_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'finished_at', 'started_at', 'students_charged', 'charges_inserted', 'charges_skipped',
    'skipped_classes', 'error_code');

CREATE TRIGGER "charge_runs_no_delete" BEFORE DELETE ON "charge_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charge_runs_no_truncate" BEFORE TRUNCATE ON "charge_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charge_runs_school_id_immutable" BEFORE UPDATE ON "charge_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- charges (R179-R186, R239-R241; §3.2) ------------------------------------------------------

ALTER TABLE "charges" ADD CONSTRAINT "charges_gross_amount_check"
  CHECK ("gross_amount" >= 0);

ALTER TABLE "charges" ADD CONSTRAINT "charges_concession_amount_check"
  CHECK ("concession_amount" >= 0);

-- Rule 0.18: the concession is applied once and stored; amount is what is owed.
ALTER TABLE "charges" ADD CONSTRAINT "charges_amount_check"
  CHECK ("amount" >= 0 AND "amount" = "gross_amount" - "concession_amount");

-- §3.2: the two counters, maintained by increment triggers, bounded here (23514 ->
-- CONCURRENT_UPDATE, retried once).
ALTER TABLE "charges" ADD CONSTRAINT "charges_allocated_amount_check"
  CHECK ("allocated_amount" >= 0 AND "allocated_amount" + "credited_amount" <= "amount");

ALTER TABLE "charges" ADD CONSTRAINT "charges_credited_amount_check"
  CHECK ("credited_amount" >= 0);

ALTER TABLE "charges" ADD CONSTRAINT "charges_period_check"
  CHECK ("period" IS NULL OR "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- A generated monthly charge has a period; a generated once or yearly charge has none.
ALTER TABLE "charges" ADD CONSTRAINT "charges_generated_period_check"
  CHECK ("kind" <> 'generated' OR (("head_frequency" = 'monthly') = ("period" IS NOT NULL)));

-- The job generates monthly and yearly heads; admission writes the once head.
ALTER TABLE "charges" ADD CONSTRAINT "charges_generated_frequency_check"
  CHECK ("kind" <> 'generated' OR "head_frequency" IN ('monthly', 'once', 'yearly'));

ALTER TABLE "charges" ADD CONSTRAINT "charges_late_fee_target_check"
  CHECK (("kind" = 'late_fee') = ("late_fee_for_charge_id" IS NOT NULL));

-- A late fee copies its target's period (charges_late_fee_key needs one).
ALTER TABLE "charges" ADD CONSTRAINT "charges_late_fee_period_check"
  CHECK ("kind" <> 'late_fee' OR "period" IS NOT NULL);

ALTER TABLE "charges" ADD CONSTRAINT "charges_adjustment_check"
  CHECK (("kind" = 'adjustment') = ("adjusts_charge_id" IS NOT NULL));

ALTER TABLE "charges" ADD CONSTRAINT "charges_campaign_check"
  CHECK (("kind" = 'campaign') = ("campaign_id" IS NOT NULL));

-- An adjustment is a credit: its own settled row, > 0, never allocated or credited itself.
ALTER TABLE "charges" ADD CONSTRAINT "charges_adjustment_row_check"
  CHECK (
    "kind" <> 'adjustment'
    OR ("status" = 'settled' AND "amount" > 0 AND "allocated_amount" = 0 AND "credited_amount" = 0)
  );

ALTER TABLE "charges" ADD CONSTRAINT "charges_settled_check"
  CHECK (("status" = 'settled') = ("settled_at" IS NOT NULL));

-- Open means something is owed; settled means nothing is (R241: an amount of 0 is settled at
-- birth). Whatever raises allocated_amount or credited_amount to the amount settles the charge in
-- the same statement, and whatever lowers them reopens it.
ALTER TABLE "charges" ADD CONSTRAINT "charges_settled_outstanding_check"
  CHECK (
    "kind" = 'adjustment'
    OR "status" IN ('voided', 'waived')
    OR (("status" = 'settled') = ("allocated_amount" + "credited_amount" = "amount"))
  );

-- R186, R185: voided or waived only with no live allocation.
ALTER TABLE "charges" ADD CONSTRAINT "charges_closed_unallocated_check"
  CHECK ("status" NOT IN ('voided', 'waived') OR "allocated_amount" = 0);

ALTER TABLE "charges" ADD CONSTRAINT "charges_voided_check"
  CHECK (
    ("status" = 'voided') = ("voided_at" IS NOT NULL)
    AND ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

-- Only a late fee is waived (R185).
ALTER TABLE "charges" ADD CONSTRAINT "charges_waived_check"
  CHECK (
    ("status" = 'waived') = ("waived_at" IS NOT NULL)
    AND ("waived_at" IS NULL) = ("waived_by" IS NULL)
    AND ("waived_at" IS NULL) = ("waive_reason" IS NULL)
    AND ("status" <> 'waived' OR "kind" = 'late_fee')
  );

ALTER TABLE "charges" ADD CONSTRAINT "charges_description_check"
  CHECK ("description" = btrim("description") AND "description" <> '');

ALTER TABLE "charges" ADD CONSTRAINT "charges_description_no_id_check"
  CHECK ("description" !~ '[0-9]{13}' AND "description" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "charges" ADD CONSTRAINT "charges_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "charges" ADD CONSTRAINT "charges_waive_reason_no_id_check"
  CHECK ("waive_reason" !~ '[0-9]{13}' AND "waive_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- The idempotency keys (§4). Each ON CONFLICT names the columns and repeats the predicate exactly;
-- `status <> 'voided'` is what lets a regenerateVoided run recreate a voided charge, and the
-- scheduled run's NOT EXISTS (voided rows included) what stops one returning by itself.
CREATE UNIQUE INDEX "charges_generated_key" ON "charges" ("school_id", "student_id", "fee_head_id", "period")
  WHERE "kind" = 'generated' AND "head_frequency" = 'monthly' AND "status" <> 'voided';

CREATE UNIQUE INDEX "charges_once_key" ON "charges" ("school_id", "student_id", "fee_head_id", "enrolment_id")
  WHERE "kind" = 'generated' AND "head_frequency" = 'once' AND "status" <> 'voided';

CREATE UNIQUE INDEX "charges_yearly_key" ON "charges" ("school_id", "student_id", "fee_head_id", "academic_year_id")
  WHERE "kind" = 'generated' AND "head_frequency" = 'yearly' AND "status" <> 'voided';

CREATE UNIQUE INDEX "charges_late_fee_key" ON "charges" ("school_id", "student_id", "period")
  WHERE "kind" = 'late_fee' AND "status" <> 'voided';

CREATE UNIQUE INDEX "charges_campaign_key" ON "charges" ("school_id", "campaign_id", "enrolment_id")
  WHERE "campaign_id" IS NOT NULL;

-- The defaulters report and the counter's dues read open charges per student from the index alone
-- (R203).
CREATE INDEX "charges_open_by_student_idx" ON "charges" ("school_id", "student_id")
  INCLUDE ("amount", "allocated_amount", "credited_amount", "due_on")
  WHERE "status" = 'open';

-- open -> settled | voided | waived; settled -> open only while slice 20's reversal trigger has
-- set asms.reversing_payment (set_config('asms.reversing_payment', 'on', true)).
CREATE TRIGGER "charges_status_transition" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'open:settled', 'open:voided', 'open:waived', 'settled:open:asms.reversing_payment');

-- Rule 0.19 / R186: everything but the status, counter, settle, void and waive columns is frozen.
CREATE TRIGGER "charges_columns_immutable" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'enrolment_id', 'student_id', 'academic_year_id', 'fee_head_id', 'head_frequency', 'kind',
    'period', 'campaign_id', 'late_fee_for_charge_id', 'adjusts_charge_id', 'concession_id',
    'gross_amount', 'concession_amount', 'amount', 'description', 'due_on', 'created_by',
    'created_at');

CREATE TRIGGER "charges_voided_frozen" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

CREATE TRIGGER "charges_waived_frozen" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('waived_at', 'waived_by', 'waive_reason');

-- R232, R253 for the charge-side verbs: a void (voided_by), a waiver (waived_by) and an adjustment
-- (the adjustment row's created_by) for the actor's own child are refused (charges_own_child),
-- except by the sole active principal (selfApproved goes in the audit metadata; charges carry no
-- column for it). Job writes (created_by null) are never refused.
CREATE FUNCTION asms_charge_own_child() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'adjustment' THEN
      v_actor := NEW.created_by;
    END IF;
  ELSIF NEW.status = 'voided' AND OLD.status <> 'voided' THEN
    v_actor := NEW.voided_by;
  ELSIF NEW.status = 'waived' AND OLD.status <> 'waived' THEN
    v_actor := NEW.waived_by;
  END IF;
  IF v_actor IS NOT NULL
     AND asms_user_is_guardian_of(NEW.school_id, v_actor, NEW.student_id)
     AND NOT asms_is_sole_principal(NEW.school_id, v_actor) THEN
    RAISE EXCEPTION 'nobody corrects a charge of their own child'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charges_own_child',
            DETAIL = 'constraint: charges_own_child',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "charges_own_child" BEFORE INSERT OR UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_charge_own_child();

-- §3.2, R186: an adjustment row raises the original's credited_amount by its amount, under the
-- original's row lock, and settles the original when nothing is left owed. The original must be
-- open (charges_adjustment_target_open); a credit beyond outstanding fails
-- charges_allocated_amount_check (23514), so the service de-allocates first (slice 20).
CREATE FUNCTION asms_charge_adjustment_credit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE charges c
  SET credited_amount = c.credited_amount + NEW.amount,
      status = CASE WHEN c.allocated_amount + c.credited_amount + NEW.amount = c.amount
                    THEN 'settled'::charge_status ELSE c.status END,
      settled_at = CASE WHEN c.allocated_amount + c.credited_amount + NEW.amount = c.amount
                        THEN now() ELSE c.settled_at END
  WHERE c.school_id = NEW.school_id AND c.id = NEW.adjusts_charge_id AND c.status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an adjustment credits an open charge'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charges_adjustment_target_open',
            DETAIL = 'constraint: charges_adjustment_target_open',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "charges_adjustment_credit" AFTER INSERT ON "charges"
  FOR EACH ROW WHEN (NEW.kind = 'adjustment') EXECUTE FUNCTION asms_charge_adjustment_credit();

CREATE TRIGGER "charges_no_delete" BEFORE DELETE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charges_no_truncate" BEFORE TRUNCATE ON "charges"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "charges_school_id_immutable" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
