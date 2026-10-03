-- Prisma sends enum conditions as `status = CAST($n::text AS enrolment_status)`. Text-to-enum is a
-- stable cast, so the planner cannot prove a partial index's `WHERE status = 'active'` and
-- enrolments_student_active_key is never used for reads (measured in the Phase 1 performance
-- review: the roll-number sort's "no active enrolment" anti-join read every enrolment the school
-- ever had). Status as an index column serves the same reads. The partial unique index stays as
-- the one-active-enrolment-per-student constraint.
CREATE INDEX "enrolments_school_id_status_student_id_idx"
  ON "enrolments" ("school_id", "status", "student_id");
