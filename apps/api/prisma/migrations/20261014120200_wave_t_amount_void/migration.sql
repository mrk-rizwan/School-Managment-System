-- Phase 5 wave T, fix forward (deviation 6 of the wave T schema report): a mistaken future
-- transport amount is correctable before it is charged. transport_route_amounts gains a void trio;
-- one live amount per route and period (the unique becomes partial on voided_at IS NULL); a void
-- only for a period after the current month in school time; otherwise nothing changes. Generated
-- DDL first (prisma migrate diff against the migrated test database, reviewed: no drift lines),
-- hand-written SQL after the marker.

-- DropIndex
DROP INDEX "transport_route_amounts_route_period_key";

-- AlterTable
ALTER TABLE "transport_route_amounts" ADD COLUMN     "void_reason" VARCHAR(500),
ADD COLUMN     "voided_at" TIMESTAMPTZ(3),
ADD COLUMN     "voided_by" BIGINT;

-- CreateIndex
CREATE INDEX "transport_route_amounts_school_id_route_id_idx" ON "transport_route_amounts"("school_id", "route_id", "effective_period");

-- CreateIndex
CREATE INDEX "transport_route_amounts_school_id_voided_by_idx" ON "transport_route_amounts"("school_id", "voided_by");

-- AddForeignKey
ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;





-- =============================================================================================
-- Hand-written below this line. Listed in test/guardrails/schema-checks.ts (WAVE_T_OBJECTS) and
-- written directly by test/phase5/wave-t-schema.e2e-spec.ts.
-- =============================================================================================

ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_voided_check"
  CHECK (
    ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_void_reason_check"
  CHECK ("void_reason" IS NULL OR ("void_reason" = btrim("void_reason") AND "void_reason" <> ''));

ALTER TABLE "transport_route_amounts" ADD CONSTRAINT "transport_route_amounts_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live amount per route and period; a voided row frees its period for the replacement.
CREATE UNIQUE INDEX "transport_route_amounts_route_period_key"
  ON "transport_route_amounts" ("school_id", "route_id", "effective_period")
  WHERE "voided_at" IS NULL;

-- No longer append-only: the void trio may be set, once. Every other column is frozen, and the
-- row is never deleted or truncated (rule 4).
DROP TRIGGER "transport_route_amounts_append_only" ON "transport_route_amounts";
DROP TRIGGER "transport_route_amounts_no_truncate" ON "transport_route_amounts";

CREATE TRIGGER "transport_route_amounts_no_delete" BEFORE DELETE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_route_amounts_no_truncate" BEFORE TRUNCATE ON "transport_route_amounts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "transport_route_amounts_columns_immutable" BEFORE UPDATE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'route_id', 'effective_period', 'amount', 'created_by', 'created_at');

CREATE TRIGGER "transport_route_amounts_voided_frozen" BEFORE UPDATE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

-- Inserted live and only on an active route; voided only before its period starts in the school's
-- time zone (TRANSPORT_AMOUNT_PERIOD_PAST), so no period ever charged loses its amount and a
-- catch-up run charges what the first run charged.
CREATE OR REPLACE FUNCTION asms_transport_route_amount_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_route transport_route_status;
  v_current text;
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.status INTO v_route FROM transport_routes r
     WHERE r.school_id = NEW.school_id AND r.id = NEW.route_id
     FOR SHARE;
    IF NEW.voided_at IS NOT NULL THEN
      v_refusal := 'transport_route_amounts_born_live';
    ELSIF v_route IS NOT NULL AND v_route <> 'active' THEN
      v_refusal := 'transport_route_amounts_route_active';
    END IF;
  ELSIF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    SELECT to_char(now() AT TIME ZONE s.timezone, 'YYYY-MM') INTO v_current
      FROM schools s WHERE s.id = NEW.school_id;
    IF NEW.effective_period <= v_current THEN
      v_refusal := 'transport_route_amounts_void_period_started';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'transport route amount refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "transport_route_amounts_guard" ON "transport_route_amounts";
CREATE TRIGGER "transport_route_amounts_guard" BEFORE INSERT OR UPDATE ON "transport_route_amounts"
  FOR EACH ROW EXECUTE FUNCTION asms_transport_route_amount_guard();
