-- CreateEnum
CREATE TYPE "student_status" AS ENUM ('active', 'suspended', 'withdrawn', 'transferred', 'alumni');

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "guardian_relationship" AS ENUM ('father', 'mother', 'guardian', 'other');

-- CreateEnum
CREATE TYPE "enrolment_status" AS ENUM ('active', 'completed', 'left');

-- CreateEnum
CREATE TYPE "student_document_type" AS ENUM ('b_form', 'photo', 'previous_school_leaving', 'guardian_cnic', 'other');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "student_id" BIGINT;

-- CreateTable
CREATE TABLE "students" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "admission_no" VARCHAR(20) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "gender" "gender" NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "b_form" VARCHAR(255),
    "b_form_hash" CHAR(64),
    "status" "student_status" NOT NULL DEFAULT 'active',
    "admitted_on" DATE NOT NULL,
    "notes" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_status_changes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "from_status" "student_status",
    "to_status" "student_status" NOT NULL,
    "reason" VARCHAR(500),
    "changed_by" BIGINT NOT NULL,
    "effective_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_guardians" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "guardian_id" BIGINT NOT NULL,
    "relationship" "guardian_relationship" NOT NULL,
    "is_primary_contact" BOOLEAN NOT NULL DEFAULT false,
    "is_fee_payer" BOOLEAN NOT NULL DEFAULT false,
    "can_login" BOOLEAN NOT NULL DEFAULT false,
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrolments" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "roll_no" INTEGER,
    "status" "enrolment_status" NOT NULL DEFAULT 'active',
    "started_on" DATE NOT NULL,
    "ended_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_documents" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "type" "student_document_type" NOT NULL,
    "object_key" VARCHAR(64) NOT NULL,
    "mime" VARCHAR(32) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staged_uploads" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "uploaded_by" BIGINT NOT NULL,
    "object_key" VARCHAR(64) NOT NULL,
    "mime" VARCHAR(32) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staged_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "endpoint" VARCHAR(64) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" SMALLINT NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "students_school_id_date_of_birth_idx" ON "students"("school_id", "date_of_birth");

-- CreateIndex
CREATE UNIQUE INDEX "students_school_id_id_key" ON "students"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "students_school_id_admission_no_key" ON "students"("school_id", "admission_no");

-- CreateIndex
CREATE INDEX "student_status_changes_school_id_student_id_created_at_idx" ON "student_status_changes"("school_id", "student_id", "created_at");

-- CreateIndex
CREATE INDEX "student_status_changes_school_id_changed_by_idx" ON "student_status_changes"("school_id", "changed_by");

-- CreateIndex
CREATE UNIQUE INDEX "student_status_changes_school_id_id_key" ON "student_status_changes"("school_id", "id");

