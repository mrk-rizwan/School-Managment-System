-- Phase 5 slice 37 (wave R): the period timetable (phase-5-extended.md rule 33, §1.1, §1.3 A1-A3,
-- §3.2 "Timetable", R301-R309): timetable_versions, timetable_slots, timetable_substitutions.
-- Generated DDL first (prisma migrate diff), hand-written SQL after the marker.

-- CreateTable
CREATE TABLE "timetable_versions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "version_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "period" SMALLINT NOT NULL,
    "class_subject_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "room" VARCHAR(40),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_substitutions" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "period" SMALLINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" BIGINT,
    "void_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_substitutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timetable_versions_school_id_section_id_idx" ON "timetable_versions"("school_id", "section_id", "class_id", "effective_from");

-- CreateIndex
CREATE INDEX "timetable_versions_school_id_class_id_idx" ON "timetable_versions"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "timetable_versions_school_id_created_by_idx" ON "timetable_versions"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "timetable_versions_school_id_voided_by_idx" ON "timetable_versions"("school_id", "voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_versions_school_id_id_key" ON "timetable_versions"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_versions_school_id_id_class_id_key" ON "timetable_versions"("school_id", "id", "class_id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_version_id_class_id_idx" ON "timetable_slots"("school_id", "version_id", "class_id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_class_subject_id_idx" ON "timetable_slots"("school_id", "class_subject_id", "class_id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_staff_id_idx" ON "timetable_slots"("school_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_school_id_id_key" ON "timetable_slots"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_version_weekday_period_key" ON "timetable_slots"("school_id", "version_id", "weekday", "period");

-- CreateIndex
CREATE INDEX "timetable_substitutions_school_id_section_id_idx" ON "timetable_substitutions"("school_id", "section_id", "class_id", "date");

-- CreateIndex
CREATE INDEX "timetable_substitutions_school_id_staff_id_date_idx" ON "timetable_substitutions"("school_id", "staff_id", "date");

-- CreateIndex
CREATE INDEX "timetable_substitutions_school_id_created_by_idx" ON "timetable_substitutions"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "timetable_substitutions_school_id_voided_by_idx" ON "timetable_substitutions"("school_id", "voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_substitutions_school_id_id_key" ON "timetable_substitutions"("school_id", "id");

-- AddForeignKey
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_version_id_fkey" FOREIGN KEY ("school_id", "version_id", "class_id") REFERENCES "timetable_versions"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_class_subject_id_fkey" FOREIGN KEY ("school_id", "class_subject_id", "class_id") REFERENCES "class_subjects"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_voided_by_fkey" FOREIGN KEY ("school_id", "voided_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;




-- =============================================================================================
-- Hand-written below this line (phase-5-extended.md §3.2 "Timetable", R301-R306;
-- contracts/slice-37.md §6). Generated SQL above (prisma migrate diff) reviewed: no drift lines.
-- Every object here is listed in test/guardrails/schema-checks.ts (SLICE_37_OBJECTS). Trigger
-- functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>'; the exclusion constraints raise
-- 23P01 with the name in the message (prisma-errors.ts reads both).
-- =============================================================================================

-- ---- timetable_versions (R301) -----------------------------------------------------------------

ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_dates_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_voided_check"
  CHECK (
    ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_void_reason_check"
  CHECK ("void_reason" IS NULL OR ("void_reason" = btrim("void_reason") AND "void_reason" <> ''));

ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- Rule 33: one section's live versions never share a day (inclusive ranges, btree_gist since
-- slice 4). A voided version leaves the constraint. The version live on a day is the one whose
-- range holds it (R301, R309).
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_live_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "section_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("voided_at" IS NULL);

-- R301: effective_from inside the class's academic year; a voided version's range is frozen (its
-- slots stay as they were when it was voided).
CREATE FUNCTION asms_timetable_version_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM academic_years y
       WHERE y.school_id = NEW.school_id AND y.id = NEW.academic_year_id
         AND NEW.effective_from BETWEEN y.starts_on AND y.ends_on
    ) THEN
      v_refusal := 'timetable_versions_in_year';
    ELSIF NEW.voided_at IS NOT NULL THEN
      v_refusal := 'timetable_versions_born_live';
    END IF;
  ELSIF OLD.voided_at IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    v_refusal := 'timetable_versions_voided_frozen';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'timetable version refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "timetable_versions_guard" BEFORE INSERT OR UPDATE ON "timetable_versions"
  FOR EACH ROW EXECUTE FUNCTION asms_timetable_version_guard();

-- Rule 33: a version is never edited; only effective_to (closed by a successor, restored when the
-- successor is voided) and the void trio change.
CREATE TRIGGER "timetable_versions_columns_immutable" BEFORE UPDATE ON "timetable_versions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'section_id', 'class_id', 'academic_year_id', 'effective_from', 'created_by', 'created_at');

CREATE TRIGGER "timetable_versions_voided_frozen" BEFORE UPDATE ON "timetable_versions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

-- §3.2: the slots carry their version's range and void, so the clash constraints below see "live
-- on a day" without a join. After a version's effective_to or voided_at changes, its slots are
-- touched and timetable_slots_guard copies the version's values onto them. A supersede updates
-- the predecessor first (its slots shrink), then inserts the version and its slots; a void sets
-- voided_at on the successor first (its slots leave the constraints), then restores the
-- predecessor (its slots grow back, and a clash taken meanwhile raises timetable_slots_*_excl).
CREATE FUNCTION asms_timetable_version_sync_slots() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE timetable_slots s SET updated_at = CURRENT_TIMESTAMP
   WHERE s.school_id = NEW.school_id AND s.version_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "timetable_versions_sync_slots" AFTER UPDATE OF "effective_to", "voided_at" ON "timetable_versions"
  FOR EACH ROW
  WHEN (OLD.effective_to IS DISTINCT FROM NEW.effective_to OR OLD.voided_at IS DISTINCT FROM NEW.voided_at)
  EXECUTE FUNCTION asms_timetable_version_sync_slots();

CREATE TRIGGER "timetable_versions_no_delete" BEFORE DELETE ON "timetable_versions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_versions_no_truncate" BEFORE TRUNCATE ON "timetable_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_versions_school_id_immutable" BEFORE UPDATE ON "timetable_versions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- timetable_slots (R302) --------------------------------------------------------------------

-- §1.1: weekdays 0-6 like weekly_off_days; periods 1-12 (the school's periods_per_day, below).
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_weekday_check"
  CHECK ("weekday" BETWEEN 0 AND 6);

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_period_check"
  CHECK ("period" BETWEEN 1 AND 12);

-- §1.1: a free-text room, trimmed, at most 40 (the column's length).
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_room_check"
  CHECK ("room" IS NULL OR ("room" = btrim("room") AND "room" <> ''));

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_room_no_id_check"
  CHECK ("room" !~ '[0-9]{13}' AND "room" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_dates_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- R302: a teacher is in one place per weekday-period on any day two live ranges share.
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_teacher_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    "staff_id" WITH =,
    "weekday" WITH =,
    "period" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("voided_at" IS NULL);

-- R302: a room is booked once per weekday-period, compared lower-cased and trimmed (§1.1).
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_room_excl"
  EXCLUDE USING gist (
    "school_id" WITH =,
    (lower(btrim("room"))) WITH =,
    "weekday" WITH =,
    "period" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("voided_at" IS NULL AND "room" IS NOT NULL);

-- R304's check and the teacher's week: a teacher's live slots by weekday and period.
CREATE INDEX "timetable_slots_live_staff_idx" ON "timetable_slots" ("school_id", "staff_id", "weekday", "period")
  WHERE "voided_at" IS NULL;

-- §3.2: the range and void are the version's, on insert and on every update (a direct write of
-- either is overwritten, so a slot can never disagree with its version). On insert (R302): the
-- version is live, the period is within the school's periods_per_day and the weekday is not a
-- weekly-off day.
CREATE FUNCTION asms_timetable_slot_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_from date;
  v_to date;
  v_voided timestamptz;
  v_periods smallint;
  v_off smallint[];
  v_refusal text;
BEGIN
  SELECT v.effective_from, v.effective_to, v.voided_at INTO v_from, v_to, v_voided
    FROM timetable_versions v WHERE v.school_id = NEW.school_id AND v.id = NEW.version_id;
  NEW.effective_from := v_from;
  NEW.effective_to := v_to;
  NEW.voided_at := v_voided;
  IF TG_OP = 'INSERT' THEN
    SELECT st.periods_per_day, st.weekly_off_days INTO v_periods, v_off
      FROM school_settings st WHERE st.school_id = NEW.school_id;
    IF v_voided IS NOT NULL THEN
      v_refusal := 'timetable_slots_version_voided';
    ELSIF NEW.period > coalesce(v_periods, 8) THEN
      v_refusal := 'timetable_slots_period_in_day';
    ELSIF NEW.weekday = ANY (coalesce(v_off, ARRAY[0]::smallint[])) THEN
      v_refusal := 'timetable_slots_off_day';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'timetable slot refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "timetable_slots_guard" BEFORE INSERT OR UPDATE ON "timetable_slots"
  FOR EACH ROW EXECUTE FUNCTION asms_timetable_slot_guard();

-- Rule 33: a slot is never edited; a change is a new version.
CREATE TRIGGER "timetable_slots_columns_immutable" BEFORE UPDATE ON "timetable_slots"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'version_id', 'class_id', 'weekday', 'period', 'class_subject_id', 'staff_id', 'room', 'created_at');

CREATE TRIGGER "timetable_slots_no_delete" BEFORE DELETE ON "timetable_slots"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_slots_no_truncate" BEFORE TRUNCATE ON "timetable_slots"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_slots_school_id_immutable" BEFORE UPDATE ON "timetable_slots"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- school_settings: periods_per_day below a live slot (R302) ---------------------------------

-- §3.2: lowering periods_per_day below a period a live or future slot uses is refused (the
-- settings PATCH answers 422 on periodsPerDay). "Live" is a range not ended before the school's
-- today.
CREATE FUNCTION asms_school_settings_periods_timetabled() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_today date;
BEGIN
  IF NEW.periods_per_day < OLD.periods_per_day THEN
    SELECT (now() AT TIME ZONE s.timezone)::date INTO v_today FROM schools s WHERE s.id = NEW.school_id;
    IF EXISTS (
      SELECT 1 FROM timetable_slots t
       WHERE t.school_id = NEW.school_id AND t.voided_at IS NULL
         AND t.period > NEW.periods_per_day
         AND (t.effective_to IS NULL OR t.effective_to >= v_today)
    ) THEN
      RAISE EXCEPTION 'a live timetable uses a period beyond %', NEW.periods_per_day
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'school_settings_periods_per_day_timetabled',
              DETAIL = 'constraint: school_settings_periods_per_day_timetabled',
              SCHEMA = TG_TABLE_SCHEMA,
              TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "school_settings_periods_timetabled" BEFORE UPDATE OF "periods_per_day" ON "school_settings"
  FOR EACH ROW EXECUTE FUNCTION asms_school_settings_periods_timetabled();

-- ---- timetable_substitutions (R306) ------------------------------------------------------------

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_period_check"
  CHECK ("period" BETWEEN 1 AND 12);

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_reason_check"
  CHECK ("reason" = btrim("reason") AND "reason" <> '');

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_reason_no_id_check"
  CHECK ("reason" !~ '[0-9]{13}' AND "reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_voided_check"
  CHECK (
    ("voided_at" IS NULL) = ("voided_by" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
  );

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_void_reason_check"
  CHECK ("void_reason" IS NULL OR ("void_reason" = btrim("void_reason") AND "void_reason" <> ''));

ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_void_reason_no_id_check"
  CHECK ("void_reason" !~ '[0-9]{13}' AND "void_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R306: one live substitution per section-date-period, and a substitute in one place per period.
CREATE UNIQUE INDEX "timetable_substitutions_live_key" ON "timetable_substitutions" ("school_id", "section_id", "date", "period")
  WHERE "voided_at" IS NULL;

CREATE UNIQUE INDEX "timetable_substitutions_staff_live_key" ON "timetable_substitutions" ("school_id", "staff_id", "date", "period")
  WHERE "voided_at" IS NULL;

CREATE TRIGGER "timetable_substitutions_columns_immutable" BEFORE UPDATE ON "timetable_substitutions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'section_id', 'class_id', 'date', 'period', 'staff_id', 'reason', 'created_by', 'created_at');

CREATE TRIGGER "timetable_substitutions_voided_frozen" BEFORE UPDATE ON "timetable_substitutions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason');

CREATE TRIGGER "timetable_substitutions_no_delete" BEFORE DELETE ON "timetable_substitutions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_substitutions_no_truncate" BEFORE TRUNCATE ON "timetable_substitutions"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "timetable_substitutions_school_id_immutable" BEFORE UPDATE ON "timetable_substitutions"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
