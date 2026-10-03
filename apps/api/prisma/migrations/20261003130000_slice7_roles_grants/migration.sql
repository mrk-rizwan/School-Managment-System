-- CreateEnum
CREATE TYPE "custom_role_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "grant_effect" AS ENUM ('grant', 'revoke');

-- AlterTable
ALTER TABLE "user_roles" ADD COLUMN     "custom_role_id" BIGINT;

-- CreateTable
CREATE TABLE "custom_roles" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "status" "custom_role_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_role_capabilities" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "custom_role_id" BIGINT NOT NULL,
    "capability_key" VARCHAR(64) NOT NULL,
    "added_by" BIGINT NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" BIGINT,

    CONSTRAINT "custom_role_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_capability_grants" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "capability_key" VARCHAR(64) NOT NULL,
    "effect" "grant_effect" NOT NULL,
    "granted_by" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" BIGINT,
    "end_reason" VARCHAR(500),

    CONSTRAINT "user_capability_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_roles_school_id_id_key" ON "custom_roles"("school_id", "id");

-- CreateIndex
CREATE INDEX "custom_role_capabilities_school_id_custom_role_id_idx" ON "custom_role_capabilities"("school_id", "custom_role_id");

-- CreateIndex
CREATE INDEX "custom_role_capabilities_school_id_added_by_idx" ON "custom_role_capabilities"("school_id", "added_by");

-- CreateIndex
CREATE INDEX "custom_role_capabilities_school_id_removed_by_idx" ON "custom_role_capabilities"("school_id", "removed_by");

-- CreateIndex
CREATE UNIQUE INDEX "custom_role_capabilities_school_id_id_key" ON "custom_role_capabilities"("school_id", "id");

-- CreateIndex
CREATE INDEX "user_capability_grants_school_id_user_id_idx" ON "user_capability_grants"("school_id", "user_id");

-- CreateIndex
CREATE INDEX "user_capability_grants_school_id_granted_by_idx" ON "user_capability_grants"("school_id", "granted_by");

-- CreateIndex
CREATE INDEX "user_capability_grants_school_id_revoked_by_idx" ON "user_capability_grants"("school_id", "revoked_by");

-- CreateIndex
CREATE UNIQUE INDEX "user_capability_grants_school_id_id_key" ON "user_capability_grants"("school_id", "id");

-- CreateIndex
CREATE INDEX "user_roles_school_id_custom_role_id_idx" ON "user_roles"("school_id", "custom_role_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_custom_role_id_fkey" FOREIGN KEY ("school_id", "custom_role_id") REFERENCES "custom_roles"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_custom_role_id_fkey" FOREIGN KEY ("school_id", "custom_role_id") REFERENCES "custom_roles"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_added_by_fkey" FOREIGN KEY ("school_id", "added_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_removed_by_fkey" FOREIGN KEY ("school_id", "removed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_granted_by_fkey" FOREIGN KEY ("school_id", "granted_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_revoked_by_fkey" FOREIGN KEY ("school_id", "revoked_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (contracts/slice-7.md §6): CHECKs, partial unique indexes, the
-- end-only trigger, school_id immutability. Generated SQL above reviewed: no drift lines.
-- =============================================================================================

-- ---- user_roles -----------------------------------------------------------------------------

ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_one_role_check";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_one_role_check"
  CHECK (num_nonnulls("system_role", "custom_role_id") = 1);

-- One live assignment of a custom role per user (R96 serialises archive against it).
CREATE UNIQUE INDEX "user_roles_school_id_user_id_custom_role_key"
  ON "user_roles" ("school_id", "user_id", "custom_role_id")
  WHERE "custom_role_id" IS NOT NULL AND "ended_at" IS NULL;

-- ---- custom_roles ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "custom_roles_school_id_key_key" ON "custom_roles" ("school_id", "key")
  WHERE "status" = 'active';

ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_key_check"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,31}$');

ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

-- The key is the role's identity (an archived key may be reused by a new row, never renamed).
CREATE TRIGGER "custom_roles_columns_immutable" BEFORE UPDATE ON "custom_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('key');

CREATE TRIGGER "custom_roles_school_id_immutable" BEFORE UPDATE ON "custom_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- custom_role_capabilities ---------------------------------------------------------------

-- R45, R52: role.manage is never part of a custom role.
ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_no_role_manage_check"
  CHECK ("capability_key" <> 'role.manage');

ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_key_format_check"
  CHECK ("capability_key" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$');

ALTER TABLE "custom_role_capabilities" ADD CONSTRAINT "custom_role_capabilities_removed_check"
  CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL) AND ("removed_at" IS NULL OR "removed_at" >= "added_at"));

CREATE UNIQUE INDEX "custom_role_capabilities_live_key"
  ON "custom_role_capabilities" ("school_id", "custom_role_id", "capability_key")
  WHERE "removed_at" IS NULL;

CREATE TRIGGER "custom_role_capabilities_columns_immutable" BEFORE UPDATE ON "custom_role_capabilities"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'custom_role_id', 'capability_key', 'added_by', 'added_at');

CREATE TRIGGER "custom_role_capabilities_school_id_immutable" BEFORE UPDATE ON "custom_role_capabilities"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- user_capability_grants -----------------------------------------------------------------

-- R45, R75: role.manage never appears with either effect.
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_no_role_manage_check"
  CHECK ("capability_key" <> 'role.manage');

ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_key_format_check"
  CHECK ("capability_key" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$');

-- Nobody grants or revokes on themselves (R47).
ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_not_self_check"
  CHECK ("granted_by" <> "user_id");

ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_revoked_check"
  CHECK (
    ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
    AND ("revoked_at" IS NULL) = ("end_reason" IS NULL)
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  );

ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "user_capability_grants" ADD CONSTRAINT "user_capability_grants_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live row per (user, key, effect); also the plan's index on live rows (school_id, user_id).
CREATE UNIQUE INDEX "user_capability_grants_live_key"
  ON "user_capability_grants" ("school_id", "user_id", "capability_key", "effect")
  WHERE "revoked_at" IS NULL;

-- Append-only except ending (R50: "a grant ends solely by revoked_at"): refuses DELETE, any
-- change but setting the three end columns on a live row, and any change to an ended row.
-- Raises 23514 with DETAIL 'constraint: user_capability_grants_end_only' for the error mapper.
CREATE FUNCTION asms_grant_end_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.revoked_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.capability_key IS DISTINCT FROM OLD.capability_key
     OR NEW.effect IS DISTINCT FROM OLD.effect
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '% is append-only except ending', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'user_capability_grants_end_only',
            DETAIL = 'constraint: user_capability_grants_end_only',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_capability_grants_end_only" BEFORE UPDATE OR DELETE ON "user_capability_grants"
  FOR EACH ROW EXECUTE FUNCTION asms_grant_end_only();

-- A row trigger does not see TRUNCATE.
CREATE TRIGGER "user_capability_grants_no_truncate" BEFORE TRUNCATE ON "user_capability_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "user_capability_grants_school_id_immutable" BEFORE UPDATE ON "user_capability_grants"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
