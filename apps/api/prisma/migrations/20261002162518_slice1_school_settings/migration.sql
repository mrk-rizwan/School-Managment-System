-- CreateTable
CREATE TABLE "school_settings" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "fee_due_day" SMALLINT NOT NULL DEFAULT 10,
    "student_login_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_settings_school_id_key" ON "school_settings"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "school_settings_school_id_id_key" ON "school_settings"("school_id", "id");

-- Hand-written (Prisma cannot express these, or must not: a tenant model declares no relation to
-- School, see the schema.prisma header).

-- AddForeignKey: the tenant anchor. RESTRICT both ways: a school is never deleted (rule 4).
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Every month has a 28th; a due day of 29-31 would silently skip February.
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_fee_due_day_check"
  CHECK ("fee_due_day" BETWEEN 1 AND 28);

CREATE TRIGGER "school_settings_school_id_immutable" BEFORE UPDATE ON "school_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
