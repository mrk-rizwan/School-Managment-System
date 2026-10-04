-- Slice 11 review fix A4 (contracts/slice-11.md §2.2, §6.2): `correctionsCapped` reports a fourth
-- notice that was due and refused, not merely three sent. The writer stamps capped_at on the
-- kind's latest row of the child-day when it refuses a fourth.

-- AlterTable
ALTER TABLE "attendance_alerts" ADD COLUMN     "capped_at" TIMESTAMPTZ(3);

-- =============================================================================================
-- Hand-written below this line. Generated SQL above reviewed: no drift lines.
-- =============================================================================================

-- pending -> sent | cancelled; sent and cancelled stay final. The only changes a final row takes
-- are updated_at and capped_at, and capped_at is written once: a set value never changes.
CREATE OR REPLACE FUNCTION asms_attendance_alert_status_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.capped_at IS NOT NULL AND NEW.capped_at IS DISTINCT FROM OLD.capped_at THEN
    RAISE EXCEPTION 'an attendance alert''s capped_at is written once'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'attendance_alerts_capped_at_immutable',
            DETAIL = 'constraint: attendance_alerts_capped_at_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  IF OLD.status <> 'pending'
     AND (to_jsonb(NEW) - 'updated_at' - 'capped_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'capped_at') THEN
    RAISE EXCEPTION 'a sent or cancelled attendance alert is final'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'attendance_alerts_status_final',
            DETAIL = 'constraint: attendance_alerts_status_final',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
