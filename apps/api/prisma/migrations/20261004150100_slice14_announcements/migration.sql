-- Slice 14: announcements, their audiences and recipients, messages.title and the holidays ->
-- announcements foreign key (contracts/slice-14.md §11, R144-R152). holidays.announcement_id
-- gains its composite FK here, after both tables exist; announcements.holiday_id points back. No
-- cascade either way (schema guard). suppression_reason gains duplicate_phone in the previous
-- migration (an enum value is not usable in the transaction that adds it).

-- CreateEnum
CREATE TYPE "announcement_category" AS ENUM ('holiday', 'exam', 'fee', 'event', 'general');

-- CreateEnum
CREATE TYPE "announcement_priority" AS ENUM ('normal', 'urgent');

-- CreateEnum
CREATE TYPE "announcement_status" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'cancelled');

-- CreateEnum
CREATE TYPE "audience_kind" AS ENUM ('everyone', 'parents', 'students', 'staff', 'class', 'section', 'student', 'guardian', 'staff_member');

-- CreateEnum
CREATE TYPE "audience_role" AS ENUM ('parents', 'students');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "title" VARCHAR(120);

-- CreateTable
CREATE TABLE "announcements" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(1800) NOT NULL,
    "category" "announcement_category" NOT NULL,
    "priority" "announcement_priority" NOT NULL,
    "status" "announcement_status" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMPTZ(3),
    "expires_on" DATE,
    "attachment_object_key" VARCHAR(64),
    "attachment_mime" VARCHAR(32),
    "attachment_size_bytes" INTEGER,
    "holiday_id" BIGINT,
    "created_by" BIGINT NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" VARCHAR(500),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_audiences" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "announcement_id" BIGINT NOT NULL,
    "kind" "audience_kind" NOT NULL,
    "class_id" BIGINT,
    "section_id" BIGINT,
    "student_id" BIGINT,
    "guardian_id" BIGINT,
    "staff_id" BIGINT,
    "roles" "audience_role"[] DEFAULT ARRAY['parents', 'students']::"audience_role"[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_recipients" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "announcement_id" BIGINT NOT NULL,
    "guardian_id" BIGINT,
    "staff_id" BIGINT,
    "student_id" BIGINT,
    "message_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_recipient_students" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "announcement_recipient_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_recipient_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_school_id_status_scheduled_at_idx" ON "announcements"("school_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "announcements_school_id_created_by_created_at_idx" ON "announcements"("school_id", "created_by", "created_at");

-- CreateIndex
CREATE INDEX "announcements_school_id_holiday_id_idx" ON "announcements"("school_id", "holiday_id");

-- CreateIndex
CREATE INDEX "announcements_school_id_cancelled_by_idx" ON "announcements"("school_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "announcements_school_id_id_key" ON "announcements"("school_id", "id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_announcement_id_idx" ON "announcement_audiences"("school_id", "announcement_id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_class_id_idx" ON "announcement_audiences"("school_id", "class_id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_section_id_idx" ON "announcement_audiences"("school_id", "section_id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_student_id_idx" ON "announcement_audiences"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_guardian_id_idx" ON "announcement_audiences"("school_id", "guardian_id");

-- CreateIndex
CREATE INDEX "announcement_audiences_school_id_staff_id_idx" ON "announcement_audiences"("school_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_audiences_school_id_id_key" ON "announcement_audiences"("school_id", "id");

-- CreateIndex
CREATE INDEX "announcement_recipients_school_id_announcement_id_idx" ON "announcement_recipients"("school_id", "announcement_id");

-- CreateIndex
CREATE INDEX "announcement_recipients_school_id_guardian_id_idx" ON "announcement_recipients"("school_id", "guardian_id");

-- CreateIndex
CREATE INDEX "announcement_recipients_school_id_staff_id_idx" ON "announcement_recipients"("school_id", "staff_id");

-- CreateIndex
CREATE INDEX "announcement_recipients_school_id_student_id_idx" ON "announcement_recipients"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "announcement_recipients_school_id_message_id_idx" ON "announcement_recipients"("school_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_recipients_school_id_id_key" ON "announcement_recipients"("school_id", "id");

-- CreateIndex
CREATE INDEX "announcement_recipient_students_school_id_student_id_idx" ON "announcement_recipient_students"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_recipient_students_school_id_id_key" ON "announcement_recipient_students"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_recipient_students_key" ON "announcement_recipient_students"("school_id", "announcement_recipient_id", "student_id");

-- CreateIndex
CREATE INDEX "holidays_school_id_announcement_id_idx" ON "holidays"("school_id", "announcement_id");

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_announcement_id_fkey" FOREIGN KEY ("school_id", "announcement_id") REFERENCES "announcements"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_holiday_id_fkey" FOREIGN KEY ("school_id", "holiday_id") REFERENCES "holidays"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cancelled_by_fkey" FOREIGN KEY ("school_id", "cancelled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_announcement_id_fkey" FOREIGN KEY ("school_id", "announcement_id") REFERENCES "announcements"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_class_id_fkey" FOREIGN KEY ("school_id", "class_id") REFERENCES "classes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_section_id_fkey" FOREIGN KEY ("school_id", "section_id") REFERENCES "sections"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_announcement_id_fkey" FOREIGN KEY ("school_id", "announcement_id") REFERENCES "announcements"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_message_id_fkey" FOREIGN KEY ("school_id", "message_id") REFERENCES "messages"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipient_students" ADD CONSTRAINT "announcement_recipient_students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipient_students" ADD CONSTRAINT "announcement_recipient_students_announcement_recipient_id_fkey" FOREIGN KEY ("school_id", "announcement_recipient_id") REFERENCES "announcement_recipients"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "announcement_recipient_students" ADD CONSTRAINT "announcement_recipient_students_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (contracts/slice-14.md §11). Generated SQL above reviewed: no
-- drift lines. Every object here is listed in test/guardrails/schema-checks.ts
-- (SLICE_14_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- messages.title (§4.4, item 6) -----------------------------------------------------------

ALTER TABLE "messages" ADD CONSTRAINT "messages_title_no_id_check"
  CHECK ("title" !~ '[0-9]{13}' AND "title" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Only an announcement-carried message (the three types, all with subject `announcement`) has its
-- own title; every other type keeps titleOf().
ALTER TABLE "messages" ADD CONSTRAINT "messages_title_check"
  CHECK ("title" IS NULL OR "subject_type" = 'announcement');

-- ---- announcements (item 2) ------------------------------------------------------------------

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_title_check"
  CHECK ("title" = btrim("title") AND "title" <> '');

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_title_no_id_check"
  CHECK ("title" !~ '[0-9]{13}' AND "title" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_body_check"
  CHECK ("body" = btrim("body") AND "body" <> '');

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_body_no_id_check"
  CHECK ("body" !~ '[0-9]{13}' AND "body" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cancel_reason_no_id_check"
  CHECK ("cancel_reason" !~ '[0-9]{13}' AND "cancel_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- The staged-upload rules (slice 6): key, mime and size together, the same key shape, types and cap.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_attachment_check"
  CHECK (
    ("attachment_object_key" IS NULL) = ("attachment_mime" IS NULL)
    AND ("attachment_object_key" IS NULL) = ("attachment_size_bytes" IS NULL)
    AND ("attachment_object_key" IS NULL OR (
      "attachment_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$')
      AND "attachment_mime" IN ('image/jpeg', 'image/png', 'application/pdf')
      AND "attachment_size_bytes" BETWEEN 1 AND 5242880))
  );

-- A staged object is consumed once. A replaced attachment's object stays in storage (rule 4).
CREATE UNIQUE INDEX "announcements_attachment_object_key_key"
  ON "announcements" ("school_id", "attachment_object_key")
  WHERE "attachment_object_key" IS NOT NULL;

-- Required when scheduled. A draft may carry the time it will be scheduled for (§5.4: "stored on
-- the draft; it takes effect at send"; §5.5 step 3), and the time is kept as history once
-- sending, sent or cancelled (decision 11 relaxes "set iff scheduled").
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_scheduled_check"
  CHECK ("status" <> 'scheduled' OR "scheduled_at" IS NOT NULL);

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_sent_check"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cancelled_check"
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
  );

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_recipient_count_check"
  CHECK ("recipient_count" >= 0 AND ("status" IN ('sending', 'sent') OR "recipient_count" = 0));

-- Who wrote it and which holiday it is the notice of never change.
CREATE TRIGGER "announcements_columns_immutable" BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('created_by', 'holiday_id', 'created_at');

-- R146 in the database: content is editable while draft or scheduled. From `sending` only the
-- send's own columns move (status to sent, sent_at, recipient_count); `sent` and `cancelled` are
-- final (updated_at aside).
CREATE FUNCTION asms_announcement_final_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_send_columns text[] := ARRAY['status', 'sent_at', 'recipient_count', 'updated_at'];
BEGIN
  IF (OLD.status = 'sending'
      AND (NEW.status NOT IN ('sending', 'sent')
           OR (to_jsonb(NEW) - v_send_columns) IS DISTINCT FROM (to_jsonb(OLD) - v_send_columns)))
     OR (OLD.status IN ('sent', 'cancelled')
         AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')) THEN
    RAISE EXCEPTION 'a sending, sent or cancelled announcement is frozen'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'announcements_final_frozen',
            DETAIL = 'constraint: announcements_final_frozen',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "announcements_final_frozen" BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION asms_announcement_final_frozen();

CREATE TRIGGER "announcements_no_delete" BEFORE DELETE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcements_no_truncate" BEFORE TRUNCATE ON "announcements"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcements_school_id_immutable" BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- announcement_audiences (item 3) ---------------------------------------------------------

-- Exactly the foreign key the kind names; the broad kinds name none.
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_target_check"
  CHECK (
    num_nonnulls("class_id", "section_id", "student_id", "guardian_id", "staff_id")
      = CASE WHEN "kind" IN ('everyone', 'parents', 'students', 'staff') THEN 0 ELSE 1 END
    AND ("class_id" IS NOT NULL) = ("kind" = 'class')
    AND ("section_id" IS NOT NULL) = ("kind" = 'section')
    AND ("student_id" IS NOT NULL) = ("kind" = 'student')
    AND ("guardian_id" IS NOT NULL) = ("kind" = 'guardian')
    AND ("staff_id" IS NOT NULL) = ("kind" = 'staff_member')
  );

-- One or two distinct roles, never a NULL element (a CHECK cannot hold a subquery; with two enum
-- values "distinct" is the two elements differing).
ALTER TABLE "announcement_audiences" ADD CONSTRAINT "announcement_audiences_roles_check"
  CHECK (
    "roles" IS NOT NULL
    AND array_position("roles", NULL) IS NULL
    AND (cardinality("roles") = 1 OR (cardinality("roles") = 2 AND "roles"[1] <> "roles"[2]))
  );

-- One row per target of an announcement (roles merged by the client, §4.1).
CREATE UNIQUE INDEX "announcement_audiences_target_key" ON "announcement_audiences" (
  "school_id", "announcement_id", "kind", COALESCE("class_id", 0), COALESCE("section_id", 0),
  COALESCE("student_id", 0), COALESCE("guardian_id", 0), COALESCE("staff_id", 0));

-- A draft's audience is a form field, replaced on PATCH (decision 12): rows are deleted and
-- inserted, never edited, so there is no no-delete trigger; TRUNCATE is still refused.
CREATE TRIGGER "announcement_audiences_columns_immutable" BEFORE UPDATE ON "announcement_audiences"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'announcement_id', 'kind', 'class_id', 'section_id', 'student_id', 'guardian_id', 'staff_id',
    'roles', 'created_at');

CREATE TRIGGER "announcement_audiences_no_truncate" BEFORE TRUNCATE ON "announcement_audiences"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcement_audiences_school_id_immutable" BEFORE UPDATE ON "announcement_audiences"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- announcement_recipients (item 4) --------------------------------------------------------

ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_person_check"
  CHECK (num_nonnulls("guardian_id", "staff_id", "student_id") = 1);

-- R145: a person once per announcement; a racing send settles here (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "announcement_recipients_guardian_key"
  ON "announcement_recipients" ("school_id", "announcement_id", "guardian_id")
  WHERE "guardian_id" IS NOT NULL;

CREATE UNIQUE INDEX "announcement_recipients_staff_key"
  ON "announcement_recipients" ("school_id", "announcement_id", "staff_id")
  WHERE "staff_id" IS NOT NULL;

CREATE UNIQUE INDEX "announcement_recipients_student_key"
  ON "announcement_recipients" ("school_id", "announcement_id", "student_id")
  WHERE "student_id" IS NOT NULL;

-- Append-only: only message_id changes, once, from NULL (the send's back-fill).
CREATE TRIGGER "announcement_recipients_columns_immutable" BEFORE UPDATE ON "announcement_recipients"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'announcement_id', 'guardian_id', 'staff_id', 'student_id', 'created_at');

CREATE TRIGGER "announcement_recipients_message_id_frozen" BEFORE UPDATE ON "announcement_recipients"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('message_id');

CREATE TRIGGER "announcement_recipients_no_delete" BEFORE DELETE ON "announcement_recipients"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcement_recipients_no_truncate" BEFORE TRUNCATE ON "announcement_recipients"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcement_recipients_school_id_immutable" BEFORE UPDATE ON "announcement_recipients"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- announcement_recipient_students (item 5) ------------------------------------------------

CREATE TRIGGER "announcement_recipient_students_columns_immutable" BEFORE UPDATE ON "announcement_recipient_students"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'announcement_recipient_id', 'student_id', 'created_at');

CREATE TRIGGER "announcement_recipient_students_no_delete" BEFORE DELETE ON "announcement_recipient_students"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcement_recipient_students_no_truncate" BEFORE TRUNCATE ON "announcement_recipient_students"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "announcement_recipient_students_school_id_immutable" BEFORE UPDATE ON "announcement_recipient_students"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
