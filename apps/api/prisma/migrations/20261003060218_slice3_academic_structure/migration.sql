-- CreateEnum
CREATE TYPE "academic_year_status" AS ENUM ('planned', 'active', 'closed');

-- CreateEnum
CREATE TYPE "class_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "attendance_mode" AS ENUM ('daily', 'period');

-- CreateTable
CREATE TABLE "academic_years" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "academic_year_status" NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "attendance_mode" "attendance_mode" NOT NULL DEFAULT 'daily',
    "status" "class_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "capacity" SMALLINT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_school_id_id_key" ON "academic_years"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_school_id_name_key" ON "academic_years"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "classes_school_id_id_key" ON "classes"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "classes_school_id_id_academic_year_id_key" ON "classes"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "classes_school_id_academic_year_id_name_key" ON "classes"("school_id", "academic_year_id", "name");

-- CreateIndex
CREATE INDEX "sections_school_id_class_id_idx" ON "sections"("school_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_school_id_id_key" ON "sections"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_school_id_id_class_id_key" ON "sections"("school_id", "id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_school_id_id_key" ON "subjects"("school_id", "id");

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_id_fkey" FOREIGN KEY ("school_id", "class_id") REFERENCES "classes"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================================
-- Hand-written below this line: CHECKs, partial unique indexes and triggers, which Prisma cannot
-- express (partial indexes stay out of schema.prisma: the partialIndexes preview is off).
-- Generated SQL above reviewed: no DROP CONSTRAINT drift lines (the @ignore School relations).
-- =============================================================================================

-- ---- academic_years -------------------------------------------------------------------------

ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_dates_check"
  CHECK ("ends_on" > "starts_on");

-- Stored trimmed and non-empty, so "2026-27 " cannot sit beside "2026-27" under the unique key.
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

CREATE TRIGGER "academic_years_school_id_immutable" BEFORE UPDATE ON "academic_years"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- classes --------------------------------------------------------------------------------

ALTER TABLE "classes" ADD CONSTRAINT "classes_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "classes" ADD CONSTRAINT "classes_sort_order_check"
  CHECK ("sort_order" >= 0);

CREATE TRIGGER "classes_school_id_immutable" BEFORE UPDATE ON "classes"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- sections (config table: soft delete, every unique carries WHERE deleted_at IS NULL) ----

-- One live section of a name per class; an archived "A" does not block a new "A".
CREATE UNIQUE INDEX "sections_school_id_class_id_name_key" ON "sections" ("school_id", "class_id", "name")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "sections" ADD CONSTRAINT "sections_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "sections" ADD CONSTRAINT "sections_capacity_check"
  CHECK ("capacity" IS NULL OR "capacity" >= 1);

CREATE TRIGGER "sections_school_id_immutable" BEFORE UPDATE ON "sections"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- subjects (config table: soft delete) ---------------------------------------------------

CREATE UNIQUE INDEX "subjects_school_id_name_key" ON "subjects" ("school_id", "name")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "subjects_school_id_code_key" ON "subjects" ("school_id", "code")
  WHERE "code" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_name_check"
  CHECK ("name" = btrim("name") AND "name" <> '');

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_code_check"
  CHECK ("code" IS NULL OR ("code" = btrim("code") AND "code" <> ''));

CREATE TRIGGER "subjects_school_id_immutable" BEFORE UPDATE ON "subjects"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
