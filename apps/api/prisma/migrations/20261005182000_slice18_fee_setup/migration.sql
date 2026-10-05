-- Slice 18: fee heads, fee structures and school payment accounts (phase-3-financial.md §4
-- "Fee setup", R176-R177), the finance seeds of a school and their backfill.

-- CreateEnum
CREATE TYPE "fee_head_category" AS ENUM ('tuition', 'admission', 'annual', 'exam', 'fine', 'other');

-- CreateEnum
CREATE TYPE "fee_frequency" AS ENUM ('monthly', 'once', 'yearly', 'per_term', 'ad_hoc');

-- CreateEnum
CREATE TYPE "fee_head_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "fee_structure_status" AS ENUM ('active', 'superseded');

-- CreateEnum
CREATE TYPE "payment_account_kind" AS ENUM ('bank', 'jazzcash', 'easypaisa');

-- CreateEnum
CREATE TYPE "payment_account_status" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "fee_heads" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "category" "fee_head_category" NOT NULL,
    "frequency" "fee_frequency" NOT NULL,
    "concession_eligible" BOOLEAN NOT NULL,
    "refundable" BOOLEAN NOT NULL,
    "status" "fee_head_status" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" BIGINT,
    "archive_reason" VARCHAR(500),
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structures" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "fee_head_id" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "effective_from" CHAR(7) NOT NULL,
    "status" "fee_structure_status" NOT NULL DEFAULT 'active',
    "superseded_by" BIGINT,
    "superseded_at" TIMESTAMPTZ(3),
    "reason" VARCHAR(500),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_payment_accounts" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "kind" "payment_account_kind" NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "account_no" VARCHAR(34) NOT NULL,
    "bank_name" VARCHAR(100),
    "status" "payment_account_status" NOT NULL DEFAULT 'active',
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_by" BIGINT,
    "disable_reason" VARCHAR(500),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_heads_school_id_status_name_idx" ON "fee_heads"("school_id", "status", "name");

-- CreateIndex
CREATE INDEX "fee_heads_school_id_created_by_idx" ON "fee_heads"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "fee_heads_school_id_archived_by_idx" ON "fee_heads"("school_id", "archived_by");

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_school_id_id_key" ON "fee_heads"("school_id", "id");

-- CreateIndex
CREATE INDEX "fee_structures_school_id_academic_year_id_class_id_idx" ON "fee_structures"("school_id", "academic_year_id", "class_id");

-- CreateIndex
CREATE INDEX "fee_structures_school_id_fee_head_id_idx" ON "fee_structures"("school_id", "fee_head_id");

-- CreateIndex
CREATE INDEX "fee_structures_school_id_superseded_by_idx" ON "fee_structures"("school_id", "superseded_by");

