-- Phase 5 wave U (phase-5-extended.md rules 38-40, §1.1, §1.3 A9, A10, A12, §3.1 "Exception 7",
-- §3.2 "Rankings", "Imports", "Support", R332-R343, R349-R353): the tables of slices 42 (class
-- rankings: class_rankings, class_ranking_rows), 43 (commencement imports: imports, with the
-- deferred result_sheets.import_id and charges.import_id) and 45 (platform support access:
-- platform_support_sessions, non-tenant like platform_audit_log), and two report indexes for
-- slice 42 (salary_advances by granted_on, staff_attendance by date). The settings the slices read
-- (school_settings.financial_statement_basis, platform_settings.support_session_hours) are the
-- groundwork's. The three slices write no migration of their own. Generated DDL first (prisma
-- migrate diff from the migrated database, reviewed: no drift lines; the two new value sets are
-- new types, so no separate ALTER TYPE migration is needed), hand-written SQL after the marker.

-- CreateEnum
CREATE TYPE "ranking_trigger" AS ENUM ('publish', 'correction', 'import');

-- CreateEnum
CREATE TYPE "support_session_end" AS ENUM ('closed', 'revoked', 'expired');

-- AlterTable
ALTER TABLE "charges" ADD COLUMN     "import_id" BIGINT;

-- AlterTable
ALTER TABLE "result_sheets" ADD COLUMN     "import_id" BIGINT;

