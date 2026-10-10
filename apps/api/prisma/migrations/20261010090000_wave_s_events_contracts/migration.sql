-- Phase 5 wave S (phase-5-extended.md rules 34-36, §1.1, §3.2 "Events", "Contracts", "Documents",
-- R310-R325): the tables of slices 38 (events and PTM) and 39 (staff contracts), expenses.event_id
-- (deferred from the groundwork) and the slice 40 admission-date index. The three slices write no
-- migration of their own. Generated DDL first (prisma migrate diff, reviewed: no drift lines),
-- hand-written SQL after the marker.

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "event_id" BIGINT;

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "type" "event_type" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "venue" VARCHAR(120) NOT NULL,
    "details" VARCHAR(1000),
    "charge_amount" INTEGER,
    "charge_due_on" DATE,
    "status" "event_status" NOT NULL DEFAULT 'draft',
    "campaign_id" BIGINT,
    "announcement_id" BIGINT,
    "cancel_announcement_id" BIGINT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" BIGINT,
    "cancel_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_sections" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "event_id" BIGINT NOT NULL,
    "section_id" BIGINT NOT NULL,
    "class_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_duties" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "event_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "duty" "duty_kind" NOT NULL,
    "note" VARCHAR(200),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "end_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_duties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_participation" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "event_id" BIGINT NOT NULL,
    "academic_year_id" BIGINT NOT NULL,
    "student_id" BIGINT NOT NULL,
    "enrolment_id" BIGINT NOT NULL,
    "status" "participation_status" NOT NULL,
    "recorded_by" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_participation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_contracts" (
    "id" BIGSERIAL NOT NULL,
    "school_id" BIGINT NOT NULL,
    "staff_id" BIGINT NOT NULL,
    "type" "contract_type" NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "salary_structure_id" BIGINT,
    "document_object_key" VARCHAR(64),
    "document_mime" VARCHAR(32),
    "document_size_bytes" INTEGER,
    "note" VARCHAR(500),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" BIGINT,
    "end_reason" VARCHAR(500),
    "ended_on" DATE,
    "warned_30_at" TIMESTAMPTZ(3),
    "warned_7_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_school_id_academic_year_id_starts_at_idx" ON "events"("school_id", "academic_year_id", "starts_at");

