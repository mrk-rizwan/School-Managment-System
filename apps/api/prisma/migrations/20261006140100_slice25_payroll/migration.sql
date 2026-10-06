-- Slice 25 (wave J groundwork): salary structures and their components, salary advances, payroll
-- runs, payslips and their lines, and advance recoveries (phase-3-financial.md §3.2, §3.3, §4
-- "Payroll", R213-R218, R235, R245-R247, R253). Calendar-scoped: no academic year.
-- Generated DDL first (prisma migrate diff, the create-only equivalent in a non-interactive
-- shell), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "salary_structure_status" AS ENUM ('active', 'superseded');

-- CreateEnum
CREATE TYPE "salary_component_kind" AS ENUM ('allowance', 'deduction');

-- CreateEnum
CREATE TYPE "advance_status" AS ENUM ('open', 'recovered', 'written_off');

-- CreateEnum
CREATE TYPE "payroll_run_status" AS ENUM ('draft', 'finalised');

-- CreateEnum
CREATE TYPE "payslip_status" AS ENUM ('pending', 'paid');

-- CreateEnum
CREATE TYPE "payslip_line_kind" AS ENUM ('allowance', 'deduction', 'absence', 'advance_recovery', 'adjustment');

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "basic" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "ended_on" DATE,
    "status" "salary_structure_status" NOT NULL DEFAULT 'active',
    "superseded_at" TIMESTAMPTZ(3),
    "superseded_by" BIGINT,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" BIGINT NOT NULL,
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure_components" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "structure_id" BIGINT NOT NULL,
    "kind" "salary_component_kind" NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "amount" INTEGER NOT NULL,
    "position" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structure_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advances" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "granted_on" DATE NOT NULL,
    "recover_from" CHAR(7) NOT NULL,
    "instalment_amount" INTEGER NOT NULL,
    "approved_by" BIGINT NOT NULL,
    "paid_method" "payment_method" NOT NULL,
    "paid_reference" VARCHAR(60),
    "expense_id" BIGINT,
    "recovered_amount" INTEGER NOT NULL DEFAULT 0,
    "status" "advance_status" NOT NULL DEFAULT 'open',
    "written_off_at" TIMESTAMPTZ(3),
    "written_off_by" BIGINT,
    "write_off_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "year_month" CHAR(7) NOT NULL,
    "working_days" SMALLINT NOT NULL,
    "status" "payroll_run_status" NOT NULL DEFAULT 'draft',
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prepared_by" BIGINT,
    "finalised_by" BIGINT,
    "finalised_at" TIMESTAMPTZ(3),
    "finalise_reason" VARCHAR(500),
    "staff_count" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "total_net" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "run_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "structure_id" BIGINT NOT NULL,
    "employed_working_days" SMALLINT NOT NULL,
    "basic" INTEGER NOT NULL,
    "allowances_total" INTEGER NOT NULL,
    "deductions_total" INTEGER NOT NULL,
    "unpaid_days" SMALLINT NOT NULL,
    "unmarked_days" SMALLINT NOT NULL,
    "absence_deduction" INTEGER NOT NULL,
    "advance_recovery" INTEGER NOT NULL,
    "adjustment_total" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL,
    "status" "payslip_status" NOT NULL DEFAULT 'pending',
    "paid_on" DATE,
    "paid_method" "payment_method",
    "paid_reference" VARCHAR(60),
    "paid_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "payslip_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "kind" "payslip_line_kind" NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "amount" INTEGER NOT NULL,
    "adjusts_payslip_id" BIGINT,
    "reason" VARCHAR(500),
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advance_recoveries" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "advance_id" BIGINT NOT NULL,
    "payslip_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_advance_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_structures_school_id_staff_id_effective_from_idx" ON "salary_structures"("school_id", "staff_id", "effective_from");

-- CreateIndex
CREATE INDEX "salary_structures_school_id_superseded_by_idx" ON "salary_structures"("school_id", "superseded_by", "staff_id");

