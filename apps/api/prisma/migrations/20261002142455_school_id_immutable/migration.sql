-- A row's tenant never changes (CLAUDE.md "How tenant isolation is implemented", control 5 backstop).
-- The query guard refuses schoolId in update data; this refuses it in the database, whatever the
-- client. Every tenant table attaches it, and the schema guard test fails on one that does not:
--
--   CREATE TRIGGER <table>_school_id_immutable BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
CREATE FUNCTION asms_forbid_school_id_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'school_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
