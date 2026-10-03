-- CreateEnum
CREATE TYPE "staff_status" AS ENUM ('active', 'suspended', 'left');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "session_channel" AS ENUM ('cookie', 'bearer');

-- CreateEnum
CREATE TYPE "user_token_purpose" AS ENUM ('password_reset', 'email_verify');

-- CreateEnum
CREATE TYPE "system_role" AS ENUM ('principal', 'office_staff', 'teacher');

-- CreateTable
CREATE TABLE "staff" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "cnic" VARCHAR(255),
    "cnic_hash" CHAR(64),
    "phone" VARCHAR(16) NOT NULL,
    "designation" VARCHAR(100),
    "joined_on" DATE,
    "status" "staff_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "username_hash" CHAR(64) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "email" VARCHAR(254),
    "email_verified_at" TIMESTAMPTZ(3),
    "password_is_default" BOOLEAN NOT NULL DEFAULT true,
    "password_changed_at" TIMESTAMPTZ(3),
    "status" "user_status" NOT NULL DEFAULT 'active',
    "staff_id" BIGINT,
    "guardian_id" BIGINT,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "channel" "session_channel" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" VARCHAR(255),
    "ip" INET,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "purpose" "user_token_purpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "email" VARCHAR(254),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "system_role" "system_role",
    "assigned_by" BIGINT,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "actor_user_id" BIGINT,
    "actor_platform_user_id" BIGINT,
    "action" VARCHAR(64) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" BIGINT,
    "reason" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_school_id_id_key" ON "staff"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_id_key" ON "users"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_username_hash_key" ON "users"("school_id", "username_hash");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_staff_id_key" ON "users"("school_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_guardian_id_key" ON "users"("school_id", "guardian_id");

-- CreateIndex
CREATE INDEX "sessions_school_id_user_id_idx" ON "sessions"("school_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_school_id_id_key" ON "sessions"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_school_id_user_id_purpose_idx" ON "user_tokens"("school_id", "user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_school_id_id_key" ON "user_tokens"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_school_id_token_hash_key" ON "user_tokens"("school_id", "token_hash");

-- CreateIndex
CREATE INDEX "user_roles_school_id_user_id_idx" ON "user_roles"("school_id", "user_id");

-- CreateIndex
CREATE INDEX "user_roles_school_id_assigned_by_idx" ON "user_roles"("school_id", "assigned_by");

-- CreateIndex
CREATE INDEX "user_roles_school_id_ended_by_idx" ON "user_roles"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_school_id_id_key" ON "user_roles"("school_id", "id");

-- CreateIndex
CREATE INDEX "audit_log_school_id_subject_type_subject_id_created_at_idx" ON "audit_log"("school_id", "subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_school_id_actor_user_id_created_at_idx" ON "audit_log"("school_id", "actor_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_school_id_id_key" ON "audit_log"("school_id", "id");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("school_id", "assigned_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("school_id", "actor_user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (CHECKs, partial unique indexes, triggers). Generated SQL above
-- reviewed: no drift lines.
--
-- Deliberately NOT in this migration (each arrives with the table it references, because a
-- *_id column without its FK fails the schema guard and a nullable column is added later
-- without any data migration):
--   users.student_id          -> slice 6, FK (school_id, student_id) -> students; replaces
--                                users_person_check with num_nonnulls(staff_id, guardian_id,
--                                student_id) >= 1; adds UNIQUE (school_id, student_id).
--   user_roles.custom_role_id -> slice 7, FK (school_id, custom_role_id) -> custom_roles;
--                                replaces user_roles_one_role_check with
--                                num_nonnulls(system_role, custom_role_id) = 1; adds the partial
--                                unique (school_id, user_id, custom_role_id) on live rows.
-- =============================================================================================

-- ---- staff ----------------------------------------------------------------------------------

-- R20: a CNIC already in the school (any status) refuses a second staff row.
CREATE UNIQUE INDEX "staff_school_id_cnic_hash_key" ON "staff" ("school_id", "cnic_hash")
  WHERE "cnic_hash" IS NOT NULL;

ALTER TABLE "staff" ADD CONSTRAINT "staff_cnic_check"
  CHECK ("cnic" IS NULL OR "cnic" LIKE 'v1:%');

ALTER TABLE "staff" ADD CONSTRAINT "staff_cnic_hash_check"
  CHECK ("cnic_hash" IS NULL OR "cnic_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "staff" ADD CONSTRAINT "staff_cnic_pair_check"
  CHECK (("cnic" IS NULL) = ("cnic_hash" IS NULL));

ALTER TABLE "staff" ADD CONSTRAINT "staff_phone_check"
  CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "staff" ADD CONSTRAINT "staff_full_name_check"
  CHECK ("full_name" = btrim("full_name") AND "full_name" <> '');

CREATE TRIGGER "staff_school_id_immutable" BEFORE UPDATE ON "staff"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- users ----------------------------------------------------------------------------------

-- The username is only ever this hash (rule 12): refuses the 13 digits being stored in clear.
ALTER TABLE "users" ADD CONSTRAINT "users_username_hash_check"
  CHECK ("username_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "users" ADD CONSTRAINT "users_password_hash_check"
  CHECK ("password_hash" LIKE '$argon2id$%');

-- Not unique (R8). One representation, as on platform_users.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalised_check"
  CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND position('@' IN "email") > 1));

ALTER TABLE "users" ADD CONSTRAINT "users_email_verified_check"
  CHECK ("email_verified_at" IS NULL OR "email" IS NOT NULL);

-- Every login belongs to a person. Replaced in slice 6 to count student_id as well.
ALTER TABLE "users" ADD CONSTRAINT "users_person_check"
  CHECK (num_nonnulls("staff_id", "guardian_id") >= 1);

CREATE TRIGGER "users_school_id_immutable" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- sessions -------------------------------------------------------------------------------

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expires_at_check"
  CHECK ("expires_at" > "created_at");

CREATE TRIGGER "sessions_school_id_immutable" BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- user_tokens ----------------------------------------------------------------------------

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_token_hash_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_expires_at_check"
  CHECK ("expires_at" > "created_at");

-- A verification token is bound to the address it was issued for; a reset token carries none.
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_email_check"
  CHECK (("purpose" = 'email_verify') = ("email" IS NOT NULL));

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_email_normalised_check"
  CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND position('@' IN "email") > 1));

CREATE TRIGGER "user_tokens_school_id_immutable" BEFORE UPDATE ON "user_tokens"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- user_roles -----------------------------------------------------------------------------

-- Slice 7 replaces this with num_nonnulls("system_role", "custom_role_id") = 1.
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_one_role_check"
  CHECK (num_nonnulls("system_role") = 1);

-- One live assignment of a system role per user; ended rows are history and may repeat.
CREATE UNIQUE INDEX "user_roles_school_id_user_id_system_role_key"
  ON "user_roles" ("school_id", "user_id", "system_role")
  WHERE "system_role" IS NOT NULL AND "ended_at" IS NULL;

-- Only the platform's issue-principal-login has no school-user assigner.
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_check"
  CHECK ("assigned_by" IS NOT NULL OR "system_role" = 'principal');

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_ended_check"
  CHECK (("ended_at" IS NULL) = ("ended_by" IS NULL) AND ("ended_at" IS NULL OR "ended_at" >= "assigned_at"));

CREATE TRIGGER "user_roles_school_id_immutable" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- audit_log ------------------------------------------------------------------------------

-- §3.7: exactly one actor.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_check"
  CHECK (num_nonnulls("actor_user_id", "actor_platform_user_id") = 1);

-- §3.7 / R16: no identity number, plain or dashed, in an audit row.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_metadata_no_id_check"
  CHECK ("metadata"::text !~ '[0-9]{13}' AND "metadata"::text !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Append-only, with the shared function from 20261002163157_slice1_platform (raises with
-- DETAIL 'constraint: audit_log_append_only'). Fires before audit_log_school_id_immutable
-- (triggers fire in name order), which the schema guard still requires on every tenant table.
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

-- A row trigger does not see TRUNCATE.
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "audit_log_school_id_immutable" BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
