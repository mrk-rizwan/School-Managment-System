-- CreateEnum
CREATE TYPE "contact_capability" AS ENUM ('whatsapp', 'smartphone_data', 'keypad');

-- CreateEnum
CREATE TYPE "guardian_status" AS ENUM ('active', 'merged');

-- CreateTable
CREATE TABLE "guardians" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "cnic" VARCHAR(255),
    "cnic_hash" CHAR(64),
    "phone" VARCHAR(16),
    "email" VARCHAR(254),
    "contact_capability" "contact_capability" NOT NULL,
    "address" VARCHAR(500),
    "merged_into_id" BIGINT,
    "status" "guardian_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guardians_school_id_phone_idx" ON "guardians"("school_id", "phone");

-- CreateIndex
CREATE INDEX "guardians_school_id_merged_into_id_idx" ON "guardians"("school_id", "merged_into_id");

-- CreateIndex
CREATE UNIQUE INDEX "guardians_school_id_id_key" ON "guardians"("school_id", "id");

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_merged_into_id_fkey" FOREIGN KEY ("school_id", "merged_into_id") REFERENCES "guardians"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line (CHECKs, the partial unique index, the trigger). Generated SQL
-- above reviewed: no drift lines.
-- =============================================================================================

-- Rule 12: at admission the office searches by CNIC and links, never duplicates. A live CNIC is
-- unique per school; the same digits in another school are another tenant's guardian. A merged
-- row keeps its hash, so a merge never frees a CNIC for a second record.
CREATE UNIQUE INDEX "guardians_school_id_cnic_hash_key" ON "guardians" ("school_id", "cnic_hash")
  WHERE "cnic_hash" IS NOT NULL;

-- Field-encryption envelope only: a plaintext CNIC cannot reach the column.
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_cnic_check"
  CHECK ("cnic" IS NULL OR "cnic" LIKE 'v1:%');

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_cnic_hash_check"
  CHECK ("cnic_hash" IS NULL OR "cnic_hash" ~ '^[0-9a-f]{64}$');

-- A ciphertext without its lookup hash could never be found by lookup; a hash without the
-- ciphertext could never be displayed or re-hashed on key rotation.
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_cnic_pair_check"
  CHECK (("cnic" IS NULL) = ("cnic_hash" IS NULL));

-- §3.8: E.164, normalised by normalisePhone() before writing.
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_phone_check"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_email_normalised_check"
  CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND position('@' IN "email") > 1));

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_full_name_check"
  CHECK ("full_name" = btrim("full_name") AND "full_name" <> '');

-- Merged exactly when it points at a survivor.
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_merged_check"
  CHECK (("status" = 'merged') = ("merged_into_id" IS NOT NULL));

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_merged_into_self_check"
  CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

CREATE TRIGGER "guardians_school_id_immutable" BEFORE UPDATE ON "guardians"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