-- CreateIndex
CREATE INDEX "salary_structures_school_id_created_by_idx" ON "salary_structures"("school_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_school_id_id_key" ON "salary_structures"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_school_id_id_staff_id_key" ON "salary_structures"("school_id", "id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_components_school_id_id_key" ON "salary_structure_components"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_components_name_key" ON "salary_structure_components"("school_id", "structure_id", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_components_position_key" ON "salary_structure_components"("school_id", "structure_id", "position");

-- CreateIndex
CREATE INDEX "salary_advances_school_id_staff_id_status_idx" ON "salary_advances"("school_id", "staff_id", "status");

-- CreateIndex
CREATE INDEX "salary_advances_school_id_approved_by_idx" ON "salary_advances"("school_id", "approved_by");

-- CreateIndex
CREATE INDEX "salary_advances_school_id_written_off_by_idx" ON "salary_advances"("school_id", "written_off_by");

-- CreateIndex
CREATE INDEX "salary_advances_school_id_expense_id_idx" ON "salary_advances"("school_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_school_id_id_key" ON "salary_advances"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_school_id_id_staff_id_key" ON "salary_advances"("school_id", "id", "staff_id");

-- CreateIndex
CREATE INDEX "payroll_runs_school_id_prepared_by_idx" ON "payroll_runs"("school_id", "prepared_by");

-- CreateIndex
CREATE INDEX "payroll_runs_school_id_finalised_by_idx" ON "payroll_runs"("school_id", "finalised_by");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_school_id_id_key" ON "payroll_runs"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_month_key" ON "payroll_runs"("school_id", "year_month");

-- CreateIndex
CREATE INDEX "payslips_school_id_staff_id_run_id_idx" ON "payslips"("school_id", "staff_id", "run_id");

-- CreateIndex
CREATE INDEX "payslips_school_id_run_id_status_idx" ON "payslips"("school_id", "run_id", "status");

-- CreateIndex
CREATE INDEX "payslips_school_id_structure_id_idx" ON "payslips"("school_id", "structure_id", "staff_id");

-- CreateIndex
CREATE INDEX "payslips_school_id_paid_by_idx" ON "payslips"("school_id", "paid_by");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_school_id_id_key" ON "payslips"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_school_id_id_staff_id_key" ON "payslips"("school_id", "id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_run_staff_key" ON "payslips"("school_id", "run_id", "staff_id");

-- CreateIndex
CREATE INDEX "payslip_lines_school_id_payslip_id_idx" ON "payslip_lines"("school_id", "payslip_id", "staff_id");

-- CreateIndex
CREATE INDEX "payslip_lines_school_id_adjusts_payslip_id_idx" ON "payslip_lines"("school_id", "adjusts_payslip_id", "staff_id");

-- CreateIndex
CREATE INDEX "payslip_lines_school_id_created_by_idx" ON "payslip_lines"("school_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "payslip_lines_school_id_id_key" ON "payslip_lines"("school_id", "id");

-- CreateIndex
CREATE INDEX "salary_advance_recoveries_school_id_advance_id_idx" ON "salary_advance_recoveries"("school_id", "advance_id", "staff_id");

-- CreateIndex
CREATE INDEX "salary_advance_recoveries_school_id_payslip_id_idx" ON "salary_advance_recoveries"("school_id", "payslip_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advance_recoveries_school_id_id_key" ON "salary_advance_recoveries"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advance_recoveries_advance_payslip_key" ON "salary_advance_recoveries"("school_id", "advance_id", "payslip_id");

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_superseded_by_fkey" FOREIGN KEY ("school_id", "superseded_by", "staff_id") REFERENCES "salary_structures"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_structure_id_fkey" FOREIGN KEY ("school_id", "structure_id") REFERENCES "salary_structures"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_approved_by_fkey" FOREIGN KEY ("school_id", "approved_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_written_off_by_fkey" FOREIGN KEY ("school_id", "written_off_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_expense_id_fkey" FOREIGN KEY ("school_id", "expense_id") REFERENCES "expenses"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_prepared_by_fkey" FOREIGN KEY ("school_id", "prepared_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalised_by_fkey" FOREIGN KEY ("school_id", "finalised_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("school_id", "run_id") REFERENCES "payroll_runs"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_structure_id_fkey" FOREIGN KEY ("school_id", "structure_id", "staff_id") REFERENCES "salary_structures"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_by_fkey" FOREIGN KEY ("school_id", "paid_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_fkey" FOREIGN KEY ("school_id", "payslip_id", "staff_id") REFERENCES "payslips"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_adjusts_payslip_id_fkey" FOREIGN KEY ("school_id", "adjusts_payslip_id", "staff_id") REFERENCES "payslips"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advance_recoveries" ADD CONSTRAINT "salary_advance_recoveries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advance_recoveries" ADD CONSTRAINT "salary_advance_recoveries_advance_id_fkey" FOREIGN KEY ("school_id", "advance_id", "staff_id") REFERENCES "salary_advances"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "salary_advance_recoveries" ADD CONSTRAINT "salary_advance_recoveries_payslip_id_fkey" FOREIGN KEY ("school_id", "payslip_id", "staff_id") REFERENCES "payslips"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.1, §3.2, §3.3, §4 "Payroll", R213-R218,
-- R235, R245-R247, R253). Generated SQL above (prisma migrate diff) reviewed: no drift lines.
-- Every object here is listed in test/guardrails/schema-checks.ts (WAVE_J_OBJECTS). Trigger
-- functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- salary_structures (R213, R235, R253) ------------------------------------------------------

ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_basic_check"
  CHECK ("basic" >= 0);

ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_dates_check"
  CHECK ("ended_on" IS NULL OR "ended_on" >= "effective_from");

-- Superseded iff stamped; superseded_by is written after the replacement exists (the
-- fee_structures precedent) and never names the row itself.
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_superseded_check"
  CHECK (
    ("status" = 'superseded') = ("superseded_at" IS NOT NULL)
    AND ("superseded_by" IS NULL OR "status" = 'superseded')
    AND ("superseded_by" IS NULL OR "superseded_by" <> "id")
  );

ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One active structure per staff member on any day. Inclusive ranges; a null ended_on is
-- open-ended (btree_gist, slice 4). SQLSTATE 23P01; the name is in the message.
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_live_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "staff_id" WITH =,
    daterange("effective_from", "ended_on", '[]') WITH &&
  ) WHERE ("status" = 'active');

CREATE TRIGGER "salary_structures_status_transition" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('active:superseded');

CREATE TRIGGER "salary_structures_columns_immutable" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'basic', 'effective_from', 'reason', 'created_by', 'self_approved', 'created_at');

CREATE TRIGGER "salary_structures_ended_on_frozen" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_on');

CREATE TRIGGER "salary_structures_superseded_frozen" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at', 'status');

CREATE TRIGGER "salary_structures_superseded_by_frozen" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_by');

-- R235, R253: nobody writes their own salary structure, except the sole active principal
-- recording self_approved; self_approved on anyone else's structure is refused
-- (salary_structures_self_approved_unwarranted), so the dashboard's count is true.
CREATE FUNCTION asms_salary_structure_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
  v_self boolean;
BEGIN
  v_self := EXISTS (SELECT 1 FROM users u
                     WHERE u.school_id = NEW.school_id AND u.id = NEW.created_by
                       AND u.staff_id = NEW.staff_id);
  IF v_self AND NOT (NEW.self_approved AND asms_is_sole_principal(NEW.school_id, NEW.created_by)) THEN
    v_refusal := 'salary_structures_not_self';
  ELSIF NOT v_self AND NEW.self_approved THEN
    v_refusal := 'salary_structures_self_approved_unwarranted';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'nobody writes their own salary structure (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "salary_structures_not_self" BEFORE INSERT ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_salary_structure_not_self();

CREATE TRIGGER "salary_structures_no_delete" BEFORE DELETE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_structures_no_truncate" BEFORE TRUNCATE ON "salary_structures"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_structures_school_id_immutable" BEFORE UPDATE ON "salary_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- salary_structure_components (append-only) -------------------------------------------------

ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_amount_check"
  CHECK ("amount" > 0);

ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_position_check"
  CHECK ("position" BETWEEN 0 AND 19);

ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "salary_structure_components_columns_immutable" BEFORE UPDATE ON "salary_structure_components"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'structure_id', 'kind', 'name', 'amount', 'position', 'created_at');

CREATE TRIGGER "salary_structure_components_no_delete" BEFORE DELETE ON "salary_structure_components"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_structure_components_no_truncate" BEFORE TRUNCATE ON "salary_structure_components"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_structure_components_school_id_immutable" BEFORE UPDATE ON "salary_structure_components"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- salary_advances (R215, R235, R247) --------------------------------------------------------

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_amount_check"
  CHECK ("amount" > 0);

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_instalment_amount_check"
  CHECK ("instalment_amount" > 0 AND "instalment_amount" <= "amount");

-- §3.2: the counter, raised only by salary_advance_recoveries_apply.
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_recovered_check"
  CHECK ("recovered_amount" >= 0 AND "recovered_amount" <= "amount");

-- Recovered iff fully repaid (an open or written-off advance still has something outstanding).
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_status_check"
  CHECK (("status" = 'recovered') = ("recovered_amount" = "amount"));

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_recover_from_check"
  CHECK ("recover_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- carried_forward is a payment-only method (A8).
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_paid_method_check"
  CHECK ("paid_method" <> 'carried_forward');

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_paid_reference_check"
  CHECK ("paid_reference" IS NULL OR ("paid_reference" = btrim("paid_reference") AND "paid_reference" <> ''));

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_paid_reference_no_id_check"
  CHECK ("paid_reference" !~ '[0-9]{13}' AND "paid_reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_written_off_check"
  CHECK (
    ("status" = 'written_off') = ("written_off_at" IS NOT NULL)
    AND ("written_off_at" IS NULL) = ("written_off_by" IS NULL)
    AND ("written_off_at" IS NULL) = ("write_off_reason" IS NULL)
  );

ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_write_off_reason_no_id_check"
  CHECK ("write_off_reason" !~ '[0-9]{13}' AND "write_off_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One advance per salary_advance_cash expense.
CREATE UNIQUE INDEX "salary_advances_expense_key" ON "salary_advances" ("school_id", "expense_id")
  WHERE "expense_id" IS NOT NULL;

-- open -> recovered (salary_advance_recoveries_apply) | written_off.
CREATE TRIGGER "salary_advances_status_transition" BEFORE UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:recovered', 'open:written_off');

CREATE TRIGGER "salary_advances_columns_immutable" BEFORE UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'amount', 'granted_on', 'recover_from', 'instalment_amount', 'approved_by',
    'paid_method', 'paid_reference', 'expense_id', 'created_at');

CREATE TRIGGER "salary_advances_written_off_frozen" BEFORE UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'written_off_at', 'written_off_by', 'write_off_reason');

-- R235: nobody grants or writes off their own advance; no sole-principal exception (cash).
CREATE FUNCTION asms_salary_advance_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users u
    WHERE u.school_id = NEW.school_id AND u.staff_id = NEW.staff_id
      AND ((TG_OP = 'INSERT' AND u.id = NEW.approved_by)
           OR (NEW.written_off_by IS NOT NULL
               AND (TG_OP = 'INSERT' OR OLD.written_off_by IS NULL)
               AND u.id = NEW.written_off_by))
  ) THEN
    RAISE EXCEPTION 'nobody grants or writes off their own salary advance'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'salary_advances_not_self',
            DETAIL = 'constraint: salary_advances_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "salary_advances_not_self" BEFORE INSERT OR UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_salary_advance_not_self();

CREATE TRIGGER "salary_advances_no_delete" BEFORE DELETE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_advances_no_truncate" BEFORE TRUNCATE ON "salary_advances"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_advances_school_id_immutable" BEFORE UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payroll_runs (R214, R216) -----------------------------------------------------------------

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_year_month_check"
  CHECK ("year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_working_days_check"
  CHECK ("working_days" BETWEEN 0 AND 31);

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_totals_check"
  CHECK ("staff_count" >= 0 AND "total_net" >= 0);

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalised_check"
  CHECK (
    ("status" = 'finalised') = ("finalised_at" IS NOT NULL)
    AND ("finalised_at" IS NULL) = ("finalised_by" IS NULL)
    AND ("finalised_at" IS NOT NULL OR "finalise_reason" IS NULL)
  );

ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalise_reason_no_id_check"
  CHECK ("finalise_reason" !~ '[0-9]{13}' AND "finalise_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- `[{ staffId, reason }]`: an array of objects carrying no key outside the allowlist (§4).
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_skipped_check"
  CHECK (
    jsonb_typeof("skipped") = 'array'
    AND NOT jsonb_path_exists("skipped", '$[*] ? (@.type() != "object")', '{}', true)
    AND NOT jsonb_path_exists(
      "skipped", '$[*].keyvalue() ? (@.key != "staffId" && @.key != "reason")', '{}', true)
  );

CREATE TRIGGER "payroll_runs_status_transition" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('draft:finalised');

CREATE TRIGGER "payroll_runs_columns_immutable" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('year_month');

-- Recompute rewrites a draft; a finalised run is history (R216).
CREATE TRIGGER "payroll_runs_content_frozen" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'draft', 'working_days', 'prepared_at', 'prepared_by', 'staff_count', 'skipped', 'total_net');

CREATE TRIGGER "payroll_runs_finalised_frozen" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'finalised_at', 'finalised_by', 'finalise_reason');

CREATE TRIGGER "payroll_runs_no_delete" BEFORE DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payroll_runs_no_truncate" BEFORE TRUNCATE ON "payroll_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payroll_runs_school_id_immutable" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payslips (R214-R218) ----------------------------------------------------------------------

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_amounts_check"
  CHECK (
    "basic" >= 0 AND "allowances_total" >= 0 AND "deductions_total" >= 0
    AND "absence_deduction" >= 0 AND "advance_recovery" >= 0
  );

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_days_check"
  CHECK (
    "employed_working_days" BETWEEN 0 AND 31
    AND "unpaid_days" BETWEEN 0 AND "employed_working_days"
    AND "unmarked_days" BETWEEN 0 AND "employed_working_days"
  );

-- §3.3: net is the one formula, never negative.
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_net_check"
  CHECK (
    "net" = "basic" + "allowances_total" - "deductions_total" - "absence_deduction"
            - "advance_recovery" + "adjustment_total"
    AND "net" >= 0
  );

-- R218: paid once, with date, method and who; never carried_forward.
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_check"
  CHECK (
    ("status" = 'paid') = ("paid_on" IS NOT NULL)
    AND ("paid_on" IS NULL) = ("paid_method" IS NULL)
    AND ("paid_on" IS NULL) = ("paid_by" IS NULL)
    AND ("paid_on" IS NOT NULL OR "paid_reference" IS NULL)
    AND ("paid_method" IS NULL OR "paid_method" <> 'carried_forward')
  );

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_reference_check"
  CHECK ("paid_reference" IS NULL OR ("paid_reference" = btrim("paid_reference") AND "paid_reference" <> ''));

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_reference_no_id_check"
  CHECK ("paid_reference" !~ '[0-9]{13}' AND "paid_reference" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "payslips_status_transition" BEFORE UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('pending:paid');

CREATE TRIGGER "payslips_columns_immutable" BEFORE UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('run_id', 'staff_id', 'created_at');

CREATE TRIGGER "payslips_paid_frozen" BEFORE UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'paid_on', 'paid_method', 'paid_reference', 'paid_by');

-- R216, R218: a payslip is written and recomputed only while its run is a draft
-- (payslips_run_finalised); once the run is finalised only the paid columns move, and only then
-- (payslips_run_not_finalised).
CREATE FUNCTION asms_payslip_run_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status payroll_run_status;
  v_refusal text;
BEGIN
  SELECT r.status INTO v_status FROM payroll_runs r
  WHERE r.school_id = NEW.school_id AND r.id = NEW.run_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status <> 'draft' THEN
      v_refusal := 'payslips_run_finalised';
    ELSIF NEW.status <> 'pending' THEN
      v_refusal := 'payslips_run_not_finalised';
    END IF;
  ELSIF v_status = 'draft' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_refusal := 'payslips_run_not_finalised';
    END IF;
  ELSIF (to_jsonb(NEW) - ARRAY['status', 'paid_on', 'paid_method', 'paid_reference', 'paid_by', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'paid_on', 'paid_method', 'paid_reference', 'paid_by', 'updated_at']) THEN
    v_refusal := 'payslips_run_finalised';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'payslip refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payslips_run_guard" BEFORE INSERT OR UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_payslip_run_guard();

CREATE TRIGGER "payslips_no_delete" BEFORE DELETE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payslips_no_truncate" BEFORE TRUNCATE ON "payslips"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payslips_school_id_immutable" BEFORE UPDATE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- payslip_lines (R216, R235) ----------------------------------------------------------------

-- Computed lines are positive; an adjustment is signed and never zero.
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_amount_check"
  CHECK (("kind" = 'adjustment' AND "amount" <> 0) OR ("kind" <> 'adjustment' AND "amount" > 0));

-- An adjustment is a person's, with a reason; only an adjustment corrects another payslip.
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_adjustment_check"
  CHECK (
    ("kind" = 'adjustment') = ("created_by" IS NOT NULL)
    AND ("kind" = 'adjustment') = ("reason" IS NOT NULL)
    AND ("kind" = 'adjustment' OR "adjusts_payslip_id" IS NULL)
    AND ("adjusts_payslip_id" IS NULL OR "adjusts_payslip_id" <> "payslip_id")
  );

ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_reason_check"
  CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND "reason" <> ''));

ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "payslip_lines_columns_immutable" BEFORE UPDATE ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'payslip_id', 'staff_id', 'kind', 'name', 'amount', 'adjusts_payslip_id', 'reason',
    'created_by', 'created_at');

-- §4 "Draft payslips are not money rows yet": a line is written, and a computed line removed by
-- recompute, only while its payslip's run is a draft (payslip_lines_draft_only). An adjustment is
-- never removed (payslip_lines_adjustment_kept: a wrong one is answered by another), and corrects
-- only a payslip of a finalised run (payslip_lines_adjusts_finalised). The table's DELETE refusal
-- is this trigger, not asms_forbid_delete.
CREATE FUNCTION asms_payslip_line_draft_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row payslip_lines;
  v_refusal text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payslips s
    JOIN payroll_runs r ON r.school_id = s.school_id AND r.id = s.run_id
    WHERE s.school_id = v_row.school_id AND s.id = v_row.payslip_id AND r.status = 'draft'
  ) THEN
    v_refusal := 'payslip_lines_draft_only';
  ELSIF TG_OP = 'DELETE' AND v_row.kind = 'adjustment' THEN
    v_refusal := 'payslip_lines_adjustment_kept';
  ELSIF TG_OP = 'INSERT' AND v_row.adjusts_payslip_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payslips s
    JOIN payroll_runs r ON r.school_id = s.school_id AND r.id = s.run_id
    WHERE s.school_id = v_row.school_id AND s.id = v_row.adjusts_payslip_id AND r.status = 'finalised'
  ) THEN
    v_refusal := 'payslip_lines_adjusts_finalised';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'payslip line refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payslip_lines_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_payslip_line_draft_only();

