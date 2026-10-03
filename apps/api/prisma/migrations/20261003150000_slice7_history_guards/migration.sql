-- Slice-7 review fixes (security L3, L4; auditor A8): history guards on the role tables, and the
-- end rule for grant rows of a user who becomes a principal (contracts/slice-7.md §4.4, §6).
-- Hand-written throughout; schema.prisma is unchanged. Every trigger function raises SQLSTATE
-- 23514 with DETAIL 'constraint: <name>' (the error mapper reads DETAIL; migration
-- 20261002163440_trigger_errors_name_constraint). None of these is reachable through the API:
-- the services refuse each case first, so none is mapped in prisma-errors.ts.

-- ---- shared trigger functions ---------------------------------------------------------------

-- Refuses DELETE (row trigger) and TRUNCATE (statement trigger): rule 4, rows are ended or
-- archived, never removed. Constraint name '<table>_no_delete'.
CREATE FUNCTION asms_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation',
          CONSTRAINT = TG_TABLE_NAME || '_no_delete',
          DETAIL = 'constraint: ' || TG_TABLE_NAME || '_no_delete',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME;
END;
$$;

-- Once the column named by the first argument is set, refuses any change to the columns named
-- by every argument (the first included): an end marker is written once and never cleared or
-- moved. Constraint name '<table>_<column>_frozen'.
CREATE FUNCTION asms_forbid_change_once_set() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF old_row ->> TG_ARGV[0] IS NOT NULL THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF old_row -> col IS DISTINCT FROM new_row -> col THEN
        RAISE EXCEPTION '% is frozen on % once % is set', col, TG_TABLE_NAME, TG_ARGV[0]
          USING ERRCODE = 'check_violation',
                CONSTRAINT = TG_TABLE_NAME || '_' || col || '_frozen',
                DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_frozen',
                SCHEMA = TG_TABLE_SCHEMA,
                TABLE = TG_TABLE_NAME,
                COLUMN = col;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- custom_roles ---------------------------------------------------------------------------

CREATE TRIGGER "custom_roles_no_delete" BEFORE DELETE ON "custom_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "custom_roles_no_truncate" BEFORE TRUNCATE ON "custom_roles"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- Archive is final in Phase 1 (contracts/slice-7.md §3.5: no unarchive).
CREATE FUNCTION asms_custom_role_archive_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'archived' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an archived custom role stays archived'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'custom_roles_archive_final',
            DETAIL = 'constraint: custom_roles_archive_final',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'status';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "custom_roles_archive_final" BEFORE UPDATE ON "custom_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_custom_role_archive_final();

-- ---- custom_role_capabilities ---------------------------------------------------------------

CREATE TRIGGER "custom_role_capabilities_no_delete" BEFORE DELETE ON "custom_role_capabilities"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "custom_role_capabilities_no_truncate" BEFORE TRUNCATE ON "custom_role_capabilities"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- A removed key stays removed: re-adding is a new row (the live partial unique index allows it).
CREATE TRIGGER "custom_role_capabilities_removed_frozen" BEFORE UPDATE ON "custom_role_capabilities"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('removed_at', 'removed_by');

-- ---- user_roles -----------------------------------------------------------------------------

-- A row names one user and one role for life; a different role is a new row.
CREATE TRIGGER "user_roles_columns_immutable" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('user_id', 'system_role', 'custom_role_id');

-- An ended row stays ended (never re-opened by clearing ended_at).
CREATE TRIGGER "user_roles_ended_frozen" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by');

-- R52, R96 in the database: an archived custom role gains no holder. FOR SHARE serialises with an
-- archive's UPDATE of the same role row.
CREATE FUNCTION asms_user_role_custom_role_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_status custom_role_status;
BEGIN
  IF NEW.custom_role_id IS NOT NULL THEN
    SELECT status INTO role_status FROM custom_roles
      WHERE school_id = NEW.school_id AND id = NEW.custom_role_id
      FOR SHARE;
    IF role_status = 'archived' THEN
      RAISE EXCEPTION 'custom role % is archived', NEW.custom_role_id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'user_roles_custom_role_active',
              DETAIL = 'constraint: user_roles_custom_role_active',
              SCHEMA = TG_TABLE_SCHEMA,
              TABLE = TG_TABLE_NAME,
              COLUMN = 'custom_role_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_roles_custom_role_active" BEFORE INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_user_role_custom_role_active();

-- Auditor A8: `system_role = 'principal'` is NULL for a custom-role row, and a CHECK passes on
-- NULL, so a custom-role row could carry no assigner. Only the platform's principal assignment
-- has none.
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_assigned_by_check";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_check"
  CHECK ("assigned_by" IS NOT NULL OR "system_role" IS NOT DISTINCT FROM 'principal');

-- ---- user_capability_grants -----------------------------------------------------------------

-- L4: nobody ends their own row (R47), as nobody makes one (user_capability_grants_not_self_check).
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_not_self_end_check"
  CHECK ("revoked_by" IS NULL OR "revoked_by" <> "user_id");

-- The three end columns are still set together, with one exception: rows ended because their user
-- became a principal through the platform's issue-principal-login have no school-user ender
-- (as user_roles_assigned_by_check allows the platform's principal row no assigner).
ALTER TABLE "user_capability_grants" DROP CONSTRAINT "user_capability_grants_revoked_check";
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_revoked_check"
  CHECK (
    ("revoked_at" IS NULL) = ("end_reason" IS NULL)
    AND ("revoked_by" IS NULL OR "revoked_at" IS NOT NULL)
    AND ("revoked_at" IS NULL OR "revoked_by" IS NOT NULL OR "end_reason" = 'became principal')
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  );
