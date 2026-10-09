-- Phase 5 groundwork (phase-5-extended.md §3.2, §3.6, §4 migration (2)): every value set Phase 5
-- stores, the settings columns, the columns Phase 5 adds to existing tables that can stand without
-- a table of a later slice, the student_documents trigger swap, the three seeded fee heads, the
-- fee_structures category trigger, the audit and payslip indexes and the widened
-- result_sheets_born_draft. Generated SQL first (prisma migrate diff, reviewed: no drift lines;
-- the ALTER TYPE ... ADD VALUE lines it also emitted are migration 20261009120000_phase5_enums),
-- then hand-written SQL. Every hand-written object is listed in test/guardrails/schema-checks.ts
-- (PHASE_5_GROUNDWORK_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL
-- 'constraint: <name>'.
--
-- Deferred to the slice that creates the referenced table (a column waiting for its FK target is
-- not added early, schema-checks.ts NON_FK_ID_COLUMNS): result_sheets.import_id and
-- charges.import_id with the provenance pairing CHECK (slice 43, imports), expenses.event_id
-- (slice 38, events), staff_attendance.device_punch_id with the three-way source CHECK (slice 44,
-- device_punches).

-- CreateEnum
CREATE TYPE "event_type" AS ENUM ('ptm', 'trip', 'sports_day', 'function', 'visit', 'meeting', 'other');

-- CreateEnum
CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "duty_kind" AS ENUM ('registration', 'supervision', 'collection', 'transport', 'other');

-- CreateEnum
CREATE TYPE "participation_status" AS ENUM ('attended', 'absent', 'excused');

-- CreateEnum
CREATE TYPE "contract_type" AS ENUM ('permanent', 'fixed_term', 'probation');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('uploaded', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "transport_route_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "import_kind" AS ENUM ('past_results', 'opening_balances');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('previewed', 'committed', 'failed');

-- CreateEnum
CREATE TYPE "sheet_provenance" AS ENUM ('manual', 'imported');

-- CreateEnum
CREATE TYPE "staff_attendance_source" AS ENUM ('manual', 'device');

-- CreateEnum
CREATE TYPE "dispute_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "statement_basis" AS ENUM ('received', 'verified');

-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "support_session_hours" SMALLINT NOT NULL DEFAULT 4;

-- AlterTable
ALTER TABLE "result_sheets" ADD COLUMN     "provenance" "sheet_provenance" NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "school_settings" ADD COLUMN     "contract_warning_days" SMALLINT NOT NULL DEFAULT 30,
ADD COLUMN     "financial_statement_basis" "statement_basis" NOT NULL DEFAULT 'received',
ADD COLUMN     "required_document_types" "student_document_type"[] DEFAULT ARRAY['b_form', 'photo']::"student_document_type"[],
ADD COLUMN     "staff_late_after" TIME(0);

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "device_token_hash" CHAR(64),
ADD COLUMN     "device_token_rotated_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "device_user_id" VARCHAR(40);

-- AlterTable
ALTER TABLE "staff_attendance" ADD COLUMN     "source" "staff_attendance_source" NOT NULL DEFAULT 'manual',
ALTER COLUMN "marked_by" DROP NOT NULL;

-- AlterTable
ALTER TABLE "student_documents" ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "decided_by" BIGINT,
ADD COLUMN     "reject_reason" VARCHAR(500),
ADD COLUMN     "status" "document_status" NOT NULL DEFAULT 'uploaded';

-- CreateIndex
CREATE INDEX "audit_log_school_id_created_at_idx" ON "audit_log"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_school_id_action_created_at_idx" ON "audit_log"("school_id", "action" varchar_pattern_ops, "created_at");

-- CreateIndex
CREATE INDEX "audit_log_school_id_actor_platform_user_id_created_at_idx" ON "audit_log"("school_id", "actor_platform_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_school_id_device_user_id_key" ON "staff"("school_id", "device_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_school_id_id_staff_id_key" ON "staff_attendance"("school_id", "id", "staff_id");

-- CreateIndex
CREATE INDEX "student_documents_school_id_decided_by_idx" ON "student_documents"("school_id", "decided_by");

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_decided_by_fkey" FOREIGN KEY ("school_id", "decided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line.
-- =============================================================================================

-- ---- shared ------------------------------------------------------------------------------------

-- True when no element of the array repeats (nulls are refused separately). For the CHECKs on
-- enum arrays, which cannot hold a subquery.
CREATE FUNCTION asms_array_is_distinct(anyarray) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT count(DISTINCT v) = count(*) FROM unnest($1) AS t(v);
$$;

-- ---- schools (non-tenant; named exception 4 widened, §3.1) -----------------------------------

-- A device token is 32 random bytes; the school row keeps only its sha-256, lower-case hex.
ALTER TABLE "schools" ADD CONSTRAINT "schools_device_token_hash_check"
  CHECK ("device_token_hash" ~ '^[0-9a-f]{64}$');

-- Every token was set by a rotation, which stamps its time.
ALTER TABLE "schools" ADD CONSTRAINT "schools_device_token_rotated_check"
  CHECK ("device_token_hash" IS NULL OR "device_token_rotated_at" IS NOT NULL);

-- The token is what establishes the tenant of a punch (DeviceTokenRepository.findByTokenHash), so
-- a hash names one school.
CREATE UNIQUE INDEX "schools_device_token_hash_key" ON "schools" ("device_token_hash")
  WHERE "device_token_hash" IS NOT NULL;

-- ---- settings (§3.6) -----------------------------------------------------------------------------

-- Rule 36: required document types, no nulls, no repeats (an empty list requires nothing).
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_required_document_types_check"
  CHECK (
    "required_document_types" IS NOT NULL
    AND array_position("required_document_types", NULL) IS NULL
    AND asms_array_is_distinct("required_document_types")
  );

ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_contract_warning_days_check"
  CHECK ("contract_warning_days" BETWEEN 1 AND 90);

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_support_session_hours_check"
  CHECK ("support_session_hours" BETWEEN 1 AND 24);

-- ---- staff (rule 40) ---------------------------------------------------------------------------

-- A device user number: 1-40 printable ASCII characters, no spaces, never an identity number.
ALTER TABLE "staff" ADD CONSTRAINT "staff_device_user_id_check"
  CHECK ("device_user_id" ~ '^[!-~]{1,40}$');

ALTER TABLE "staff" ADD CONSTRAINT "staff_device_user_id_no_id_check"
  CHECK ("device_user_id" !~ '[0-9]{13}' AND "device_user_id" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- ---- staff_attendance (rule 40) -------------------------------------------------------------------

-- A device mark has no marking user; every other mark has one. Slice 44 tightens this to the
-- three-way rule with device_punch_id (§3.2) when device_punches exists.
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_source_check"
  CHECK (("source" = 'device') = ("marked_by" IS NULL));

-- The frozen list gains source. asms_staff_attendance_not_self needs no change: a NULL marked_by
-- matches no user, and a device insert has no acting user (test/staff-attendance/phase5-source.e2e-spec.ts).
DROP TRIGGER "staff_attendance_columns_immutable" ON "staff_attendance";
CREATE TRIGGER "staff_attendance_columns_immutable" BEFORE UPDATE ON "staff_attendance"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'date', 'marked_by', 'marked_at', 'source');

-- ---- student_documents (rule 36) -------------------------------------------------------------------

-- No longer append-only: a document is decided once. The Phase 3 trio replaces the append-only
-- pair (school_id_immutable is kept).
DROP TRIGGER "student_documents_append_only" ON "student_documents";
DROP TRIGGER "student_documents_no_truncate" ON "student_documents";

CREATE TRIGGER "student_documents_no_delete" BEFORE DELETE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "student_documents_no_truncate" BEFORE TRUNCATE ON "student_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

-- Decided exactly when not uploaded; a rejection carries its reason, nothing else does.
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_decided_check"
  CHECK (
    ("status" = 'uploaded') = ("decided_at" IS NULL)
    AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    AND ("status" = 'rejected') = ("reject_reason" IS NOT NULL)
  );

ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_reject_reason_check"
  CHECK ("reject_reason" IS NULL OR ("reject_reason" = btrim("reject_reason") AND "reject_reason" <> ''));

ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_reject_reason_no_id_check"
  CHECK ("reject_reason" !~ '[0-9]{13}' AND "reject_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- uploaded -> verified | rejected, both final (a re-upload is a new row).
CREATE TRIGGER "student_documents_status_transition" BEFORE UPDATE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('uploaded:verified', 'uploaded:rejected');

-- The document itself never changes.
CREATE TRIGGER "student_documents_columns_immutable" BEFORE UPDATE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'type', 'object_key', 'mime', 'size_bytes', 'uploaded_by', 'created_at');

CREATE TRIGGER "student_documents_decided_frozen" BEFORE UPDATE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by', 'reject_reason', 'status');

-- R322: a document is born uploaded, and nobody decides a document they uploaded (no sole-principal
-- exception: another holder of document.verify, or the uploader asks one).
CREATE FUNCTION asms_student_document_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'uploaded' THEN
    v_refusal := 'student_documents_born_uploaded';
  ELSIF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.uploaded_by THEN
    v_refusal := 'student_documents_not_self';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the document decision is refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "student_documents_decision_guard" BEFORE INSERT OR UPDATE ON "student_documents"
  FOR EACH ROW EXECUTE FUNCTION asms_student_document_decision_guard();

-- The verification queue (slice 40): a school's documents awaiting a decision, oldest first.
CREATE INDEX "student_documents_pending_idx" ON "student_documents" ("school_id", "created_at")
  WHERE "status" = 'uploaded';

-- ---- result_sheets (rule 39) -------------------------------------------------------------------------

-- An imported sheet is a term sheet born published: version 1, no submitter, decided and published
-- by the importer. Slice 43 adds import_id and the pairing (provenance = 'imported') =
-- (import_id IS NOT NULL) with the imports table.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_imported_check"
  CHECK (
    "provenance" = 'manual'
    OR ("version" = 1 AND "term_id" IS NOT NULL AND "status" = 'published' AND "submitted_by" IS NULL
        AND "decided_by" IS NOT NULL AND "decided_by" = "published_by")
  );

-- Provenance is frozen with the sheet's identity.
DROP TRIGGER "result_sheets_columns_immutable" ON "result_sheets";
CREATE TRIGGER "result_sheets_columns_immutable" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'term_id', 'class_id', 'section_id', 'version', 'supersedes_id', 'created_by',
    'created_at', 'provenance');

-- A sheet is born draft; a correction's version (slice 32) and an imported sheet (rule 39) are
-- born published.
CREATE OR REPLACE FUNCTION asms_result_sheet_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.supersedes_id IS NULL AND NEW.status <> 'draft'
      AND NOT (NEW.provenance = 'imported' AND NEW.status = 'published'))
     OR (NEW.supersedes_id IS NOT NULL AND NEW.status <> 'published') THEN
    RAISE EXCEPTION 'a result sheet is born draft, a corrected version or an imported sheet published'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'result_sheets_born_draft',
            DETAIL = 'constraint: result_sheets_born_draft',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- fee heads and structures (rules 34, 37) --------------------------------------------------------

-- At most one live transport head: the charge run names it (as tuition, R176).
CREATE UNIQUE INDEX "fee_heads_one_transport_key" ON "fee_heads" ("school_id")
  WHERE "category" = 'transport' AND "status" <> 'archived';

-- R329: a transport head is charged from the student's route and an event head by the event's
-- campaign; neither takes a fee structure, so the Phase 3 structure run never charges them.
CREATE FUNCTION asms_fee_structure_head_category() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fee_heads h
              WHERE h.school_id = NEW.school_id AND h.id = NEW.fee_head_id
                AND h.category IN ('event', 'transport')) THEN
    RAISE EXCEPTION 'an event or transport head takes no fee structure'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'fee_structures_head_category',
            DETAIL = 'constraint: fee_structures_head_category',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "fee_structures_head_category" BEFORE INSERT OR UPDATE OF "fee_head_id" ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_fee_structure_head_category();

-- §4: the finance seeds gain Transport, Event and Opening balance (packages/shared SEEDED_FEE_HEADS).
-- The five Phase 3 heads keep their guard (none seeded yet). Each new head is guarded on its own:
-- not when the school already has it seeded (by category, or by name for the `other` head, archived
-- or not), not when a live head already uses its name (fee_heads_live_name_key), and Transport not
-- when a live transport head exists (fee_heads_one_transport_key).
CREATE OR REPLACE FUNCTION asms_seed_school_finance(p_school_id bigint) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO "fee_heads" ("school_id", "name", "category", "frequency", "concession_eligible", "refundable")
  SELECT p_school_id, v.name, v.category::fee_head_category, v.frequency::fee_frequency, v.eligible, v.refundable
  FROM (VALUES
    (1, 'Tuition', 'tuition', 'monthly', true, true),
    (2, 'Admission', 'admission', 'once', true, false),
    (3, 'Annual charges', 'annual', 'yearly', true, true),
    (4, 'Exam', 'exam', 'per_term', true, true),
    (5, 'Fine', 'fine', 'ad_hoc', false, true)
  ) AS v(n, name, category, frequency, eligible, refundable)
  WHERE NOT EXISTS (
    SELECT 1 FROM "fee_heads" h WHERE h."school_id" = p_school_id AND h."created_by" IS NULL
  )
  ORDER BY v.n;

  INSERT INTO "fee_heads" ("school_id", "name", "category", "frequency", "concession_eligible", "refundable")
  SELECT p_school_id, v.name, v.category::fee_head_category, v.frequency::fee_frequency, v.eligible, v.refundable
  FROM (VALUES
    (6, 'Transport', 'transport', 'monthly', true, true),
    (7, 'Event', 'event', 'ad_hoc', true, true),
    (8, 'Opening balance', 'other', 'once', false, false)
  ) AS v(n, name, category, frequency, eligible, refundable)
  WHERE NOT EXISTS (
    SELECT 1 FROM "fee_heads" h
     WHERE h."school_id" = p_school_id AND h."created_by" IS NULL
       AND h."category" = v.category::fee_head_category
       AND (v.category <> 'other' OR lower(h."name") = lower(v.name))
  )
  AND NOT EXISTS (
    SELECT 1 FROM "fee_heads" h
     WHERE h."school_id" = p_school_id AND h."status" <> 'archived' AND lower(h."name") = lower(v.name)
  )
  AND NOT (v.category = 'transport' AND EXISTS (
    SELECT 1 FROM "fee_heads" h
     WHERE h."school_id" = p_school_id AND h."status" <> 'archived' AND h."category" = 'transport'
  ))
  ORDER BY v.n;

  INSERT INTO "leave_types" ("school_id", "name", "code", "days_per_year", "paid")
  SELECT p_school_id, v.name, v.code::leave_code, v.days, v.paid
  FROM (VALUES
    (1, 'Casual leave', 'casual', 10::smallint, true),
    (2, 'Sick leave', 'sick', 10::smallint, true),
    (3, 'Unpaid leave', 'unpaid', NULL::smallint, false)
  ) AS v(n, name, code, days, paid)
  WHERE NOT EXISTS (
    SELECT 1 FROM "leave_types" t WHERE t."school_id" = p_school_id AND t."created_by" IS NULL
  )
  ORDER BY v.n;

  INSERT INTO "school_counters" ("school_id", "name", "value")
  VALUES (p_school_id, 'expense_no', 0)
  ON CONFLICT ("school_id", "name") DO NOTHING;
$$;

-- Backfill: every existing school gets the three new heads, under the same per-head guards.
-- Written directly rather than by calling the function, as slice 24 did: a school whose five
-- Phase 3 heads were never seeded (all made by hand) must not be offered them now.
INSERT INTO "fee_heads" ("school_id", "name", "category", "frequency", "concession_eligible", "refundable")
SELECT s."id", v.name, v.category::fee_head_category, v.frequency::fee_frequency, v.eligible, v.refundable
FROM "schools" s
CROSS JOIN (VALUES
  (6, 'Transport', 'transport', 'monthly', true, true),
  (7, 'Event', 'event', 'ad_hoc', true, true),
  (8, 'Opening balance', 'other', 'once', false, false)
) AS v(n, name, category, frequency, eligible, refundable)
WHERE NOT EXISTS (
  SELECT 1 FROM "fee_heads" h
   WHERE h."school_id" = s."id" AND h."created_by" IS NULL
     AND h."category" = v.category::fee_head_category
     AND (v.category <> 'other' OR lower(h."name") = lower(v.name))
)
AND NOT EXISTS (
  SELECT 1 FROM "fee_heads" h
   WHERE h."school_id" = s."id" AND h."status" <> 'archived' AND lower(h."name") = lower(v.name)
)
AND NOT (v.category = 'transport' AND EXISTS (
  SELECT 1 FROM "fee_heads" h
   WHERE h."school_id" = s."id" AND h."status" <> 'archived' AND h."category" = 'transport'
))
ORDER BY s."id", v.n;

-- ---- payslips (rule 38) -------------------------------------------------------------------------------

-- The financial statement's salaries line reads paid payslips by paid_on.
CREATE INDEX "payslips_school_id_paid_on_idx" ON "payslips" ("school_id", "paid_on")
  WHERE "paid_on" IS NOT NULL;
