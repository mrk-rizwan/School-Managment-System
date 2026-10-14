-- Phase 5 wave T (phase-5-extended.md rules 37 and 40, §1.1, §1.3 A8 and A11, §3.2 "Transport",
-- "Biometric", R326-R331, R344-R348): the tables of slices 41 (transport: vehicles,
-- transport_routes, transport_route_amounts, transport_stops, transport_assignments) and 44
-- (biometric staff attendance: device_punches, staff_attendance_disputes), and
-- staff_attendance.device_punch_id (deferred from the groundwork) with the three-way source CHECK.
-- Slice 46 (the audit screen) needs no schema: the groundwork built its audit_log indexes. The
-- three slices write no migration of their own. Generated DDL first (prisma migrate diff,
-- reviewed: no drift lines; the ALTER TYPE ... ADD VALUE it also emitted is migration
-- 20261014120000_wave_t_enums), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "punch_direction" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "punch_outcome" AS ENUM ('marked', 'stored', 'unmapped', 'inactive');

-- AlterTable
ALTER TABLE "staff_attendance" ADD COLUMN     "device_punch_id" BIGINT;

-- CreateTable
CREATE TABLE "vehicles" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "registration" VARCHAR(20) NOT NULL,
    "capacity" SMALLINT NOT NULL,
    "driver_staff_id" BIGINT,
    "status" "vehicle_status" NOT NULL DEFAULT 'active',
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by" BIGINT,
    "retire_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_routes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "vehicle_id" BIGINT,
    "status" "transport_route_status" NOT NULL DEFAULT 'active',
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" BIGINT,
    "archive_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_route_amounts" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "route_id" BIGINT NOT NULL,
    "effective_period" CHAR(7) NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_route_amounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_stops" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "route_id" BIGINT NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "pickup_time" TIME(0),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "end_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_assignments" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "route_id" BIGINT NOT NULL,
    "stop_id" BIGINT,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "end_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_punches" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT,
    "device_user_id" VARCHAR(40) NOT NULL,
    "punched_at" TIMESTAMPTZ(3) NOT NULL,
    "direction" "punch_direction",
    "outcome" "punch_outcome" NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance_disputes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "attendance_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "raised_by" BIGINT NOT NULL,
    "requested_status" "staff_attendance_status" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "dispute_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" BIGINT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "withdrawn_by" BIGINT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_attendance_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicles_school_id_driver_staff_id_idx" ON "vehicles"("school_id", "driver_staff_id");

-- CreateIndex
CREATE INDEX "vehicles_school_id_created_by_idx" ON "vehicles"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "vehicles_school_id_retired_by_idx" ON "vehicles"("school_id", "retired_by");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_school_id_id_key" ON "vehicles"("school_id", "id");

