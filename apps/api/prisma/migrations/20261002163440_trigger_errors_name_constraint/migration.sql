-- Hand-written. Prisma generated only the routine drift lines, removed in review:
--   ALTER TABLE "school_counters" DROP CONSTRAINT "school_counters_school_id_fkey";
--   ALTER TABLE "school_settings" DROP CONSTRAINT "school_settings_school_id_fkey";
--
-- Measured on Prisma 7.10.0 with @prisma/adapter-pg: a SQLSTATE 23514 error (CHECK or trigger)
-- reaches the application as P2039 whose meta.driverAdapterError.cause carries originalCode,
-- message, detail, column and hint, but NOT the constraint name: the adapter drops the protocol's
-- constraint field for every code except 23505 and 23503. So the RAISE ... CONSTRAINT added in
-- 20261002163232_school_id_immutable_named and 20261002163157_slice1_platform is invisible
-- to the error mapper. Each trigger function now also sets
--   DETAIL = 'constraint: <name>'
-- which the adapter forwards as cause.detail. CONSTRAINT stays for any other client. Messages and
-- SQLSTATE are unchanged. A CHECK violation names itself only in its message:
--   new row for relation "<table>" violates check constraint "<name>"
CREATE OR REPLACE FUNCTION asms_forbid_school_id_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'school_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_school_id_immutable',
            DETAIL = 'constraint: ' || TG_TABLE_NAME || '_school_id_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'school_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION asms_forbid_short_code_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.short_code IS DISTINCT FROM OLD.short_code THEN
    RAISE EXCEPTION 'short_code is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'schools_short_code_immutable',
            DETAIL = 'constraint: schools_short_code_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'short_code';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION asms_forbid_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation',
          CONSTRAINT = TG_TABLE_NAME || '_append_only',
          DETAIL = 'constraint: ' || TG_TABLE_NAME || '_append_only',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME;
END;
$$;
