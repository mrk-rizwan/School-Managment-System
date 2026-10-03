-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'announcement_normal', 'holiday_notice', 'diary_posted', 'remark_posted', 'register_unrecorded', 'sms_cap_reached', 'messaging_test', 'whatsapp_session_down', 'cover_assigned');

-- CreateEnum
CREATE TYPE "message_priority" AS ENUM ('urgent', 'normal', 'low', 'internal', 'platform');

-- CreateEnum
CREATE TYPE "message_channel" AS ENUM ('push', 'whatsapp', 'sms', 'email', 'in_app');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('queued', 'sending', 'sent', 'delivered', 'failed', 'suppressed');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('accepted', 'delivered', 'failed', 'suppressed');

-- CreateEnum
CREATE TYPE "suppression_reason" AS ENUM ('not_allowed', 'cap_reached', 'no_channel', 'backdated', 'subject_cancelled');

-- CreateEnum
CREATE TYPE "delivery_error_code" AS ENUM ('timeout', 'provider_unavailable', 'rate_limited', 'auth_failed', 'rejected', 'invalid_number', 'not_on_whatsapp', 'outside_window', 'session_down', 'unregistered_device', 'dnd_blocked', 'expired', 'no_report', 'unknown');

-- CreateEnum
CREATE TYPE "whatsapp_error_code" AS ENUM ('unreachable', 'logged_out', 'session_failed', 'token_rejected', 'number_mismatch', 'unknown');

-- CreateEnum
CREATE TYPE "whatsapp_provider" AS ENUM ('waha', 'cloud_api');

-- CreateEnum
CREATE TYPE "whatsapp_provider_choice" AS ENUM ('waha', 'cloud_api', 'platform_default');

-- CreateEnum
CREATE TYPE "sms_provider" AS ENUM ('sendpk');

-- CreateEnum
CREATE TYPE "sms_provider_choice" AS ENUM ('sendpk', 'platform_default');

-- CreateEnum
CREATE TYPE "whatsapp_status" AS ENUM ('pending', 'connected', 'down', 'disabled');

-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('android', 'ios');

-- CreateEnum
CREATE TYPE "device_unregistered_reason" AS ENUM ('sign_out', 'fcm_unregistered', 'replaced');

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "sms_monthly_cap" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "sms_provider" "sms_provider_choice" NOT NULL DEFAULT 'platform_default',
ADD COLUMN     "whatsapp_provider" "whatsapp_provider_choice" NOT NULL DEFAULT 'platform_default';

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" BIGINT NOT NULL DEFAULT 1,
    "default_whatsapp_provider" "whatsapp_provider" NOT NULL DEFAULT 'waha',
    "default_sms_provider" "sms_provider" NOT NULL DEFAULT 'sendpk',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_delivery_health" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "channel" "message_channel" NOT NULL,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "whatsapp_status" "whatsapp_status",
    "whatsapp_last_healthy_at" TIMESTAMPTZ(3),
    "whatsapp_last_error_code" "whatsapp_error_code",
    "sms_used" INTEGER NOT NULL DEFAULT 0,
    "sms_cap" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_delivery_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "provider" "whatsapp_provider" NOT NULL,
    "waha_session" VARCHAR(64),
    "cloud_phone_number_id" VARCHAR(32),
    "cloud_access_token" VARCHAR(2048),
    "status" "whatsapp_status" NOT NULL DEFAULT 'pending',
    "last_healthy_at" TIMESTAMPTZ(3),
    "last_error_code" "whatsapp_error_code",
    "inbound_ignored_count" INTEGER NOT NULL DEFAULT 0,
    "paired_at" TIMESTAMPTZ(3),
    "paired_by" BIGINT,
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_by" BIGINT,
    "disabled_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "session_id" BIGINT NOT NULL,
    "platform" "device_platform" NOT NULL,
    "push_token" VARCHAR(512) NOT NULL,
    "app_version" VARCHAR(14) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unregistered_at" TIMESTAMPTZ(3),
    "unregistered_reason" "device_unregistered_reason",
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "type" "message_type" NOT NULL,
    "priority" "message_priority" NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" BIGINT NOT NULL,
    "guardian_id" BIGINT,
    "staff_id" BIGINT,
    "student_id" BIGINT,
    "body" VARCHAR(2000) NOT NULL,
    "media_object_key" VARCHAR(64),
    "channel_plan" "message_channel"[],
    "status" "message_status" NOT NULL DEFAULT 'queued',
    "suppressed_reason" "suppression_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "message_id" BIGINT NOT NULL,
    "channel" "message_channel" NOT NULL,
    "attempt" SMALLINT NOT NULL,
    "status" "delivery_status" NOT NULL,
    "provider_ref_hash" CHAR(64),
    "poll_ref" TEXT,
    "to_masked" VARCHAR(32),
    "error_code" "delivery_error_code",
    "suppressed_reason" "suppression_reason",
    "segments" SMALLINT,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_usage" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "year_month" CHAR(7) NOT NULL,
    "channel" "message_channel" NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_delivery_health_school_id_day_channel_key" ON "platform_delivery_health"("school_id", "day", "channel");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_school_id_paired_by_idx" ON "whatsapp_numbers"("school_id", "paired_by");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_school_id_disabled_by_idx" ON "whatsapp_numbers"("school_id", "disabled_by");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_school_id_id_key" ON "whatsapp_numbers"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_waha_session_key" ON "whatsapp_numbers"("waha_session");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_cloud_phone_number_id_key" ON "whatsapp_numbers"("cloud_phone_number_id");