-- CreateTable
CREATE TABLE "class_rankings" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "term_id" BIGINT NOT NULL,
    "trigger" "ranking_trigger" NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" BIGINT,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "class_rankings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_ranking_rows" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "ranking_id" BIGINT NOT NULL,
    "result_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "class_position" SMALLINT,
    "position_of" SMALLINT,

    CONSTRAINT "class_ranking_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imports" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "kind" "import_kind" NOT NULL,
    "file_hash" CHAR(64) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "status" "import_status" NOT NULL DEFAULT 'previewed',
    "academic_year_id" BIGINT NOT NULL,
    "section_id" BIGINT,
    "class_id" BIGINT,
    "term_id" BIGINT,
    "due_on" DATE,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_by" BIGINT,
    "committed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "error" VARCHAR(2000),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_support_sessions" (
    "id" BIGSERIAL NOT NULL,
    "platform_user_id" BIGINT NOT NULL,
    "school_id" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "ticket_ref" VARCHAR(40) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "end_kind" "support_session_end",
    "close_reason" VARCHAR(500),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" BIGINT,
    "revoke_reason" VARCHAR(500),

    CONSTRAINT "platform_support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "class_rankings_school_id_class_id_idx" ON "class_rankings"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "class_rankings_school_id_term_id_idx" ON "class_rankings"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_rankings_school_id_id_key" ON "class_rankings"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_rankings_school_id_id_class_id_term_id_key" ON "class_rankings"("school_id", "id", "class_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_rankings_supersedes_key" ON "class_rankings"("school_id", "supersedes_id", "class_id", "term_id");

-- CreateIndex
CREATE INDEX "class_ranking_rows_school_id_ranking_id_position_idx" ON "class_ranking_rows"("school_id", "ranking_id", "class_position");

-- CreateIndex
CREATE INDEX "class_ranking_rows_school_id_result_id_idx" ON "class_ranking_rows"("school_id", "result_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "class_ranking_rows_school_id_enrolment_id_idx" ON "class_ranking_rows"("school_id", "enrolment_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_ranking_rows_school_id_id_key" ON "class_ranking_rows"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_ranking_rows_ranking_enrolment_key" ON "class_ranking_rows"("school_id", "ranking_id", "enrolment_id");

-- CreateIndex
CREATE INDEX "imports_school_id_kind_created_at_idx" ON "imports"("school_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "imports_school_id_created_at_idx" ON "imports"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "imports_school_id_academic_year_id_idx" ON "imports"("school_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "imports_school_id_class_id_idx" ON "imports"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "imports_school_id_section_id_idx" ON "imports"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "imports_school_id_term_id_idx" ON "imports"("school_id", "term_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "imports_school_id_created_by_idx" ON "imports"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "imports_school_id_committed_by_idx" ON "imports"("school_id", "committed_by");

-- CreateIndex
CREATE UNIQUE INDEX "imports_school_id_id_key" ON "imports"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "imports_school_id_id_academic_year_id_key" ON "imports"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE INDEX "platform_support_sessions_platform_user_id_opened_at_idx" ON "platform_support_sessions"("platform_user_id", "opened_at");

-- CreateIndex
CREATE INDEX "platform_support_sessions_school_id_opened_at_idx" ON "platform_support_sessions"("school_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_import_key" ON "result_sheets"("school_id", "import_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "salary_advances_school_id_granted_on_idx" ON "salary_advances"("school_id", "granted_on");

-- CreateIndex
CREATE INDEX "staff_attendance_school_id_date_idx" ON "staff_attendance"("school_id", "date");

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_import_id_fkey" FOREIGN KEY ("school_id", "import_id", "academic_year_id") REFERENCES "imports"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_import_id_fkey" FOREIGN KEY ("school_id", "import_id", "academic_year_id") REFERENCES "imports"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_rankings" ADD CONSTRAINT "class_rankings_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_rankings" ADD CONSTRAINT "class_rankings_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_rankings" ADD CONSTRAINT "class_rankings_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_rankings" ADD CONSTRAINT "class_rankings_supersedes_id_fkey" FOREIGN KEY ("school_id", "supersedes_id", "class_id", "term_id") REFERENCES "class_rankings"("school_id", "id", "class_id", "term_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_ranking_rows" ADD CONSTRAINT "class_ranking_rows_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_ranking_rows" ADD CONSTRAINT "class_ranking_rows_ranking_id_fkey" FOREIGN KEY ("school_id", "ranking_id") REFERENCES "class_rankings"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_ranking_rows" ADD CONSTRAINT "class_ranking_rows_result_id_fkey" FOREIGN KEY ("school_id", "result_id", "enrolment_id") REFERENCES "results"("school_id", "id", "enrolment_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "class_ranking_rows" ADD CONSTRAINT "class_ranking_rows_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id") REFERENCES "enrolments"("school_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_term_id_fkey" FOREIGN KEY ("school_id", "term_id", "academic_year_id") REFERENCES "academic_terms"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_committed_by_fkey" FOREIGN KEY ("school_id", "committed_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line. Every object here is listed in test/guardrails/schema-checks.ts
-- (WAVE_U_OBJECTS) and written directly by test/phase5/wave-u-schema.e2e-spec.ts. Trigger
-- functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>' (prisma-errors.ts reads it). A
-- guard that reads a parent row's state locks it FOR SHARE, so a write racing a change of that
-- state (an import committed or expired, a ranking superseded) waits for it and then sees it.
-- =============================================================================================

-- ---- class_rankings (rule 38, A9, R333) -----------------------------------------------------------

-- One live version per class-term: the merit list reads it.
CREATE UNIQUE INDEX "class_rankings_live_key" ON "class_rankings" ("school_id", "class_id", "term_id")
  WHERE "superseded_at" IS NULL;

-- Only the first version of a class-term has no predecessor, so the versions form one chain.
CREATE UNIQUE INDEX "class_rankings_first_key" ON "class_rankings" ("school_id", "class_id", "term_id")
  WHERE "supersedes_id" IS NULL;

CREATE TRIGGER "class_rankings_columns_immutable" BEFORE UPDATE ON "class_rankings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'class_id', 'academic_year_id', 'term_id', 'trigger', 'computed_at', 'supersedes_id');

CREATE TRIGGER "class_rankings_superseded_frozen" BEFORE UPDATE ON "class_rankings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at');

-- A version is born live; a version that supersedes another is inserted after that one was
-- stamped superseded (the order of a recompute: stamp, insert, rows).
CREATE FUNCTION asms_class_ranking_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_predecessor_superseded timestamptz;
  v_refusal text;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT r.superseded_at INTO v_predecessor_superseded FROM class_rankings r
     WHERE r.school_id = NEW.school_id AND r.id = NEW.supersedes_id
     FOR SHARE;
  END IF;
  IF NEW.superseded_at IS NOT NULL THEN
    v_refusal := 'class_rankings_born_live';
  ELSIF NEW.supersedes_id IS NOT NULL AND v_predecessor_superseded IS NULL THEN
    v_refusal := 'class_rankings_supersede_order';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'class ranking refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "class_rankings_guard" BEFORE INSERT ON "class_rankings"
  FOR EACH ROW EXECUTE FUNCTION asms_class_ranking_guard();

CREATE TRIGGER "class_rankings_no_delete" BEFORE DELETE ON "class_rankings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "class_rankings_no_truncate" BEFORE TRUNCATE ON "class_rankings"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "class_rankings_school_id_immutable" BEFORE UPDATE ON "class_rankings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- class_ranking_rows (R333; append-only) -------------------------------------------------------

-- A student with nothing assessed is listed without a position (packages/shared classRanking).
ALTER TABLE "class_ranking_rows" ADD CONSTRAINT "class_ranking_rows_position_check"
  CHECK (
    ("class_position" IS NULL) = ("position_of" IS NULL)
    AND ("class_position" IS NULL OR "class_position" BETWEEN 1 AND "position_of")
  );

-- At insert: the version is live; the result is a live published result of the version's term
-- (a correction cascade supersedes the old results before it ranks); the enrolment is of the
-- version's class; a position exactly when the result has a percentage.
CREATE FUNCTION asms_class_ranking_row_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_term_id bigint;
  v_ranking_superseded timestamptz;
  v_result_term_id bigint;
  v_published_at timestamptz;
  v_result_superseded timestamptz;
  v_percent_bp integer;
  v_enrolment_class_id bigint;
  v_refusal text;
BEGIN
  SELECT r.class_id, r.term_id, r.superseded_at INTO v_class_id, v_term_id, v_ranking_superseded
    FROM class_rankings r
   WHERE r.school_id = NEW.school_id AND r.id = NEW.ranking_id
   FOR SHARE;
  SELECT x.term_id, x.published_at, x.superseded_at, x.percent_bp
    INTO v_result_term_id, v_published_at, v_result_superseded, v_percent_bp
    FROM results x
   WHERE x.school_id = NEW.school_id AND x.id = NEW.result_id;
  SELECT e.class_id INTO v_enrolment_class_id FROM enrolments e
   WHERE e.school_id = NEW.school_id AND e.id = NEW.enrolment_id;
  IF v_ranking_superseded IS NOT NULL THEN
    v_refusal := 'class_ranking_rows_ranking_live';
  ELSIF v_result_term_id IS DISTINCT FROM v_term_id OR v_published_at IS NULL OR v_result_superseded IS NOT NULL THEN
    v_refusal := 'class_ranking_rows_result_live';
  ELSIF v_enrolment_class_id IS DISTINCT FROM v_class_id THEN
    v_refusal := 'class_ranking_rows_class';
  ELSIF (NEW.class_position IS NULL) <> (v_percent_bp IS NULL) THEN
    v_refusal := 'class_ranking_rows_unranked';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'class ranking row refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "class_ranking_rows_guard" BEFORE INSERT ON "class_ranking_rows"
  FOR EACH ROW EXECUTE FUNCTION asms_class_ranking_row_guard();

CREATE TRIGGER "class_ranking_rows_append_only" BEFORE UPDATE OR DELETE ON "class_ranking_rows"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "class_ranking_rows_no_truncate" BEFORE TRUNCATE ON "class_ranking_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change();

CREATE TRIGGER "class_ranking_rows_school_id_immutable" BEFORE UPDATE ON "class_ranking_rows"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- imports (rule 39, R339-R343) -------------------------------------------------------------------

ALTER TABLE "imports" ADD CONSTRAINT "imports_file_hash_check"
  CHECK ("file_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "imports" ADD CONSTRAINT "imports_file_name_check"
  CHECK ("file_name" = btrim("file_name") AND "file_name" <> '');

ALTER TABLE "imports" ADD CONSTRAINT "imports_file_name_no_id_check"
  CHECK ("file_name" !~ '[0-9]{13}' AND "file_name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.3: at most 5,000 data rows.
ALTER TABLE "imports" ADD CONSTRAINT "imports_row_count_check"
  CHECK ("row_count" BETWEEN 0 AND 5000);

-- §7.1: the stored rows are a JSON array, bounded to 5,000 entries and 1 MB of text. CASE, so a
-- non-array is refused by this CHECK rather than by jsonb_array_length's own error.
ALTER TABLE "imports" ADD CONSTRAINT "imports_rows_check"
  CHECK (
    CASE WHEN jsonb_typeof("rows") = 'array'
         THEN jsonb_array_length("rows") <= 5000 AND octet_length("rows"::text) <= 1048576
         ELSE false END
  );

ALTER TABLE "imports" ADD CONSTRAINT "imports_rows_no_id_check"
  CHECK ("rows"::text !~ '[0-9]{13}' AND "rows"::text !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §5.1 IMPORT_ROWS_INVALID: at most 100 row errors travel; error_count is the full count.
ALTER TABLE "imports" ADD CONSTRAINT "imports_errors_check"
  CHECK (
    CASE WHEN jsonb_typeof("errors") = 'array'
         THEN jsonb_array_length("errors") <= 100
              AND "error_count" >= jsonb_array_length("errors")
              AND octet_length("errors"::text) <= 65536
         ELSE false END
  );

ALTER TABLE "imports" ADD CONSTRAINT "imports_errors_no_id_check"
  CHECK ("errors"::text !~ '[0-9]{13}' AND "errors"::text !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.2: a past-results file names its section, class and term; an opening-balances file its due
-- date; neither names the other's.
ALTER TABLE "imports" ADD CONSTRAINT "imports_kind_check"
  CHECK (
    ("kind" = 'past_results' AND "section_id" IS NOT NULL AND "class_id" IS NOT NULL
      AND "term_id" IS NOT NULL AND "due_on" IS NULL)
    OR ("kind" = 'opening_balances' AND "section_id" IS NULL AND "class_id" IS NULL
      AND "term_id" IS NULL AND "due_on" IS NOT NULL)
  );

-- Committed exactly when stamped, and only a file with no row errors (§0.34: a failed row fails
-- the file).
ALTER TABLE "imports" ADD CONSTRAINT "imports_committed_check"
  CHECK (
    ("status" = 'committed') = ("committed_at" IS NOT NULL)
    AND ("committed_at" IS NULL) = ("committed_by" IS NULL)
    AND ("status" <> 'committed' OR "error_count" = 0)
  );

ALTER TABLE "imports" ADD CONSTRAINT "imports_failed_check"
  CHECK (
    ("status" = 'failed') = ("failed_at" IS NOT NULL)
    AND ("failed_at" IS NULL) = ("error" IS NULL)
  );

ALTER TABLE "imports" ADD CONSTRAINT "imports_error_check"
  CHECK ("error" IS NULL OR ("error" = btrim("error") AND "error" <> ''));

ALTER TABLE "imports" ADD CONSTRAINT "imports_error_no_id_check"
  CHECK ("error" !~ '[0-9]{13}' AND "error" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R341: a file is committed once per school and kind (IMPORT_DUPLICATE_FILE).
CREATE UNIQUE INDEX "imports_committed_hash_key" ON "imports" ("school_id", "kind", "file_hash")
  WHERE "status" = 'committed';

-- The 24-hour expiry (folded into the staged-upload sweep) and the preview-time duplicate check.
CREATE INDEX "imports_previewed_idx" ON "imports" ("school_id", "created_at")
  WHERE "status" = 'previewed';

CREATE TRIGGER "imports_status_transition" BEFORE UPDATE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition('previewed:committed', 'previewed:failed');

CREATE TRIGGER "imports_columns_immutable" BEFORE UPDATE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'kind', 'file_hash', 'file_name', 'row_count', 'rows', 'errors', 'error_count', 'academic_year_id',
    'section_id', 'class_id', 'term_id', 'due_on', 'created_by', 'created_at');

CREATE TRIGGER "imports_committed_frozen" BEFORE UPDATE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('committed_at', 'committed_by');

CREATE TRIGGER "imports_failed_frozen" BEFORE UPDATE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('failed_at', 'error');

-- R339: an import is born previewed (a preview writes nothing else).
CREATE FUNCTION asms_import_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'previewed' THEN
    RAISE EXCEPTION 'an import is born previewed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'imports_born_previewed',
            DETAIL = 'constraint: imports_born_previewed',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "imports_guard" BEFORE INSERT ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_import_guard();

CREATE TRIGGER "imports_no_delete" BEFORE DELETE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "imports_no_truncate" BEFORE TRUNCATE ON "imports"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "imports_school_id_immutable" BEFORE UPDATE ON "imports"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- result_sheets.import_id (rule 39, R340) ----------------------------------------------------------

-- §3.2: an imported sheet names its import, a manual one none. NOT VALID: it holds every insert
-- and update from now on but is not checked against rows already stored. No imported sheet can
-- exist in a deployed school (slice 43 is the first writer), but the groundwork's own tests wrote
-- imported sheets without an import into test databases, which cannot be corrected (provenance
-- is frozen) or removed (rule 4). The groundwork's result_sheets_imported_check stays.
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_import_id_check"
  CHECK (("provenance" = 'imported') = ("import_id" IS NOT NULL)) NOT VALID;

-- The frozen list gains import_id.
DROP TRIGGER "result_sheets_columns_immutable" ON "result_sheets";
CREATE TRIGGER "result_sheets_columns_immutable" BEFORE UPDATE ON "result_sheets"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'term_id', 'class_id', 'section_id', 'version', 'supersedes_id', 'created_by',
    'created_at', 'provenance', 'import_id');

-- R340: an imported sheet is made by a past-results import of the same section and term, while
-- that import is still previewed (the commit inserts the sheet, then stamps the import). The FK
-- already binds the year.
CREATE FUNCTION asms_result_sheet_import_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_kind import_kind;
  v_status import_status;
  v_section_id bigint;
  v_term_id bigint;
  v_refusal text;
BEGIN
  SELECT i.kind, i.status, i.section_id, i.term_id INTO v_kind, v_status, v_section_id, v_term_id
    FROM imports i
   WHERE i.school_id = NEW.school_id AND i.id = NEW.import_id
   FOR SHARE;
  IF v_kind IS DISTINCT FROM 'past_results' OR v_section_id IS DISTINCT FROM NEW.section_id
     OR v_term_id IS DISTINCT FROM NEW.term_id THEN
    v_refusal := 'result_sheets_import_match';
  ELSIF v_status <> 'previewed' THEN
    v_refusal := 'result_sheets_import_previewed';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'imported result sheet refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "result_sheets_import_guard" BEFORE INSERT ON "result_sheets"
  FOR EACH ROW WHEN (NEW.import_id IS NOT NULL)
  EXECUTE FUNCTION asms_result_sheet_import_guard();

-- ---- charges.import_id (rule 39, R342) -----------------------------------------------------------------

-- §0.34: an opening balance is a manual charge.
ALTER TABLE "charges" ADD CONSTRAINT "charges_import_check"
  CHECK ("import_id" IS NULL OR "kind" = 'manual');

-- §3.2: one charge per import and enrolment. Carries academic_year_id so it also indexes the
-- (school_id, import_id, academic_year_id) FK; partial, so the charges table gains no index
-- entry for an ordinary charge.
CREATE UNIQUE INDEX "charges_import_enrolment_key" ON "charges" ("school_id", "import_id", "academic_year_id", "enrolment_id")
  WHERE "import_id" IS NOT NULL;

-- The frozen list gains import_id.
DROP TRIGGER "charges_columns_immutable" ON "charges";
CREATE TRIGGER "charges_columns_immutable" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'enrolment_id', 'student_id', 'academic_year_id', 'fee_head_id', 'head_frequency', 'kind',
    'period', 'campaign_id', 'late_fee_for_charge_id', 'adjusts_charge_id', 'concession_id',
    'gross_amount', 'concession_amount', 'amount', 'description', 'due_on', 'created_by',
    'created_at', 'import_id');

-- R342: an imported charge is raised by an opening-balances import, due on the file's due date,
-- while the import is still previewed (the commit inserts the charges, then stamps the import);
-- and an opening balance is never late-fee'd.
CREATE FUNCTION asms_charge_import_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_kind import_kind;
  v_status import_status;
  v_due_on date;
  v_refusal text;
BEGIN
  IF NEW.import_id IS NOT NULL THEN
    SELECT i.kind, i.status, i.due_on INTO v_kind, v_status, v_due_on
      FROM imports i
     WHERE i.school_id = NEW.school_id AND i.id = NEW.import_id
     FOR SHARE;
    IF v_kind IS DISTINCT FROM 'opening_balances' OR v_due_on IS DISTINCT FROM NEW.due_on THEN
      v_refusal := 'charges_import_match';
    ELSIF v_status <> 'previewed' THEN
      v_refusal := 'charges_import_previewed';
    END IF;
  ELSIF NEW.late_fee_for_charge_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM charges c
           WHERE c.school_id = NEW.school_id AND c.id = NEW.late_fee_for_charge_id
             AND c.import_id IS NOT NULL
        ) THEN
    v_refusal := 'charges_late_fee_not_imported';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'charge refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "charges_import_guard" BEFORE INSERT ON "charges"
  FOR EACH ROW WHEN (NEW.import_id IS NOT NULL OR NEW.late_fee_for_charge_id IS NOT NULL)
  EXECUTE FUNCTION asms_charge_import_guard();

-- ---- platform_support_sessions (rule 40, §3.1 exception 7, R349, R352; non-tenant) -----------------

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_ticket_ref_check"
  CHECK ("ticket_ref" = btrim("ticket_ref") AND "ticket_ref" <> '');

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_ticket_ref_no_id_check"
  CHECK ("ticket_ref" !~ '[0-9]{13}' AND "ticket_ref" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_close_reason_check"
  CHECK ("close_reason" IS NULL OR ("close_reason" = btrim("close_reason") AND "close_reason" <> ''));

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_close_reason_no_id_check"
  CHECK ("close_reason" !~ '[0-9]{13}' AND "close_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_revoke_reason_check"
  CHECK ("revoke_reason" IS NULL OR ("revoke_reason" = btrim("revoke_reason") AND "revoke_reason" <> ''));

ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_revoke_reason_no_id_check"
  CHECK ("revoke_reason" !~ '[0-9]{13}' AND "revoke_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- §3.2: time-boxed, at most 24 hours (support_session_hours is 1-24; the service sets expires_at).
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_expires_check"
  CHECK ("opened_at" < "expires_at" AND "expires_at" <= "opened_at" + interval '24 hours');

-- Close, revoke and expiry all set closed_at with how it ended; a close reason only on a close;
-- an expiry at or after expires_at.
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_closed_check"
  CHECK (
    ("closed_at" IS NULL) = ("end_kind" IS NULL)
    AND ("closed_at" IS NULL OR "closed_at" >= "opened_at")
    AND ("close_reason" IS NULL OR "end_kind" = 'closed')
    AND ("end_kind" IS DISTINCT FROM 'expired' OR "closed_at" >= "expires_at")
  );

-- A revoke is a close by the school: the revoke group exactly when end_kind is revoked, at the
-- closing instant.
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_revoked_check"
  CHECK (
    ("end_kind" IS NOT DISTINCT FROM 'revoked') = ("revoked_at" IS NOT NULL)
    AND ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
    AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
    AND ("revoked_at" IS NULL OR "revoked_at" = "closed_at")
  );

-- R349: one open session per school (SUPPORT_SESSION_OPEN).
CREATE UNIQUE INDEX "platform_support_sessions_open_key" ON "platform_support_sessions" ("school_id")
  WHERE "closed_at" IS NULL;

-- The support-session-expire job (every 5 minutes): open sessions past expires_at.
CREATE INDEX "platform_support_sessions_expiry_idx" ON "platform_support_sessions" ("expires_at")
  WHERE "closed_at" IS NULL;

CREATE TRIGGER "platform_support_sessions_columns_immutable" BEFORE UPDATE ON "platform_support_sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'platform_user_id', 'school_id', 'reason', 'ticket_ref', 'opened_at', 'expires_at');

CREATE TRIGGER "platform_support_sessions_closed_frozen" BEFORE UPDATE ON "platform_support_sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('closed_at', 'end_kind', 'close_reason');

CREATE TRIGGER "platform_support_sessions_revoked_frozen" BEFORE UPDATE ON "platform_support_sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('revoked_at', 'revoked_by', 'revoke_reason');

-- A session is born open; at most three are open per platform user (R349, SUPPORT_SESSION_LIMIT;
-- the platform user's row is locked so two opens cannot both see two); the revoker is a user of
-- the session's school (revoked_by cannot be a foreign key: a non-tenant model relates to no
-- tenant model, prisma-relations.spec.ts).
CREATE FUNCTION asms_platform_support_session_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_open integer;
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.closed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      v_refusal := 'platform_support_sessions_born_open';
    ELSE
      PERFORM 1 FROM platform_users u WHERE u.id = NEW.platform_user_id FOR UPDATE;
      SELECT count(*) INTO v_open FROM platform_support_sessions s
       WHERE s.platform_user_id = NEW.platform_user_id AND s.closed_at IS NULL;
      IF v_open >= 3 THEN
        v_refusal := 'platform_support_sessions_user_limit';
      END IF;
    END IF;
  END IF;
  IF v_refusal IS NULL AND NEW.revoked_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)
     AND NOT EXISTS (
       SELECT 1 FROM users u WHERE u.school_id = NEW.school_id AND u.id = NEW.revoked_by
     ) THEN
    v_refusal := 'platform_support_sessions_revoked_by_school_user';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'support session refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "platform_support_sessions_guard" BEFORE INSERT OR UPDATE ON "platform_support_sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_platform_support_session_guard();

CREATE TRIGGER "platform_support_sessions_no_delete" BEFORE DELETE ON "platform_support_sessions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "platform_support_sessions_no_truncate" BEFORE TRUNCATE ON "platform_support_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();
