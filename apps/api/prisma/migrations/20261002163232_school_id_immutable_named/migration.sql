-- Hand-written. Replaces the function from 20261002142455_school_id_immutable so the error names
-- a constraint, <table>_school_id_immutable (the same name as each table's trigger): the error
-- mapper keys on constraint names (§3.8), and a bare RAISE carries none. Message and SQLSTATE
-- (23514 check_violation) are unchanged. CREATE OR REPLACE keeps the function's identity, so the
-- triggers already attached to it need no change.
CREATE OR REPLACE FUNCTION asms_forbid_school_id_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'school_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_school_id_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'school_id';
  END IF;
  RETURN NEW;
END;
$$;