-- CreateIndex
CREATE INDEX "devices_school_id_user_id_idx" ON "devices"("school_id", "user_id");

-- CreateIndex
CREATE INDEX "devices_school_id_push_token_idx" ON "devices"("school_id", "push_token");

-- CreateIndex
CREATE UNIQUE INDEX "devices_school_id_id_key" ON "devices"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_school_id_session_id_key" ON "devices"("school_id", "session_id");

-- CreateIndex
CREATE INDEX "messages_school_id_status_created_at_idx" ON "messages"("school_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "messages_school_id_subject_type_subject_id_idx" ON "messages"("school_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "messages_school_id_guardian_id_created_at_idx" ON "messages"("school_id", "guardian_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_school_id_staff_id_created_at_idx" ON "messages"("school_id", "staff_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_school_id_student_id_created_at_idx" ON "messages"("school_id", "student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_school_id_id_key" ON "messages"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_school_id_id_key" ON "message_deliveries"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_attempt_key" ON "message_deliveries"("school_id", "message_id", "channel", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "message_usage_school_id_id_key" ON "message_usage"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_usage_school_id_year_month_channel_key" ON "message_usage"("school_id", "year_month", "channel");

-- AddForeignKey
ALTER TABLE "platform_delivery_health" ADD CONSTRAINT "platform_delivery_health_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_paired_by_fkey" FOREIGN KEY ("school_id", "paired_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_disabled_by_fkey" FOREIGN KEY ("school_id", "disabled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id_fkey" FOREIGN KEY ("school_id", "session_id") REFERENCES "sessions"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_id_fkey" FOREIGN KEY ("school_id", "message_id") REFERENCES "messages"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (phase-2-daily-operations.md §4.1, §4.2, §5 "Messaging";
-- contracts/slice-9.md §13, contracts/slice-10.md §12 item 4): CHECKs, partial unique indexes,
-- the delivery forward-only trigger, history guards, school_id immutability, the
-- platform_settings row. Generated SQL above reviewed: no drift lines. Prisma emits scalar-list
-- columns without NOT NULL, so "never NULL, no NULL element" is a CHECK on each array column.
-- =============================================================================================

-- ---- schools (non-tenant): the platform's per-school messaging knobs (owner, items 17-18) -------

ALTER TABLE "schools" ADD CONSTRAINT "schools_sms_monthly_cap_check"
  CHECK ("sms_monthly_cap" BETWEEN 0 AND 100000);

-- ---- platform_settings (non-tenant, one row) ------------------------------------------------

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_one_row_check" CHECK ("id" = 1);

INSERT INTO "platform_settings" ("id") VALUES (1);

CREATE TRIGGER "platform_settings_no_delete" BEFORE DELETE ON "platform_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_settings_no_truncate" BEFORE TRUNCATE ON "platform_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- ---- platform_delivery_health (non-tenant rollup, named exception 6) -------------------------

ALTER TABLE "platform_delivery_health" ADD CONSTRAINT "platform_delivery_health_counts_check"
  CHECK ("accepted" >= 0 AND "delivered" >= 0 AND "failed" >= 0 AND "suppressed" >= 0
         AND "sms_used" >= 0 AND "sms_cap" >= 0);

-- A rollup row is recomputed in place; which school, day and channel it describes never changes.
CREATE TRIGGER "platform_delivery_health_columns_immutable" BEFORE UPDATE ON "platform_delivery_health"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'day', 'channel');

-- ---- whatsapp_numbers (tenant) --------------------------------------------------------------

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_phone_check"
  CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');

-- Each provider carries only its own columns. A WAHA row gets its session name from its id after
-- insert (slice 9), so waha_session may be null on a WAHA row; the Cloud API's id and token are
-- set at connect.
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_provider_check"
  CHECK (
    ("provider" = 'waha' AND "cloud_phone_number_id" IS NULL AND "cloud_access_token" IS NULL)
    OR ("provider" = 'cloud_api' AND "waha_session" IS NULL
        AND "cloud_phone_number_id" IS NOT NULL AND "cloud_access_token" IS NOT NULL)
  );

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_waha_session_check"
  CHECK ("waha_session" ~ '^[a-z0-9_]{1,64}$');

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_cloud_phone_number_id_check"
  CHECK ("cloud_phone_number_id" ~ '^[0-9]{1,32}$');

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_cloud_access_token_check"
  CHECK ("cloud_access_token" LIKE 'v1:%');

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_inbound_ignored_count_check"
  CHECK ("inbound_ignored_count" >= 0);

-- paired_by is written at the pairing request, paired_at when first connected (slice-9 §13.9).
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_paired_check"
  CHECK ("paired_at" IS NULL OR "paired_by" IS NOT NULL);

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_disabled_check"
  CHECK (
    ("status" = 'disabled') = ("disabled_at" IS NOT NULL)
    AND ("disabled_at" IS NULL) = ("disabled_by" IS NULL)
    AND ("disabled_at" IS NULL) = ("disabled_reason" IS NULL)
  );

ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_disabled_reason_no_id_check"
  CHECK ("disabled_reason" !~ '[0-9]{13}' AND "disabled_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live number per school; a disabled row is history.
CREATE UNIQUE INDEX "whatsapp_numbers_school_id_live_key" ON "whatsapp_numbers" ("school_id")
  WHERE "status" <> 'disabled';

CREATE TRIGGER "whatsapp_numbers_columns_immutable" BEFORE UPDATE ON "whatsapp_numbers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('provider', 'phone', 'cloud_phone_number_id');

-- A session name, once given, is never changed or reused (the unique index keeps it from reuse).
CREATE TRIGGER "whatsapp_numbers_waha_session_frozen" BEFORE UPDATE ON "whatsapp_numbers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('waha_session');

-- A disabled number stays disabled: replacing a lost SIM is a new row.
CREATE TRIGGER "whatsapp_numbers_disabled_frozen" BEFORE UPDATE ON "whatsapp_numbers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'disabled_at', 'disabled_by', 'disabled_reason', 'status');

CREATE TRIGGER "whatsapp_numbers_no_delete" BEFORE DELETE ON "whatsapp_numbers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "whatsapp_numbers_no_truncate" BEFORE TRUNCATE ON "whatsapp_numbers"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "whatsapp_numbers_school_id_immutable" BEFORE UPDATE ON "whatsapp_numbers"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- devices (tenant) -----------------------------------------------------------------------

ALTER TABLE "devices" ADD CONSTRAINT "devices_app_version_check"
  CHECK ("app_version" ~ '^[0-9]{1,4}(\.[0-9]{1,4}){2}$');

ALTER TABLE "devices" ADD CONSTRAINT "devices_push_token_check"
  CHECK ("push_token" <> '' AND "push_token" = btrim("push_token"));

ALTER TABLE "devices" ADD CONSTRAINT "devices_unregistered_check"
  CHECK (("unregistered_at" IS NULL) = ("unregistered_reason" IS NULL));

-- A device belongs to one user for life. Everything else may move: a password change rotates
-- the session and moves the device with it (contracts/slice-9.md §13.6).
CREATE TRIGGER "devices_columns_immutable" BEFORE UPDATE ON "devices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('user_id');

CREATE TRIGGER "devices_no_delete" BEFORE DELETE ON "devices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "devices_no_truncate" BEFORE TRUNCATE ON "devices"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "devices_school_id_immutable" BEFORE UPDATE ON "devices"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- messages (tenant) ----------------------------------------------------------------------

-- Exactly one person (plan §4.2).
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_check"
  CHECK (num_nonnulls("guardian_id", "staff_id", "student_id") = 1);

ALTER TABLE "messages" ADD CONSTRAINT "messages_subject_type_check"
  CHECK ("subject_type" ~ '^[a-z][a-z_]{0,31}$');

ALTER TABLE "messages" ADD CONSTRAINT "messages_body_no_id_check"
  CHECK ("body" !~ '[0-9]{13}' AND "body" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "messages" ADD CONSTRAINT "messages_media_object_key_check"
  CHECK ("media_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$'));

ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_plan_check"
  CHECK ("channel_plan" IS NOT NULL AND array_position("channel_plan", NULL) IS NULL);

ALTER TABLE "messages" ADD CONSTRAINT "messages_suppressed_check"
  CHECK (("status" = 'suppressed') = ("suppressed_reason" IS NOT NULL));

ALTER TABLE "messages" ADD CONSTRAINT "messages_finished_check"
  CHECK (("finished_at" IS NULL) = ("status" IN ('queued', 'sending')));

-- The stale-sending recovery reads claimed_at (contracts/slice-9.md §7.6, §7.9).
ALTER TABLE "messages" ADD CONSTRAINT "messages_claimed_check"
  CHECK ("status" <> 'sending' OR "claimed_at" IS NOT NULL);

-- R107: one message per person per subject. A retried send finds the row it already wrote.
CREATE UNIQUE INDEX "messages_subject_guardian_key"
  ON "messages" ("school_id", "subject_type", "subject_id", "guardian_id")
  WHERE "guardian_id" IS NOT NULL;

CREATE UNIQUE INDEX "messages_subject_staff_key"
  ON "messages" ("school_id", "subject_type", "subject_id", "staff_id")
  WHERE "staff_id" IS NOT NULL;

CREATE UNIQUE INDEX "messages_subject_student_key"
  ON "messages" ("school_id", "subject_type", "subject_id", "student_id")
  WHERE "student_id" IS NOT NULL;

-- What was sent, to whom and about what never changes; status, plan and timestamps do.
CREATE TRIGGER "messages_columns_immutable" BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'type', 'priority', 'subject_type', 'subject_id', 'guardian_id', 'staff_id', 'student_id',
    'body', 'media_object_key', 'created_at');

CREATE TRIGGER "messages_no_delete" BEFORE DELETE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "messages_no_truncate" BEFORE TRUNCATE ON "messages"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "messages_school_id_immutable" BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- message_deliveries (tenant) ------------------------------------------------------------

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_attempt_check"
  CHECK ("attempt" >= 1);

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_segments_check"
  CHECK ("segments" >= 1);

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_provider_ref_hash_check"
  CHECK ("provider_ref_hash" ~ '^[0-9a-f]{64}$');

-- Masked: no run of seven digits, so neither an identity number nor a whole phone number.
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_to_masked_no_id_check"
  CHECK ("to_masked" !~ '[0-9]{7}');

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_status_check"
  CHECK (
    ("status" = 'delivered') = ("delivered_at" IS NOT NULL)
    AND ("status" = 'failed') = ("failed_at" IS NOT NULL)
  );

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_error_code_check"
  CHECK ("error_code" IS NULL OR "status" = 'failed');

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_suppressed_check"
  CHECK (("status" = 'suppressed') = ("suppressed_reason" IS NOT NULL));

-- A pull provider's reference, encrypted, only while an SMS attempt awaits its final status
-- (contracts/slice-9.md §7.10, §13.3): a final status must clear it.
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_poll_ref_check"
  CHECK ("poll_ref" IS NULL OR ("poll_ref" LIKE 'v1:%' AND "channel" = 'sms' AND "status" = 'accepted'));

-- Webhook correlation (named exception 5): a provider reference names one delivery, whatever the
-- school. Global on purpose; allowlisted in NON_SCHOOL_LEADING_INDEXES.
CREATE UNIQUE INDEX "message_deliveries_provider_ref_key"
  ON "message_deliveries" ("channel", "provider_ref_hash")
  WHERE "provider_ref_hash" IS NOT NULL;

-- R108: only status, delivered_at, failed_at, error_code and poll_ref change, and only forward:
-- accepted -> delivered | failed; poll_ref only to NULL. delivered, failed and suppressed are
-- final. An update that changes nothing passes (a replayed webhook). DELETE is refused. Raises
-- 23514 with DETAIL 'constraint: message_deliveries_forward_only'.
CREATE FUNCTION asms_message_delivery_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movable CONSTANT text[] := ARRAY['status', 'delivered_at', 'failed_at', 'error_code', 'poll_ref'];
BEGIN
  IF TG_OP = 'DELETE'
     OR (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable)
     OR (OLD.status <> 'accepted' AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)))
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('delivered', 'failed'))
     OR (NEW.poll_ref IS DISTINCT FROM OLD.poll_ref AND NEW.poll_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'a message delivery moves only forward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'message_deliveries_forward_only',
            DETAIL = 'constraint: message_deliveries_forward_only',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "message_deliveries_forward_only" BEFORE UPDATE OR DELETE ON "message_deliveries"
  FOR EACH ROW EXECUTE FUNCTION asms_message_delivery_forward_only();

CREATE TRIGGER "message_deliveries_no_truncate" BEFORE TRUNCATE ON "message_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "message_deliveries_school_id_immutable" BEFORE UPDATE ON "message_deliveries"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- message_usage (tenant) -----------------------------------------------------------------

ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_year_month_check"
  CHECK ("year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_sent_count_check"
  CHECK ("sent_count" >= 0);

CREATE TRIGGER "message_usage_columns_immutable" BEFORE UPDATE ON "message_usage"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('year_month', 'channel');

CREATE TRIGGER "message_usage_no_delete" BEFORE DELETE ON "message_usage"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "message_usage_no_truncate" BEFORE TRUNCATE ON "message_usage"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "message_usage_school_id_immutable" BEFORE UPDATE ON "message_usage"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
