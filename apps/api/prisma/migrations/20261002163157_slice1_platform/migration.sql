-- CreateEnum
CREATE TYPE "platform_user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "platform_session_stage" AS ENUM ('totp_enrolment', 'full');

-- AlterTable
ALTER TABLE "schools" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "school_groups" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" BIGSERIAL NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "totp_secret" VARCHAR(255),
    "totp_enrolled_at" TIMESTAMPTZ(3),
    "totp_last_step" BIGINT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "password_changed_at" TIMESTAMPTZ(3),
    "status" "platform_user_status" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" BIGSERIAL NOT NULL,
    "platform_user_id" BIGINT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "stage" "platform_session_stage" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" VARCHAR(255),
    "ip" INET,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_platform_user_id" BIGINT,
    "school_id" BIGINT,
    "action" VARCHAR(64) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" BIGINT,
    "reason" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_counters" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_sessions_platform_user_id_idx" ON "platform_sessions"("platform_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_audit_log_school_id_created_at_idx" ON "platform_audit_log"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_actor_platform_user_id_created_at_idx" ON "platform_audit_log"("actor_platform_user_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_subject_type_subject_id_created_at_idx" ON "platform_audit_log"("subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "school_counters_school_id_name_key" ON "school_counters"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "school_counters_school_id_id_key" ON "school_counters"("school_id", "id");

-- CreateIndex
CREATE INDEX "schools_school_group_id_idx" ON "schools"("school_group_id");

-- AddForeignKey
ALTER TABLE "schools" ADD CONSTRAINT "schools_school_group_id_fkey" FOREIGN KEY ("school_group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_actor_platform_user_id_fkey" FOREIGN KEY ("actor_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line. Prisma cannot express these (CHECKs, triggers) or must not (the
-- tenant FK to schools; see the schema.prisma header).
--
-- Removed from the generated SQL above during review:
--   ALTER TABLE "school_settings" DROP CONSTRAINT "school_settings_school_id_fkey";
-- Prisma sees every hand-written tenant FK as drift and emits that line for each tenant table in
-- every generated migration. Deleting it is routine; the schema guard fails if one survives.
-- =============================================================================================

-- ---- schools ------------------------------------------------------------------------------

-- The code a school types at login. Existing rows already match (checked before writing).
ALTER TABLE "schools" ADD CONSTRAINT "schools_short_code_format_check"
  CHECK ("short_code" ~ '^[a-z0-9]{3,12}$');

-- Immutable after creation: it is in every bookmarked login link and every reset email. The API
-- refuses a change first (409 SCHOOL_SHORT_CODE_IMMUTABLE); this is the second line, raised with
-- a stable constraint name so the error mapper can map it to the same code.
CREATE FUNCTION asms_forbid_short_code_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.short_code IS DISTINCT FROM OLD.short_code THEN
    RAISE EXCEPTION 'short_code is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'schools_short_code_immutable',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'short_code';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "schools_short_code_immutable" BEFORE UPDATE ON "schools"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_short_code_change();

-- ---- platform_users -------------------------------------------------------------------------

-- Unique on the stored value, so the stored value must already be normalised. No citext: one
-- representation, and ON CONFLICT (email) in the seed works on the plain unique index.
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_email_normalised_check"
  CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1);

-- Refuses a plaintext or otherwise unhashed password reaching the column.
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_password_hash_check"
  CHECK ("password_hash" LIKE '$argon2id$%');

-- Refuses a plaintext base32 TOTP secret: only the field-encryption envelope (§3.6) is accepted.
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_totp_secret_check"
  CHECK ("totp_secret" IS NULL OR "totp_secret" LIKE 'v1:%');

-- Enrolled means a secret exists.
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_totp_enrolled_check"
  CHECK ("totp_enrolled_at" IS NULL OR "totp_secret" IS NOT NULL);

-- ---- platform_sessions ----------------------------------------------------------------------

-- SHA-256 lower-case hex only: refuses the raw base64url token being stored by mistake.
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_token_hash_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_expires_at_check"
  CHECK ("expires_at" > "created_at");

-- ---- platform_audit_log ---------------------------------------------------------------------

-- §3.7: no identity number, plain or dashed, in an audit row. Timestamps in metadata are ISO
-- strings; epoch milliseconds are 13 digits and would be refused.
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_metadata_no_id_check"
  CHECK ("metadata"::text !~ '[0-9]{13}' AND "metadata"::text !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Contract slice-1 §6: only the seed has no actor.
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_actor_check"
  CHECK ("actor_platform_user_id" IS NOT NULL OR "action" = 'platform_user.seeded');

-- Append-only. Shared by every append-only table (audit_log and user_capability_grants attach it
-- in later slices). Raised with a constraint name <table>_append_only for the error mapper.
CREATE FUNCTION asms_forbid_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation',
          CONSTRAINT = TG_TABLE_NAME || '_append_only',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "platform_audit_log_append_only" BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

-- A row trigger does not see TRUNCATE.
CREATE TRIGGER "platform_audit_log_no_truncate" BEFORE TRUNCATE ON "platform_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

-- ---- school_counters (tenant) ---------------------------------------------------------------

ALTER TABLE "school_counters" ADD CONSTRAINT "school_counters_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "school_counters" ADD CONSTRAINT "school_counters_name_check"
  CHECK ("name" ~ '^[a-z][a-z0-9_]{0,31}$');

ALTER TABLE "school_counters" ADD CONSTRAINT "school_counters_value_check"
  CHECK ("value" >= 0);

CREATE TRIGGER "school_counters_school_id_immutable" BEFORE UPDATE ON "school_counters"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