-- R216, R235: nobody adjusts their own payslip; no sole-principal exception.
CREATE FUNCTION asms_payslip_adjust_not_self() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'adjustment' AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.school_id = NEW.school_id AND u.id = NEW.created_by AND u.staff_id = NEW.staff_id
  ) THEN
    RAISE EXCEPTION 'nobody adjusts their own payslip'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payslip_adjust_not_self',
            DETAIL = 'constraint: payslip_adjust_not_self',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payslip_adjust_not_self" BEFORE INSERT ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_payslip_adjust_not_self();

CREATE TRIGGER "payslip_lines_no_truncate" BEFORE TRUNCATE ON "payslip_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "payslip_lines_school_id_immutable" BEFORE UPDATE ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- salary_advance_recoveries (R215, R247; append-only) --------------------------------------

ALTER TABLE "salary_advance_recoveries" ADD CONSTRAINT "salary_advance_recoveries_amount_check"
  CHECK ("amount" > 0);

CREATE TRIGGER "salary_advance_recoveries_columns_immutable" BEFORE UPDATE ON "salary_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'advance_id', 'payslip_id', 'staff_id', 'amount', 'created_at');

-- §3.2: a recovery is taken by a finalised payslip (salary_advance_recoveries_run_finalised; the
-- finalise writes the run's status first) from an open advance, raising its recovered_amount
-- under the advance's row lock; the advance turns recovered when fully repaid. More than is
-- outstanding fails salary_advances_recovered_check; a written-off or recovered advance
-- salary_advance_recoveries_advance_open.
CREATE FUNCTION asms_salary_advance_recovery_apply() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payslips s
    JOIN payroll_runs r ON r.school_id = s.school_id AND r.id = s.run_id
    WHERE s.school_id = NEW.school_id AND s.id = NEW.payslip_id AND r.status = 'finalised'
  ) THEN
    v_refusal := 'salary_advance_recoveries_run_finalised';
  ELSE
    UPDATE salary_advances a
    SET recovered_amount = a.recovered_amount + NEW.amount,
        status = CASE WHEN a.recovered_amount + NEW.amount = a.amount
                      THEN 'recovered'::advance_status ELSE a.status END
    WHERE a.school_id = NEW.school_id AND a.id = NEW.advance_id AND a.status = 'open';
    IF NOT FOUND THEN
      v_refusal := 'salary_advance_recoveries_advance_open';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'recovery refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "salary_advance_recoveries_apply" AFTER INSERT ON "salary_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION asms_salary_advance_recovery_apply();

CREATE TRIGGER "salary_advance_recoveries_no_delete" BEFORE DELETE ON "salary_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_advance_recoveries_no_truncate" BEFORE TRUNCATE ON "salary_advance_recoveries"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "salary_advance_recoveries_school_id_immutable" BEFORE UPDATE ON "salary_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