-- CreateIndex
CREATE INDEX "events_school_id_status_starts_at_idx" ON "events"("school_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "events_school_id_created_by_idx" ON "events"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "events_school_id_cancelled_by_idx" ON "events"("school_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "events_school_id_id_key" ON "events"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "events_school_id_id_academic_year_id_key" ON "events"("school_id", "id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_school_id_campaign_id_key" ON "events"("school_id", "campaign_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_school_id_announcement_id_key" ON "events"("school_id", "announcement_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_school_id_cancel_announcement_id_key" ON "events"("school_id", "cancel_announcement_id");

-- CreateIndex
CREATE INDEX "event_sections_school_id_event_id_idx" ON "event_sections"("school_id", "event_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "event_sections_school_id_section_id_idx" ON "event_sections"("school_id", "section_id", "class_id");

-- CreateIndex
CREATE INDEX "event_sections_school_id_class_id_idx" ON "event_sections"("school_id", "class_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_sections_school_id_id_key" ON "event_sections"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "event_sections_event_section_key" ON "event_sections"("school_id", "event_id", "section_id");

-- CreateIndex
CREATE INDEX "event_duties_school_id_event_id_idx" ON "event_duties"("school_id", "event_id");

-- CreateIndex
CREATE INDEX "event_duties_school_id_staff_id_idx" ON "event_duties"("school_id", "staff_id", "event_id");

-- CreateIndex
CREATE INDEX "event_duties_school_id_created_by_idx" ON "event_duties"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "event_duties_school_id_ended_by_idx" ON "event_duties"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "event_duties_school_id_id_key" ON "event_duties"("school_id", "id");

-- CreateIndex
CREATE INDEX "event_participation_school_id_event_id_idx" ON "event_participation"("school_id", "event_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "event_participation_school_id_enrolment_id_idx" ON "event_participation"("school_id", "enrolment_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "event_participation_school_id_recorded_by_idx" ON "event_participation"("school_id", "recorded_by");

-- CreateIndex
CREATE UNIQUE INDEX "event_participation_school_id_id_key" ON "event_participation"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "event_participation_event_student_key" ON "event_participation"("school_id", "event_id", "student_id");

-- CreateIndex
CREATE INDEX "staff_contracts_school_id_staff_id_idx" ON "staff_contracts"("school_id", "staff_id", "starts_on");

-- CreateIndex
CREATE INDEX "staff_contracts_school_id_salary_structure_id_idx" ON "staff_contracts"("school_id", "salary_structure_id", "staff_id");

-- CreateIndex
CREATE INDEX "staff_contracts_school_id_created_by_idx" ON "staff_contracts"("school_id", "created_by");

-- CreateIndex
CREATE INDEX "staff_contracts_school_id_ended_by_idx" ON "staff_contracts"("school_id", "ended_by");

-- CreateIndex
CREATE UNIQUE INDEX "staff_contracts_school_id_id_key" ON "staff_contracts"("school_id", "id");

-- CreateIndex
CREATE INDEX "students_school_id_admitted_on_idx" ON "students"("school_id", "admitted_on");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_event_id_fkey" FOREIGN KEY ("school_id", "event_id") REFERENCES "events"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_academic_year_id_fkey" FOREIGN KEY ("school_id", "academic_year_id") REFERENCES "academic_years"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_campaign_id_fkey" FOREIGN KEY ("school_id", "campaign_id", "academic_year_id") REFERENCES "charge_campaigns"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_announcement_id_fkey" FOREIGN KEY ("school_id", "announcement_id") REFERENCES "announcements"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_cancel_announcement_id_fkey" FOREIGN KEY ("school_id", "cancel_announcement_id") REFERENCES "announcements"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_cancelled_by_fkey" FOREIGN KEY ("school_id", "cancelled_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_sections" ADD CONSTRAINT "event_sections_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_sections" ADD CONSTRAINT "event_sections_event_id_fkey" FOREIGN KEY ("school_id", "event_id", "academic_year_id") REFERENCES "events"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_sections" ADD CONSTRAINT "event_sections_section_id_fkey" FOREIGN KEY ("school_id", "section_id", "class_id") REFERENCES "sections"("school_id", "id", "class_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_sections" ADD CONSTRAINT "event_sections_class_id_fkey" FOREIGN KEY ("school_id", "class_id", "academic_year_id") REFERENCES "classes"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_event_id_fkey" FOREIGN KEY ("school_id", "event_id") REFERENCES "events"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_event_id_fkey" FOREIGN KEY ("school_id", "event_id", "academic_year_id") REFERENCES "events"("school_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_enrolment_id_fkey" FOREIGN KEY ("school_id", "enrolment_id", "student_id", "academic_year_id") REFERENCES "enrolments"("school_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "event_participation" ADD CONSTRAINT "event_participation_recorded_by_fkey" FOREIGN KEY ("school_id", "recorded_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_staff_id_fkey" FOREIGN KEY ("school_id", "staff_id") REFERENCES "staff"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_salary_structure_id_fkey" FOREIGN KEY ("school_id", "salary_structure_id", "staff_id") REFERENCES "salary_structures"("school_id", "id", "staff_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_created_by_fkey" FOREIGN KEY ("school_id", "created_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_ended_by_fkey" FOREIGN KEY ("school_id", "ended_by") REFERENCES "users"("school_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;





-- =============================================================================================
-- Hand-written below this line. Every object here is listed in test/guardrails/schema-checks.ts
-- (WAVE_S_OBJECTS) and written directly by test/phase5/wave-s-schema.e2e-spec.ts. Trigger
-- functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>' (prisma-errors.ts reads it).
-- The guards that read an event lock it FOR SHARE, so a write racing a status change (publish,
-- complete, cancel) waits for it and then sees the new status.
-- =============================================================================================

-- ---- events (rule 34, R310, R313, R316) --------------------------------------------------------

ALTER TABLE "events" ADD CONSTRAINT "events_title_check"
  CHECK ("title" = btrim("title") AND "title" <> '');

ALTER TABLE "events" ADD CONSTRAINT "events_title_no_id_check"
  CHECK ("title" !~ '[0-9]{13}' AND "title" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "events" ADD CONSTRAINT "events_venue_check"
  CHECK ("venue" = btrim("venue") AND "venue" <> '');

ALTER TABLE "events" ADD CONSTRAINT "events_venue_no_id_check"
  CHECK ("venue" !~ '[0-9]{13}' AND "venue" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "events" ADD CONSTRAINT "events_details_check"
  CHECK ("details" IS NULL OR ("details" = btrim("details") AND "details" <> ''));

ALTER TABLE "events" ADD CONSTRAINT "events_details_no_id_check"
  CHECK ("details" !~ '[0-9]{13}' AND "details" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "events" ADD CONSTRAINT "events_cancel_reason_check"
  CHECK ("cancel_reason" IS NULL OR ("cancel_reason" = btrim("cancel_reason") AND "cancel_reason" <> ''));

ALTER TABLE "events" ADD CONSTRAINT "events_cancel_reason_no_id_check"
  CHECK ("cancel_reason" !~ '[0-9]{13}' AND "cancel_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "events" ADD CONSTRAINT "events_dates_check"
  CHECK ("ends_at" >= "starts_at");

-- The draft's charge: whole rupees > 0; a due date only with an amount.
ALTER TABLE "events" ADD CONSTRAINT "events_charge_check"
  CHECK (
    ("charge_amount" IS NULL OR "charge_amount" > 0)
    AND ("charge_due_on" IS NULL OR "charge_amount" IS NOT NULL)
  );

-- R310: a campaign only for a charged event and never on a draft; every published or completed
-- charged event has one (publish sets it in the same UPDATE as the status).
ALTER TABLE "events" ADD CONSTRAINT "events_campaign_check"
  CHECK (
    ("campaign_id" IS NULL OR "charge_amount" IS NOT NULL)
    AND ("status" <> 'draft' OR "campaign_id" IS NULL)
    AND ("status" NOT IN ('published', 'completed') OR "charge_amount" IS NULL OR "campaign_id" IS NOT NULL)
  );

-- R310: a draft has no invitation; a published or completed event has one (a cancelled event has
-- one exactly when it was published first).
ALTER TABLE "events" ADD CONSTRAINT "events_announcement_check"
  CHECK (
    ("status" <> 'draft' OR "announcement_id" IS NULL)
    AND ("status" NOT IN ('published', 'completed') OR "announcement_id" IS NOT NULL)
  );

-- R313: a published event that is cancelled sends a cancellation; a cancelled draft invited
-- nobody and sends none.
ALTER TABLE "events" ADD CONSTRAINT "events_cancel_announcement_check"
  CHECK (
    ("cancel_announcement_id" IS NOT NULL) = ("status" = 'cancelled' AND "announcement_id" IS NOT NULL)
    AND "cancel_announcement_id" IS DISTINCT FROM "announcement_id"
  );

ALTER TABLE "events" ADD CONSTRAINT "events_cancelled_check"
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
  );

ALTER TABLE "events" ADD CONSTRAINT "events_completed_check"
  CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL));

-- R316: draft -> published | cancelled; published -> completed | cancelled. Completed and
-- cancelled are final.
CREATE TRIGGER "events_status_transition" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_status_transition(
    'draft:published', 'draft:cancelled', 'published:completed', 'published:cancelled');

CREATE TRIGGER "events_columns_immutable" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'created_by', 'created_at');

-- R316: PATCH edits a draft; once published the event is what families were told.
CREATE TRIGGER "events_content_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status(
    'draft', 'type', 'title', 'starts_at', 'ends_at', 'venue', 'details', 'charge_amount', 'charge_due_on');

CREATE TRIGGER "events_campaign_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('campaign_id');

CREATE TRIGGER "events_announcement_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('announcement_id');

CREATE TRIGGER "events_cancel_announcement_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancel_announcement_id');

CREATE TRIGGER "events_cancelled_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason');

CREATE TRIGGER "events_completed_frozen" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('completed_at');

-- R316: an event is born draft. A4: its date in school time lies inside its academic year. R310:
-- it is published only with at least one section (EVENT_NO_SECTIONS).
CREATE FUNCTION asms_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    v_refusal := 'events_born_draft';
  ELSIF (TG_OP = 'INSERT' OR NEW.starts_at IS DISTINCT FROM OLD.starts_at)
        AND NOT EXISTS (
          SELECT 1 FROM academic_years y JOIN schools s ON s.id = y.school_id
           WHERE y.school_id = NEW.school_id AND y.id = NEW.academic_year_id
             AND (NEW.starts_at AT TIME ZONE s.timezone)::date BETWEEN y.starts_on AND y.ends_on
        ) THEN
    v_refusal := 'events_in_year';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM event_sections es WHERE es.school_id = NEW.school_id AND es.event_id = NEW.id
        ) THEN
    v_refusal := 'events_has_sections';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'event refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "events_guard" BEFORE INSERT OR UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_event_guard();

CREATE TRIGGER "events_no_delete" BEFORE DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "events_no_truncate" BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "events_school_id_immutable" BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- event_sections (R310) -------------------------------------------------------------------

CREATE TRIGGER "event_sections_columns_immutable" BEFORE UPDATE ON "event_sections"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'event_id', 'section_id', 'class_id', 'academic_year_id', 'created_at');

-- A draft's sections are a form field, replaced on PATCH (the charge_campaign_audiences
-- precedent); once the event leaves draft they are who was invited: no insert, update or delete.
CREATE FUNCTION asms_event_section_draft_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row event_sections;
  v_status event_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  SELECT e.status INTO v_status FROM events e
   WHERE e.school_id = v_row.school_id AND e.id = v_row.event_id
   FOR SHARE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the sections of an event change only while it is a draft'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'event_sections_draft_only',
            DETAIL = 'constraint: event_sections_draft_only',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_sections_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "event_sections"
  FOR EACH ROW EXECUTE FUNCTION asms_event_section_draft_only();

CREATE TRIGGER "event_sections_no_truncate" BEFORE TRUNCATE ON "event_sections"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "event_sections_school_id_immutable" BEFORE UPDATE ON "event_sections"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- event_duties (rule 34, R311) --------------------------------------------------------------

ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_note_check"
  CHECK ("note" IS NULL OR ("note" = btrim("note") AND "note" <> ''));

ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_ended_check"
  CHECK (
    ("ended_at" IS NULL) = ("ended_by" IS NULL)
    AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
  );

ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_end_reason_check"
  CHECK ("end_reason" IS NULL OR ("end_reason" = btrim("end_reason") AND "end_reason" <> ''));

ALTER TABLE "event_duties" ADD CONSTRAINT "event_duties_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- One live duty of a kind per staff member per event (EVENT_DUTY_EXISTS).
CREATE UNIQUE INDEX "event_duties_live_key" ON "event_duties" ("school_id", "event_id", "staff_id", "duty")
  WHERE "ended_at" IS NULL;

CREATE TRIGGER "event_duties_columns_immutable" BEFORE UPDATE ON "event_duties"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'event_id', 'staff_id', 'duty', 'note', 'created_by', 'created_at');

CREATE TRIGGER "event_duties_ended_frozen" BEFORE UPDATE ON "event_duties"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by', 'end_reason');

-- A duty is born live, and is added or ended only while its event is draft or published: the
-- duties of a completed or cancelled event are history.
CREATE FUNCTION asms_event_duty_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status event_status;
  v_refusal text;
BEGIN
  SELECT e.status INTO v_status FROM events e
   WHERE e.school_id = NEW.school_id AND e.id = NEW.event_id
   FOR SHARE;
  IF TG_OP = 'INSERT' AND NEW.ended_at IS NOT NULL THEN
    v_refusal := 'event_duties_born_live';
  ELSIF v_status IS NOT NULL AND v_status NOT IN ('draft', 'published') THEN
    v_refusal := 'event_duties_event_open';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'event duty refused (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_duties_guard" BEFORE INSERT OR UPDATE ON "event_duties"
  FOR EACH ROW EXECUTE FUNCTION asms_event_duty_guard();

CREATE TRIGGER "event_duties_no_delete" BEFORE DELETE ON "event_duties"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "event_duties_no_truncate" BEFORE TRUNCATE ON "event_duties"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "event_duties_school_id_immutable" BEFORE UPDATE ON "event_duties"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- event_participation (R312) ----------------------------------------------------------------

-- Edited in place: only status, recorded_by and recorded_at change.
CREATE TRIGGER "event_participation_columns_immutable" BEFORE UPDATE ON "event_participation"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'event_id', 'academic_year_id', 'student_id', 'enrolment_id', 'created_at');

-- R312: participation is recorded while the event is published, and frozen at completion.
CREATE FUNCTION asms_event_participation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status event_status;
BEGIN
  SELECT e.status INTO v_status FROM events e
   WHERE e.school_id = NEW.school_id AND e.id = NEW.event_id
   FOR SHARE;
  IF v_status IS NOT NULL AND v_status <> 'published' THEN
    RAISE EXCEPTION 'participation is recorded only while the event is published'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'event_participation_event_published',
            DETAIL = 'constraint: event_participation_event_published',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_participation_guard" BEFORE INSERT OR UPDATE ON "event_participation"
  FOR EACH ROW EXECUTE FUNCTION asms_event_participation_guard();

CREATE TRIGGER "event_participation_no_delete" BEFORE DELETE ON "event_participation"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "event_participation_no_truncate" BEFORE TRUNCATE ON "event_participation"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "event_participation_school_id_immutable" BEFORE UPDATE ON "event_participation"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();

-- ---- expenses.event_id (R314) ------------------------------------------------------------------

-- The event report's expenses line, and GET /expenses?eventId=.
CREATE INDEX "expenses_event_id_idx" ON "expenses" ("school_id", "event_id")
  WHERE "event_id" IS NOT NULL;

-- Tagged once, never moved or cleared. expenses_content_frozen does not name event_id, so a late
-- bill is tagged after approval (R314).
CREATE TRIGGER "expenses_event_frozen" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('event_id');

-- R314: an expense is tagged only while it is not voided, and only to an event that is published
-- or completed (a draft has happened nowhere; a cancelled event has no report).
CREATE FUNCTION asms_expense_event_tag() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status event_status;
  v_refusal text;
BEGIN
  IF NEW.event_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id) THEN
    RETURN NEW;
  END IF;
  SELECT e.status INTO v_status FROM events e
   WHERE e.school_id = NEW.school_id AND e.id = NEW.event_id
   FOR SHARE;
  IF NEW.status = 'voided' OR (TG_OP = 'UPDATE' AND OLD.status = 'voided') THEN
    v_refusal := 'expenses_event_tag_voided';
  ELSIF v_status IS NOT NULL AND v_status NOT IN ('published', 'completed') THEN
    v_refusal := 'expenses_event_tag_event_status';
  END IF;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'the expense cannot be tagged to this event (%)', v_refusal
      USING ERRCODE = 'check_violation',
            CONSTRAINT = v_refusal,
            DETAIL = 'constraint: ' || v_refusal,
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expenses_event_tag" BEFORE INSERT OR UPDATE OF "event_id" ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION asms_expense_event_tag();

-- ---- staff_contracts (rule 35, R318-R321) ------------------------------------------------------

-- R318: permanent has no end; fixed-term and probation have one (STAFF_CONTRACT_END_REQUIRED).
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_type_end_check"
  CHECK (("type" = 'permanent') = ("ends_on" IS NULL));

ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_dates_check"
  CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on");

-- The end group travels together; the actual last day is never before the start.
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_ended_check"
  CHECK (
    ("ended_at" IS NULL) = ("ended_by" IS NULL)
    AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
    AND ("ended_at" IS NULL) = ("ended_on" IS NULL)
    AND ("ended_on" IS NULL OR "ended_on" >= "starts_on")
  );

-- R319: the expiry warnings exist only for a contract with an end.
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_warned_check"
  CHECK ("ends_on" IS NOT NULL OR ("warned_30_at" IS NULL AND "warned_7_at" IS NULL));

ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_note_check"
  CHECK ("note" IS NULL OR ("note" = btrim("note") AND "note" <> ''));

ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_note_no_id_check"
  CHECK ("note" !~ '[0-9]{13}' AND "note" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_end_reason_check"
  CHECK ("end_reason" IS NULL OR ("end_reason" = btrim("end_reason") AND "end_reason" <> ''));

ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_end_reason_no_id_check"
  CHECK ("end_reason" !~ '[0-9]{13}' AND "end_reason" !~ '[0-9]{5}-[0-9]{7}-[0-9]');

-- R321: the scanned contract, in the expenses receipt shape: key, mime and size together, the
-- staged-upload key of this school.
ALTER TABLE "staff_contracts" ADD CONSTRAINT "staff_contracts_document_check"
  CHECK (
    ("document_object_key" IS NULL) = ("document_mime" IS NULL)
    AND ("document_object_key" IS NULL) = ("document_size_bytes" IS NULL)
    AND (
      "document_object_key" IS NULL
      OR (
        "document_object_key" ~ ('^' || "school_id"::text || '/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|pdf)$')
        AND "document_mime" IN ('image/jpeg', 'image/png', 'application/pdf')
        AND "document_size_bytes" BETWEEN 1 AND 5242880
      )
    )
  );

CREATE UNIQUE INDEX "staff_contracts_document_object_key_key" ON "staff_contracts" ("school_id", "document_object_key")
  WHERE "document_object_key" IS NOT NULL;

-- R318: one live contract per staff member (STAFF_CONTRACT_LIVE_EXISTS).
CREATE UNIQUE INDEX "staff_contracts_live_key" ON "staff_contracts" ("school_id", "staff_id")
  WHERE "ended_at" IS NULL;

-- R319, R320: the expiry job and the staff report read live contracts by end date.
CREATE INDEX "staff_contracts_live_ends_on_idx" ON "staff_contracts" ("school_id", "ends_on")
  WHERE "ended_at" IS NULL;

-- Rule 35: a contract is never edited; a renewal is a new row.
CREATE TRIGGER "staff_contracts_columns_immutable" BEFORE UPDATE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'staff_id', 'type', 'starts_on', 'ends_on', 'salary_structure_id', 'document_object_key',
    'document_mime', 'document_size_bytes', 'note', 'created_by', 'created_at');

CREATE TRIGGER "staff_contracts_ended_frozen" BEFORE UPDATE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by', 'end_reason', 'ended_on');

CREATE TRIGGER "staff_contracts_warned_30_frozen" BEFORE UPDATE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('warned_30_at');

CREATE TRIGGER "staff_contracts_warned_7_frozen" BEFORE UPDATE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('warned_7_at');

CREATE TRIGGER "staff_contracts_no_delete" BEFORE DELETE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_contracts_no_truncate" BEFORE TRUNCATE ON "staff_contracts"
  FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete();

CREATE TRIGGER "staff_contracts_school_id_immutable" BEFORE UPDATE ON "staff_contracts"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change();