-- CreateIndex
CREATE INDEX "transport_routes_school_id_vehicle_id_idx" ON "transport_routes"("school_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "transport_routes_school_id_created_by_idx" ON "transport_routes"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "transport_routes_school_id_archived_by_idx" ON "transport_routes"("school_id", "archived_by");

-- CreateIndex
CREATE UNIQUE INDEX "transport_routes_school_id_id_key" ON "transport_routes"("school_id", "id");

-- CreateIndex
CREATE INDEX "transport_route_amounts_school_id_created_by_idx" ON "transport_route_amounts"("school_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "transport_route_amounts_school_id_id_key" ON "transport_route_amounts"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_route_amounts_route_period_key" ON "transport_route_amounts"("school_id", "route_id", "effective_period");

-- CreateIndex
CREATE INDEX "transport_stops_school_id_route_id_idx" ON "transport_stops"("school_id", "route_id", "sort_order");

-- CreateIndex
CREATE INDEX "transport_stops_school_id_ended_by_idx" ON "transport_stops"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "transport_stops_school_id_id_key" ON "transport_stops"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_stops_school_id_id_route_id_key" ON "transport_stops"("school_id", "id", "route_id");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_route_id_idx" ON "transport_assignments"("school_id", "route_id", "starts_on");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_stop_id_idx" ON "transport_assignments"("school_id", "stop_id", "route_id");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_enrolment_id_idx" ON "transport_assignments"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_student_id_idx" ON "transport_assignments"("school_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_academic_year_id_starts_on_idx" ON "transport_assignments"("school_id", "academic_year_id", "starts_on");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_created_by_idx" ON "transport_assignments"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "transport_assignments_school_id_ended_by_idx" ON "transport_assignments"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "transport_assignments_school_id_id_key" ON "transport_assignments"("school_id", "id");

-- CreateIndex
CREATE INDEX "device_punches_school_id_punched_at_idx" ON "device_punches"("school_id", "punched_at");

-- CreateIndex
CREATE INDEX "device_punches_school_id_staff_id_punched_at_idx" ON "device_punches"("school_id", "staff_id", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_school_id_id_key" ON "device_punches"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_school_id_id_staff_id_key" ON "device_punches"("school_id", "id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_replay_key" ON "device_punches"("school_id", "device_user_id", "punched_at");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_attendance_id_idx" ON "staff_attendance_disputes"("school_id", "attendance_id", "staff_id");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_staff_id_idx" ON "staff_attendance_disputes"("school_id", "staff_id", "created_at");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_status_idx" ON "staff_attendance_disputes"("school_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_raised_by_idx" ON "staff_attendance_disputes"("school_id", "raised_by");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_decided_by_idx" ON "staff_attendance_disputes"("school_id", "decided_by");

-- CreateIndex
CREATE INDEX "staff_attendance_disputes_school_id_withdrawn_by_idx" ON "staff_attendance_disputes"("school_id", "withdrawn_by");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_disputes_school_id_id_key" ON "staff_attendance_disputes"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_device_punch_id_key" ON "staff_attendance"("school_id", "device_punch_id", "staff_id");

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_device_punch_id_fkey" FOREIGN KEY ("school_id", "device_punch_id", "staff_id") REFERENCES "device_punches"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_staff_id_fkey" FOREIGN KEY ("school_id", "driver_staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_retired_by_fkey" FOREIGN KEY ("school_id", "retired_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_vehicle_id_fkey" FOREIGN KEY ("school_id", "vehicle_id") REFERENCES "vehicles"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_archived_by_fkey" FOREIGN KEY ("school_id", "archived_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_route_id_fkey" FOREIGN KEY ("school_id", "route_id") REFERENCES "transport_routes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_route_id_fkey" FOREIGN KEY ("school_id", "route_id") REFERENCES "transport_routes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_route_id_fkey" FOREIGN KEY ("school_id", "route_id") REFERENCES "transport_routes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_stop_id_fkey" FOREIGN KEY ("school_id", "stop_id", "route_id") REFERENCES "transport_stops"("school_id", "id", "route_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_attendance_id_fkey" FOREIGN KEY ("school_id", "attendance_id", "staff_id") REFERENCES "staff_attendance"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_raised_by_fkey" FOREIGN KEY ("school_id", "raised_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_withdrawn_by_fkey" FOREIGN KEY ("school_id", "withdrawn_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;






-- =============================================================================================
-- Hand-written below this line. Every object here is listed in test/guardrails/schema-checks.ts
-- (WAVE_T_OBJECTS) and written directly by test/phase5/wave-t-schema.e2e-spec.ts. Trigger
-- functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>' (prisma-errors.ts reads it).
-- A guard that reads a parent row's status locks it FOR SHARE, so a write racing a status change
-- (a vehicle retired, a route archived, a stop ended) waits for it and then sees the new status;
-- the status change's own guard then sees the committed child row.
-- =============================================================================================

-- ---- vehicles (rule 37, R329, R331) -------------------------------------------------------------

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_registration_check"
  CHECK ("registration" = btrim("registration") AND "registration" <> '');

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_registration_no_id_check"
  CHECK ("registration" !~ '[0-9]{13}' AND "registration" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §1.1: capacity 1-120; over-assignment warns, never blocks (R331), so nothing reads it here.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_capacity_check"
  CHECK ("capacity" BETWEEN 1 AND 120);

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_retired_check"
  CHECK (
    ("status" = 'retired') = ("retired_at" IS NOT NULL)
    AND ("retired_at" IS NULL) = ("retired_by" IS NULL)
    AND ("retired_at" IS NULL) = ("retire_reason" IS NULL)
  );

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_retire_reason_check"
  CHECK ("retire_reason" IS NULL OR ("retire_reason" = btrim("retire_reason") AND "retire_reason" <> ''));

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_retire_reason_no_id_check"
  CHECK ("retire_reason" !~ '[0-9]{13}' AND "retire_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.2: one active vehicle per registration, case- and space-insensitively (a retired one keeps
-- its registration in history and frees it).
CREATE UNIQUE INDEX "vehicles_live_registration_key" ON "vehicles" ("school_id", upper(btrim("registration")))
  WHERE "status" = 'active';

CREATE TRIGGER "vehicles_status_transition" BEFORE UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('active:retired');

CREATE TRIGGER "vehicles_columns_immutable" BEFORE UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('created_by', 'created_at');

-- PATCH /vehicles/:id edits an active vehicle; a retired one is history.
CREATE TRIGGER "vehicles_content_frozen" BEFORE UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'active', 'registration', 'capacity', 'driver_staff_id');

CREATE TRIGGER "vehicles_retired_frozen" BEFORE UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('retired_at', 'retired_by', 'retire_reason');

-- A vehicle is born active, and is not retired while an active route names it (VEHICLE_IN_USE).
CREATE FUNCTION asms_vehicle_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
    v_refusal := 'vehicles_born_active';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'retired'
        AND EXISTS (
          SELECT 1 FROM transport_routes r
           WHERE r.school_id = NEW.school_id AND r.vehicle_id = NEW.id AND r.status = 'active'
        ) THEN
    v_refusal := 'vehicles_in_use';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicles_guard" BEFORE INSERT OR UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_vehicle_guard();

CREATE TRIGGER "vehicles_no_delete" BEFORE DELETE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "vehicles_no_truncate" BEFORE TRUNCATE ON "vehicles"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "vehicles_school_id_immutable" BEFORE UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- transport_routes (rule 37, R329) ------------------------------------------------------------

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_archived_check"
  CHECK (
    ("status" = 'archived') = ("archived_at" IS NOT NULL)
    AND ("archived_at" IS NULL) = ("archived_by" IS NULL)
    AND ("archived_at" IS NULL) = ("archive_reason" IS NULL)
  );

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_archive_reason_check"
  CHECK ("archive_reason" IS NULL OR ("archive_reason" = btrim("archive_reason") AND "archive_reason" <> ''));

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_archive_reason_no_id_check"
  CHECK ("archive_reason" !~ '[0-9]{13}' AND "archive_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.2: one active route per name, case-insensitively.
CREATE UNIQUE INDEX "transport_routes_live_name_key" ON "transport_routes" ("school_id", lower("name"))
  WHERE "status" = 'active';

CREATE TRIGGER "transport_routes_status_transition" BEFORE UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('active:archived');

CREATE TRIGGER "transport_routes_columns_immutable" BEFORE UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('created_by', 'created_at');

CREATE TRIGGER "transport_routes_content_frozen" BEFORE UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status('active', 'name', 'vehicle_id');

CREATE TRIGGER "transport_routes_archived_frozen" BEFORE UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('archived_at', 'archived_by', 'archive_reason');

-- A route is born active; the vehicle it names (on insert or a change) is active (VEHICLE_RETIRED);
-- it is not archived while a live assignment rides it (R329, TRANSPORT_ROUTE_HAS_ASSIGNMENTS).
CREATE FUNCTION asms_transport_route_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_vehicle vehicle_status;
  v_refusal text;
BEGIN
  IF NEW.vehicle_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id) THEN
    SELECT v.status INTO v_vehicle FROM vehicles v
     WHERE v.school_id = NEW.school_id AND v.id = NEW.vehicle_id
     FOR SHARE;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
    v_refusal := 'transport_routes_born_active';
  ELSIF v_vehicle IS NOT NULL AND v_vehicle <> 'active' THEN
    v_refusal := 'transport_routes_vehicle_active';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'archived'
        AND EXISTS (
          SELECT 1 FROM transport_assignments a
           WHERE a.school_id = NEW.school_id AND a.route_id = NEW.id AND a.ended_at IS NULL
        ) THEN
    v_refusal := 'transport_routes_has_assignments';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'transport route refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transport_routes_guard" BEFORE INSERT OR UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_transport_route_guard();

CREATE TRIGGER "transport_routes_no_delete" BEFORE DELETE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_routes_no_truncate" BEFORE TRUNCATE ON "transport_routes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_routes_school_id_immutable" BEFORE UPDATE ON "transport_routes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- transport_route_amounts (rule 37, R327; append-only) ---------------------------------------

ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_period_check"
  CHECK ("effective_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_amount_check"
  CHECK ("amount" >= 0);

-- An amount is set only on an active route. "From the next period" (TRANSPORT_AMOUNT_PERIOD_PAST)
-- is the service's rule: it reads the school's clock, and a route's first amount may start now.
CREATE FUNCTION asms_transport_route_amount_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_route transport_route_status;
BEGIN
  SELECT r.status INTO v_route FROM transport_routes r
   WHERE r.school_id = NEW.school_id AND r.id = NEW.route_id
   FOR SHARE;
  IF v_route IS NOT NULL AND v_route <> 'active' THEN
    RAISE EXCEPTION 'an archived route takes no new amount'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'transport_route_amounts_route_active',
            DETAIL = 'constraint: transport_route_amounts_route_active',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transport_route_amounts_guard" BEFORE INSERT ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_transport_route_amount_guard();

CREATE TRIGGER "transport_route_amounts_append_only" BEFORE UPDATE OR DELETE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "transport_route_amounts_no_truncate" BEFORE TRUNCATE ON "transport_route_amounts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "transport_route_amounts_school_id_immutable" BEFORE UPDATE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- transport_stops (rule 37) -------------------------------------------------------------------

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_sort_order_check"
  CHECK ("sort_order" BETWEEN 1 AND 100);

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_ended_check"
  CHECK (
    ("ended_at" IS NULL) = ("ended_by" IS NULL)
    AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
  );

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_end_reason_check"
  CHECK ("end_reason" IS NULL OR ("end_reason" = btrim("end_reason") AND "end_reason" <> ''));

ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.2: the live stops of a route have distinct sort orders. A partial unique cannot be deferred,
-- an exclusion constraint can: PATCH /transport-routes/:id replaces the stops as a whole, so a
-- reorder swaps orders inside the transaction and is checked at commit.
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_live_order_excl"
  EXCLUDE USING btree ("school_id" WITH =, "route_id" WITH =, "sort_order" WITH =)
  WHERE ("ended_at" IS NULL)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER "transport_stops_columns_immutable" BEFORE UPDATE ON "transport_stops"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('route_id', 'created_at');

-- A live stop is edited in place (order, name, pickup time); an ended one is history.
CREATE TRIGGER "transport_stops_ended_frozen" BEFORE UPDATE ON "transport_stops"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'ended_at', 'ended_by', 'end_reason', 'sort_order', 'name', 'pickup_time');

-- A stop is born live and is written only while its route is active; it is not ended while a live
-- assignment names it (TRANSPORT_STOP_IN_USE): the assignment's stop is frozen, so the student is
-- moved first (close-old/open-new).
CREATE FUNCTION asms_transport_stop_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_route transport_route_status;
  v_refusal text;
BEGIN
  SELECT r.status INTO v_route FROM transport_routes r
   WHERE r.school_id = NEW.school_id AND r.id = NEW.route_id
   FOR SHARE;
  IF TG_OP = 'INSERT' AND NEW.ended_at IS NOT NULL THEN
    v_refusal := 'transport_stops_born_live';
  ELSIF v_route IS NOT NULL AND v_route <> 'active' THEN
    v_refusal := 'transport_stops_route_active';
  ELSIF TG_OP = 'UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM transport_assignments a
           WHERE a.school_id = NEW.school_id AND a.stop_id = NEW.id AND a.ended_at IS NULL
        ) THEN
    v_refusal := 'transport_stops_in_use';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'transport stop refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transport_stops_guard" BEFORE INSERT OR UPDATE ON "transport_stops"
  FOR EACH ROW EXECUTE FUNCTION asms_transport_stop_guard();

CREATE TRIGGER "transport_stops_no_delete" BEFORE DELETE ON "transport_stops"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_stops_no_truncate" BEFORE TRUNCATE ON "transport_stops"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_stops_school_id_immutable" BEFORE UPDATE ON "transport_stops"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- transport_assignments (rule 37, A8, R326, R327, R329) --------------------------------------

-- The end group travels together. ends_on is the last day on the route; starts_on - 1 records an
-- assignment ended before it began (never in force, never charged).
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_ended_check"
  CHECK (
    ("ended_at" IS NULL) = ("ended_by" IS NULL)
    AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
    AND ("ended_at" IS NULL) = ("ends_on" IS NULL)
    AND ("ends_on" IS NULL OR "ends_on" >= "starts_on" - 1)
  );

ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_end_reason_check"
  CHECK ("end_reason" IS NULL OR ("end_reason" = btrim("end_reason") AND "end_reason" <> ''));

ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- A8, R326: one live assignment per student per year (TRANSPORT_ASSIGNMENT_LIVE).
CREATE UNIQUE INDEX "transport_assignments_live_key" ON "transport_assignments" ("school_id", "student_id", "academic_year_id")
  WHERE "ended_at" IS NULL;

-- A route's riders now: the archive refusal, the capacity warning, the driver's list.
CREATE INDEX "transport_assignments_live_route_idx" ON "transport_assignments" ("school_id", "route_id")
  WHERE "ended_at" IS NULL;

-- R326: never edited; a change is close-old/open-new.
CREATE TRIGGER "transport_assignments_columns_immutable" BEFORE UPDATE ON "transport_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'academic_year_id', 'enrolment_id', 'route_id', 'stop_id', 'starts_on', 'created_by',
    'created_at');

CREATE TRIGGER "transport_assignments_ended_frozen" BEFORE UPDATE ON "transport_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by', 'end_reason', 'ends_on');

-- An assignment is born live, on an active route (R329, TRANSPORT_ROUTE_ARCHIVED; a route's
-- vehicle is never retired while the route is active) and a live stop of it, starting inside its
-- academic year.
CREATE FUNCTION asms_transport_assignment_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_route transport_route_status;
  v_stop_ended timestamptz;
  v_refusal text;
BEGIN
  SELECT r.status INTO v_route FROM transport_routes r
   WHERE r.school_id = NEW.school_id AND r.id = NEW.route_id
   FOR SHARE;
  IF NEW.stop_id IS NOT NULL THEN
    SELECT s.ended_at INTO v_stop_ended FROM transport_stops s
     WHERE s.school_id = NEW.school_id AND s.id = NEW.stop_id
     FOR SHARE;
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    v_refusal := 'transport_assignments_born_live';
  ELSIF v_route IS NOT NULL AND v_route <> 'active' THEN
    v_refusal := 'transport_assignments_route_active';
  ELSIF v_stop_ended IS NOT NULL THEN
    v_refusal := 'transport_assignments_stop_live';
  ELSIF NOT EXISTS (
          SELECT 1 FROM academic_years y
           WHERE y.school_id = NEW.school_id AND y.id = NEW.academic_year_id
             AND NEW.starts_on BETWEEN y.starts_on AND y.ends_on
        ) THEN
    v_refusal := 'transport_assignments_in_year';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'transport assignment refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transport_assignments_guard" BEFORE INSERT ON "transport_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_transport_assignment_guard();

CREATE TRIGGER "transport_assignments_no_delete" BEFORE DELETE ON "transport_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_assignments_no_truncate" BEFORE TRUNCATE ON "transport_assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_assignments_school_id_immutable" BEFORE UPDATE ON "transport_assignments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- device_punches (rule 40, A11, R345, R348; append-only like audit_log) ---------------------

-- The staff.device_user_id shape: 1-40 printable ASCII without spaces, never an identity number.
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_device_user_id_check"
  CHECK ("device_user_id" ~ '^[!-~]{1,40}$');

ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_device_user_id_no_id_check"
  CHECK ("device_user_id" !~ '[0-9]{13}' AND "device_user_id" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- A11: unmapped exactly when no staff member held the id at receipt.
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_outcome_check"
  CHECK (("outcome" = 'unmapped') = ("staff_id" IS NULL));

-- A11: staff_id is the mapping at receipt, so it names the staff member holding the device user
-- id then; R345: a punch marks only an active staff member, and `inactive` means the holder was
-- not active.
CREATE FUNCTION asms_device_punch_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_device_user_id text;
  v_status staff_status;
  v_refusal text;
BEGIN
  IF NEW.staff_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.device_user_id, s.status INTO v_device_user_id, v_status FROM staff s
   WHERE s.school_id = NEW.school_id AND s.id = NEW.staff_id;
  IF v_device_user_id IS DISTINCT FROM NEW.device_user_id THEN
    v_refusal := 'device_punches_staff_mapping';
  ELSIF (NEW.outcome = 'inactive') <> (v_status <> 'active') THEN
    v_refusal := 'device_punches_staff_status';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'device punch refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "device_punches_guard" BEFORE INSERT ON "device_punches"
  FOR EACH ROW EXECUTE FUNCTION asms_device_punch_guard();

CREATE TRIGGER "device_punches_append_only" BEFORE UPDATE OR DELETE ON "device_punches"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "device_punches_no_truncate" BEFORE TRUNCATE ON "device_punches"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "device_punches_school_id_immutable" BEFORE UPDATE ON "device_punches"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- staff_attendance (rule 40, R345) -----------------------------------------------------------

-- §3.2, widening the groundwork's two-way rule: a device mark has no marking user and names the
-- punch that made it; a manual mark has a marking user and no punch. NOT VALID: it holds every
-- insert and update from now on, but is not checked against rows already stored. No device mark
-- can exist in a deployed school (the punch route is first applied by slice 44), but the
-- groundwork's own test wrote device marks without a punch into test databases, which cannot be
-- corrected (source and marked_by are frozen) or removed (rule 4).
ALTER TABLE "staff_attendance" DROP CONSTRAINT "staff_attendance_source_check";
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_source_check"
  CHECK (
    ("source" = 'device') = ("marked_by" IS NULL)
    AND ("marked_by" IS NULL) = ("device_punch_id" IS NOT NULL)
  ) NOT VALID;

-- The frozen list gains device_punch_id.
DROP TRIGGER "staff_attendance_columns_immutable" ON "staff_attendance";
CREATE TRIGGER "staff_attendance_columns_immutable" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'date', 'marked_by', 'marked_at', 'source', 'device_punch_id');

-- R345: a device mark is made by a punch received as `marked`, on the punch's own day in school
-- time (the FK already binds the punch to the same staff member).
CREATE FUNCTION asms_staff_attendance_device_punch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_outcome punch_outcome;
  v_day date;
  v_refusal text;
BEGIN
  IF NEW.device_punch_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.outcome, (p.punched_at AT TIME ZONE sc.timezone)::date INTO v_outcome, v_day
    FROM device_punches p JOIN schools sc ON sc.id = p.school_id
   WHERE p.school_id = NEW.school_id AND p.id = NEW.device_punch_id;
  IF v_outcome IS DISTINCT FROM 'marked' THEN
    v_refusal := 'staff_attendance_device_punch_marked';
  ELSIF v_day IS DISTINCT FROM NEW.date THEN
    v_refusal := 'staff_attendance_device_punch_date';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'device mark refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "staff_attendance_device_punch" BEFORE INSERT ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_staff_attendance_device_punch();

-- ---- staff_attendance_disputes (rule 40, R346, R347) ---------------------------------------------

ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_decision_reason_check"
  CHECK ("decision_reason" IS NULL OR ("decision_reason" = btrim("decision_reason") AND "decision_reason" <> ''));

ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_decision_reason_no_id_check"
  CHECK ("decision_reason" !~ '[0-9]{13}' AND "decision_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Decided exactly when approved or rejected; a rejection carries its reason, an approval may.
ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_decided_check"
  CHECK (
    ("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)
    AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("decided_at" IS NOT NULL OR "decision_reason" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
  );

ALTER TABLE "staff_attendance_disputes" ADD CONSTRAINT "staff_attendance_disputes_withdrawn_check"
  CHECK (
    ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
    AND ("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL)
  );

-- One pending dispute per mark (ATTENDANCE_DISPUTE_PENDING_EXISTS).
CREATE UNIQUE INDEX "staff_attendance_disputes_pending_key" ON "staff_attendance_disputes" ("school_id", "attendance_id")
  WHERE "status" = 'pending';

CREATE TRIGGER "staff_attendance_disputes_status_transition" BEFORE UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'pending:approved', 'pending:rejected', 'pending:withdrawn');

CREATE TRIGGER "staff_attendance_disputes_columns_immutable" BEFORE UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'attendance_id', 'staff_id', 'raised_by', 'requested_status', 'reason', 'created_at');

CREATE TRIGGER "staff_attendance_disputes_decided_frozen" BEFORE UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by', 'decision_reason');

CREATE TRIGGER "staff_attendance_disputes_withdrawn_frozen" BEFORE UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('withdrawn_at', 'withdrawn_by');

-- R346: born pending; raised from a login of the staff member; decided by somebody who is not the
-- staff member (no sole-principal exception: another attendance.staff.manage holder decides, or
-- the dispute waits); withdrawn only by the staff member.
CREATE FUNCTION asms_staff_attendance_dispute_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'pending' THEN
    v_refusal := 'staff_attendance_disputes_born_pending';
  ELSIF TG_OP = 'INSERT' AND NOT EXISTS (
          SELECT 1 FROM users u
           WHERE u.school_id = NEW.school_id AND u.id = NEW.raised_by AND u.staff_id = NEW.staff_id
        ) THEN
    v_refusal := 'staff_attendance_disputes_raised_by_self';
  ELSIF NEW.decided_by IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.decided_by IS NULL)
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE u.school_id = NEW.school_id AND u.id = NEW.decided_by AND u.staff_id = NEW.staff_id
        ) THEN
    v_refusal := 'staff_attendance_disputes_not_self';
  ELSIF NEW.withdrawn_by IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.withdrawn_by IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM users u
           WHERE u.school_id = NEW.school_id AND u.id = NEW.withdrawn_by AND u.staff_id = NEW.staff_id
        ) THEN
    v_refusal := 'staff_attendance_disputes_withdrawn_by_self';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'attendance dispute refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "staff_attendance_disputes_guard" BEFORE INSERT OR UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_staff_attendance_dispute_guard();

CREATE TRIGGER "staff_attendance_disputes_no_delete" BEFORE DELETE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_attendance_disputes_no_truncate" BEFORE TRUNCATE ON "staff_attendance_disputes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_attendance_disputes_school_id_immutable" BEFORE UPDATE ON "staff_attendance_disputes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
