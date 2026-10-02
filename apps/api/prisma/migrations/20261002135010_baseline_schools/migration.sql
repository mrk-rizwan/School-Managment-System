-- CreateEnum
CREATE TYPE "school_status" AS ENUM ('trial', 'active', 'suspended', 'terminated');

-- CreateTable
CREATE TABLE "schools" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "short_code" VARCHAR(12) NOT NULL,
    "status" "school_status" NOT NULL DEFAULT 'trial',
    "school_group_id" BIGINT,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_short_code_key" ON "schools"("short_code");