-- CreateIndex
CREATE INDEX "student_guardians_school_id_student_id_idx" ON "student_guardians"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "student_guardians_school_id_guardian_id_idx" ON "student_guardians"("school_id", "guardian_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_guardians_school_id_id_key" ON "student_guardians"("school_id", "id");

-- CreateIndex
CREATE INDEX "enrolments_school_id_student_id_idx" ON "enrolments"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "enrolments_school_id_section_id_status_idx" ON "enrolments"("school_id", "section_id", "status");

-- CreateIndex
CREATE INDEX "enrolments_school_id_academic_year_id_status_idx" ON "enrolments"("school_id", "academic_year_id", "status");

-- CreateIndex
CREATE INDEX "enrolments_school_id_class_id_academic_year_id_idx" ON "enrolments"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "enrolments_school_id_section_id_class_id_idx" ON "enrolments"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_school_id_id_key" ON "enrolments"("school_id", "id");

-- CreateIndex
CREATE INDEX "student_documents_school_id_student_id_type_created_at_idx" ON "student_documents"("school_id", "student_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "student_documents_school_id_uploaded_by_idx" ON "student_documents"("school_id", "uploaded_by");

-- CreateIndex
CREATE UNIQUE INDEX "student_documents_school_id_id_key" ON "student_documents"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "student_documents_school_id_object_key_key" ON "student_documents"("school_id", "object_key");

-- CreateIndex
CREATE INDEX "staged_uploads_school_id_expires_at_idx" ON "staged_uploads"("school_id", "expires_at");

-- CreateIndex
CREATE INDEX "staged_uploads_school_id_uploaded_by_idx" ON "staged_uploads"("school_id", "uploaded_by");

-- CreateIndex
CREATE UNIQUE INDEX "staged_uploads_school_id_id_key" ON "staged_uploads"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staged_uploads_school_id_object_key_key" ON "staged_uploads"("school_id", "object_key");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_school_id_id_key" ON "idempotency_keys"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_school_id_user_id_endpoint_key_key" ON "idempotency_keys"("school_id", "user_id", "endpoint", "key");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_student_id_key" ON "users"("school_id", "student_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_status_changes" ADD CONSTRAINT "student_status_changes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_status_changes" ADD CONSTRAINT "student_status_changes_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_status_changes" ADD CONSTRAINT "student_status_changes_changed_by_fkey" FOREIGN KEY ("school_id", "changed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardian_id_fkey" FOREIGN KEY ("school_id", "guardian_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "students"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_uploaded_by_fkey" FOREIGN KEY ("school_id", "uploaded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_uploaded_by_fkey" FOREIGN KEY ("school_id", "uploaded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("school_id", "user_id") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line: CHECKs, partial unique indexes, triggers and one deferred
-- constraint trigger, which Prisma cannot express. Generated SQL above reviewed: no drift lines.
-- Constraint names the API maps are fixed by docs/plans/contracts/slice-6.md.
-- =============================================================================================

-- ---- users: the third person link -----------------------------------------------------------

-- Replaces the slice-2 version, as that migration's header promised. Every existing row has
-- staff_id or guardian_id, so the wider CHECK validates without a data migration.
ALTER TABLE "users" DROP CONSTRAINT "users_person_check";

ALTER TABLE "users" ADD CONSTRAINT "users_person_check"
  CHECK (num_nonnulls("staff_id", "guardian_id", "student_id") >= 1);

-- ---- students -------------------------------------------------------------------------------

-- R25/R26: a B-Form is on at most one student in the school, any status (a former student is
-- readmitted, never re-created). The same digits in another school are another tenant's child.
CREATE UNIQUE INDEX "students_school_id_b_form_hash_key" ON "students" ("school_id", "b_form_hash")
  WHERE "b_form_hash" IS NOT NULL;

ALTER TABLE "students" ADD CONSTRAINT "students_b_form_check"
  CHECK ("b_form" IS NULL OR "b_form" LIKE 'v1:%');

ALTER TABLE "students" ADD CONSTRAINT "students_b_form_hash_check"
  CHECK ("b_form_hash" IS NULL OR "b_form_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "students" ADD CONSTRAINT "students_b_form_pair_check"
  CHECK (("b_form" IS NULL) = ("b_form_hash" IS NULL));

-- Counter output as decimal text: no leading zero, at most 12 digits, so it can never be mistaken
-- for (or carry) a 13-digit identity number in a list response (R16).
ALTER TABLE "students" ADD CONSTRAINT "students_admission_no_check"
  CHECK ("admission_no" ~ '^[1-9][0-9]{0,11}$');

ALTER TABLE "students" ADD CONSTRAINT "students_full_name_check"
  CHECK ("full_name" = btrim("full_name") AND "full_name" <> '');

ALTER TABLE "students" ADD CONSTRAINT "students_date_of_birth_check"
  CHECK ("date_of_birth" < "admitted_on");

ALTER TABLE "students" ADD CONSTRAINT "students_notes_no_id_check"
  CHECK ("notes" !~ '[0-9]{13}' AND "notes" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "students_school_id_immutable" BEFORE UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- student_status_changes (append-only) ---------------------------------------------------

-- A transition changes the status; only the admission row starts from nothing, into active.
ALTER TABLE "student_status_changes" ADD CONSTRAINT "student_status_changes_transition_check"
  CHECK ("from_status" IS DISTINCT FROM "to_status"
         AND ("from_status" IS NOT NULL OR "to_status" = 'active'));

ALTER TABLE "student_status_changes" ADD CONSTRAINT "student_status_changes_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

CREATE TRIGGER "student_status_changes_append_only" BEFORE UPDATE OR DELETE ON "student_status_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "student_status_changes_no_truncate" BEFORE TRUNCATE ON "student_status_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "student_status_changes_school_id_immutable" BEFORE UPDATE ON "student_status_changes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- student_guardians ----------------------------------------------------------------------

-- One live link per student-guardian pair; ended links are history and may repeat.
CREATE UNIQUE INDEX "student_guardians_live_pair_key" ON "student_guardians" ("school_id", "student_id", "guardian_id")
  WHERE "ended_at" IS NULL;

-- R28 (the at-most-one half): one primary contact among a student's live links. Moving the primary
-- is clear-then-set in one transaction (contract slice-6 §4).
CREATE UNIQUE INDEX "student_guardians_primary_key" ON "student_guardians" ("school_id", "student_id")
  WHERE "is_primary_contact" AND "ended_at" IS NULL;

-- A link is ended, never re-pointed: a different student or guardian is a different link.
CREATE TRIGGER "student_guardians_columns_immutable" BEFORE UPDATE ON "student_guardians"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('student_id', 'guardian_id');

CREATE TRIGGER "student_guardians_school_id_immutable" BEFORE UPDATE ON "student_guardians"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- enrolments (the hub) -------------------------------------------------------------------

-- One active enrolment per student.
CREATE UNIQUE INDEX "enrolments_student_active_key" ON "enrolments" ("school_id", "student_id")
  WHERE "status" = 'active';

-- R37: a roll number is unique per section among active enrolments.
CREATE UNIQUE INDEX "enrolments_section_roll_no_key" ON "enrolments" ("school_id", "section_id", "roll_no")
  WHERE "roll_no" IS NOT NULL AND "status" = 'active';

ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_roll_no_check"
  CHECK ("roll_no" IS NULL OR "roll_no" BETWEEN 1 AND 9999);

-- Open exactly while active; a class move ends one row and starts the next on the same date.
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_ended_check"
  CHECK (("status" = 'active') = ("ended_on" IS NULL)
         AND ("ended_on" IS NULL OR "ended_on" >= "started_on"));

-- R39: a class move closes this row and opens another; never an edit. The section may change
-- within the class (its composite FK keeps it a section of class_id).
CREATE TRIGGER "enrolments_columns_immutable" BEFORE UPDATE ON "enrolments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('student_id', 'academic_year_id', 'class_id');

CREATE TRIGGER "enrolments_school_id_immutable" BEFORE UPDATE ON "enrolments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- student_documents (append-only) and staged_uploads ------------------------------------

-- `{school_id}/{ULID}.{ext}`, the prefix bound to the row's own school: a key naming another
-- tenant's object cannot be recorded, whatever the application does.
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_object_key_check"
  CHECK ("object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$'));

ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_mime_check"
  CHECK ("mime" IN ('image/jpeg', 'image/png', 'application/pdf'));

ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_photo_mime_check"
  CHECK ("type" <> 'photo' OR "mime" IN ('image/jpeg', 'image/png'));

ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_size_bytes_check"
  CHECK ("size_bytes" BETWEEN 1 AND 5242880);

CREATE TRIGGER "student_documents_append_only" BEFORE UPDATE OR DELETE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "student_documents_no_truncate" BEFORE TRUNCATE ON "student_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "student_documents_school_id_immutable" BEFORE UPDATE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_object_key_check"
  CHECK ("object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$'));

ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_mime_check"
  CHECK ("mime" IN ('image/jpeg', 'image/png', 'application/pdf'));

ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_size_bytes_check"
  CHECK ("size_bytes" BETWEEN 1 AND 5242880);

ALTER TABLE "staged_uploads" ADD CONSTRAINT "staged_uploads_expires_at_check"
  CHECK ("expires_at" > "created_at");

CREATE TRIGGER "staged_uploads_school_id_immutable" BEFORE UPDATE ON "staged_uploads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- idempotency_keys -----------------------------------------------------------------------

-- The header format (contract slice-6 §6.3), and never a 13-digit run (R82: the row holds no
-- identity digits). The API refuses such a key with 422 before it reaches the database.
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_check"
  CHECK ("key" ~ '^[A-Za-z0-9_-]{16,64}$');

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_no_id_check"
  CHECK ("key" !~ '[0-9]{13}');

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_endpoint_check"
  CHECK ("endpoint" ~ '^[a-z][a-z0-9_.-]{0,63}$');

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_request_hash_check"
  CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

-- R87: only a committed request stores a key, and a committed request succeeded.
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_response_status_check"
  CHECK ("response_status" BETWEEN 200 AND 299);

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_subject_type_check"
  CHECK ("subject_type" ~ '^[a-z][a-z_]{0,31}$');

-- The row is inserted before its subject exists and completed before commit. A key left without
-- its subject could never be replayed, so commit refuses it. Deferred, so it reads the row's final
-- version at commit; raises with DETAIL like every other trigger function.
CREATE FUNCTION asms_require_idempotency_subject() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.id = NEW.id AND k.subject_id IS NULL) THEN
    RAISE EXCEPTION 'idempotency key committed without its subject'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'idempotency_keys_subject_required',
            DETAIL = 'constraint: idempotency_keys_subject_required',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'subject_id';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "idempotency_keys_subject_required" AFTER INSERT OR UPDATE ON "idempotency_keys"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asms_require_idempotency_subject();

CREATE TRIGGER "idempotency_keys_school_id_immutable" BEFORE UPDATE ON "idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