-- CreateIndex
CREATE INDEX "fee_structures_school_id_created_by_idx" ON "fee_structures"("school_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structures_school_id_id_key" ON "fee_structures"("school_id", "id");

-- CreateIndex
CREATE INDEX "school_payment_accounts_school_id_status_created_at_idx" ON "school_payment_accounts"("school_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "school_payment_accounts_school_id_created_by_idx" ON "school_payment_accounts"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "school_payment_accounts_school_id_disabled_by_idx" ON "school_payment_accounts"("school_id", "disabled_by");

-- CreateIndex
CREATE UNIQUE INDEX "school_payment_accounts_school_id_id_key" ON "school_payment_accounts"("school_id", "id");

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_archived_by_fkey" FOREIGN KEY ("school_id", "archived_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_fee_head_id_fkey" FOREIGN KEY ("school_id", "fee_head_id") REFERENCES "fee_heads"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_superseded_by_fkey" FOREIGN KEY ("school_id", "superseded_by") REFERENCES "fee_structures"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_disabled_by_fkey" FOREIGN KEY ("school_id", "disabled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- =============================================================================================
-- Hand-written below this line (phase-3-financial.md §3.2, §4 "Fee setup"). Generated SQL above
-- reviewed: no drift lines. Every object here is listed in test/guardrails/schema-checks.ts
-- (SLICE_18_OBJECTS). Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'.
-- =============================================================================================

-- ---- fee_heads (R176) --------------------------------------------------------------------------

ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_name_no_id_check"
  CHECK ("name" !~ '[0-9]{13}' AND "name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_archive_reason_no_id_check"
  CHECK ("archive_reason" !~ '[0-9]{13}' AND "archive_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Rule 19 and the assumption "fines are not concession-eligible": a fine head never is.
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_fine_concession_check"
  CHECK ("category" <> 'fine' OR NOT "concession_eligible");

-- Rule 20: the admission fee is never refunded.
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_admission_refundable_check"
  CHECK ("category" <> 'admission' OR NOT "refundable");

-- Archived iff the three archive columns are set, together.
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_archived_check"
  CHECK (
    ("status" = 'archived') = ("archived_at" IS NOT NULL)
    AND ("archived_at" IS NULL) = ("archived_by" IS NULL)
    AND ("archived_at" IS NULL) = ("archive_reason" IS NULL)
  );

-- Live names are unique per school, case-insensitively; an archived head frees its name.
CREATE UNIQUE INDEX "fee_heads_live_name_key" ON "fee_heads" ("school_id", lower("name"))
  WHERE "status" <> 'archived';

-- At most one live tuition head and one live fine head: generation and late fees name them.
CREATE UNIQUE INDEX "fee_heads_one_tuition_key" ON "fee_heads" ("school_id")
  WHERE "category" = 'tuition' AND "status" <> 'archived';

CREATE UNIQUE INDEX "fee_heads_one_fine_key" ON "fee_heads" ("school_id")
  WHERE "category" = 'fine' AND "status" <> 'archived';

-- Category and frequency are what a charge snapshots: a different kind of fee is a new head.
CREATE TRIGGER "fee_heads_columns_immutable" BEFORE UPDATE ON "fee_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('category', 'frequency', 'created_by', 'created_at');

-- Archive is final and freezes the head.
CREATE TRIGGER "fee_heads_archived_frozen" BEFORE UPDATE ON "fee_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'archived_at', 'archived_by', 'archive_reason', 'status', 'name', 'concession_eligible', 'refundable');

CREATE TRIGGER "fee_heads_no_delete" BEFORE DELETE ON "fee_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "fee_heads_no_truncate" BEFORE TRUNCATE ON "fee_heads"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "fee_heads_school_id_immutable" BEFORE UPDATE ON "fee_heads"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- fee_structures (R177) ---------------------------------------------------------------------

ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_amount_check"
  CHECK ("amount" >= 0);

ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_effective_from_check"
  CHECK ("effective_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_reason_check"
  CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND "reason" <> ''));

ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Superseded iff stamped. superseded_by is written after the replacement exists (the replacement
-- cannot be inserted while this row is still active), so it may trail the stamp inside the
-- transaction; it is never set on an active row and never names the row itself.
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_superseded_check"
  CHECK (
    ("status" = 'superseded') = ("superseded_at" IS NOT NULL)
    AND ("superseded_by" IS NULL OR "status" = 'superseded')
    AND ("superseded_by" IS NULL OR "superseded_by" <> "id")
  );

-- One active row per class, head and effective month (R177).
CREATE UNIQUE INDEX "fee_structures_active_key"
  ON "fee_structures" ("school_id", "class_id", "fee_head_id", "effective_from")
  WHERE "status" = 'active';

-- Rule 0.19: amounts, parties and dates are frozen after insert; only the supersede columns move.
CREATE TRIGGER "fee_structures_columns_immutable" BEFORE UPDATE ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'academic_year_id', 'class_id', 'fee_head_id', 'amount', 'effective_from', 'reason',
    'created_by', 'created_at');

CREATE TRIGGER "fee_structures_superseded_frozen" BEFORE UPDATE ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at', 'status');

CREATE TRIGGER "fee_structures_superseded_by_frozen" BEFORE UPDATE ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_by');

CREATE TRIGGER "fee_structures_no_delete" BEFORE DELETE ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "fee_structures_no_truncate" BEFORE TRUNCATE ON "fee_structures"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "fee_structures_school_id_immutable" BEFORE UPDATE ON "fee_structures"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- school_payment_accounts (rule 21) ---------------------------------------------------------

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_title_check"
  CHECK ("title" = btrim("title") AND "title" <> '');

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_title_no_id_check"
  CHECK ("title" !~ '[0-9]{13}' AND "title" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- An account number is letters, digits and dashes (an IBAN, a bank account, a wallet number), and
-- never shaped like an identity number: 13 digits, plain or dashed 5-7-1.
ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_account_no_check"
  CHECK (
    "account_no" ~ '^[0-9A-Za-z-]{4,34}$'
    AND "account_no" !~ '^[0-9]{13}$'
    AND "account_no" !~ '^[0-9]{5}-[0-9]{7}-[0-9]$'
  );

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_bank_name_check"
  CHECK (
    ("bank_name" IS NULL OR ("bank_name" = btrim("bank_name") AND "bank_name" <> ''))
    AND ("kind" = 'bank' OR "bank_name" IS NULL)
  );

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_bank_name_no_id_check"
  CHECK ("bank_name" !~ '[0-9]{13}' AND "bank_name" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_disable_reason_no_id_check"
  CHECK ("disable_reason" !~ '[0-9]{13}' AND "disable_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "school_payment_accounts" ADD CONSTRAINT "school_payment_accounts_disabled_check"
  CHECK (
    ("status" = 'disabled') = ("disabled_at" IS NOT NULL)
    AND ("disabled_at" IS NULL) = ("disabled_by" IS NULL)
    AND ("disabled_at" IS NULL) = ("disable_reason" IS NULL)
  );

-- A payee never changes in place (a change is a new row); disabling is final.
CREATE TRIGGER "school_payment_accounts_columns_immutable" BEFORE UPDATE ON "school_payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'kind', 'title', 'account_no', 'bank_name', 'created_by', 'created_at');

CREATE TRIGGER "school_payment_accounts_disabled_frozen" BEFORE UPDATE ON "school_payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set(
    'disabled_at', 'disabled_by', 'disable_reason', 'status');

CREATE TRIGGER "school_payment_accounts_no_delete" BEFORE DELETE ON "school_payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "school_payment_accounts_no_truncate" BEFORE TRUNCATE ON "school_payment_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "school_payment_accounts_school_id_immutable" BEFORE UPDATE ON "school_payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- the school's finance seeds (R176, §3.5) ---------------------------------------------------

-- The five fee heads (created_by null) and the expense_no counter of one school. Called by the
-- school-creation transaction (FeeHeadRepository.seedForSchool) and by the backfill below, so the
-- seed rows have one definition; packages/shared SEEDED_FEE_HEADS mirrors them and
-- test/fees/seeds.e2e-spec.ts compares the two. Idempotent: a school holding any seeded head is
-- not seeded again, and the counter is ON CONFLICT DO NOTHING. Slice 24 adds the leave types.
CREATE FUNCTION asms_seed_school_finance(p_school_id bigint) RETURNS void
LANGUAGE sql AS $$
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

  INSERT INTO "school_counters" ("school_id", "name", "value")
  VALUES (p_school_id, 'expense_no', 0)
  ON CONFLICT ("school_id", "name") DO NOTHING;
$$;

-- Backfill: every existing school gets its seeds, and every existing academic year its receipt
-- counter (academic-year creation writes it from now on, §3.5).
SELECT asms_seed_school_finance("id") FROM "schools" ORDER BY "id";

INSERT INTO "school_counters" ("school_id", "name", "value")
SELECT "school_id", 'receipt_' || "id", 0 FROM "academic_years" ORDER BY "id"
ON CONFLICT ("school_id", "name") DO NOTHING;
