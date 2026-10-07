-- Phase 3 close (performance review, 2026-10-07). The late-fee candidate sweep
-- (charge-generation.repository.ts) and the collections-by-class report
-- (finance-report.repository.ts) look up a child's enrolment in a given academic year from a
-- correlated lateral subquery. With only (school_id, student_id) Postgres filtered
-- academic_year_id row by row: 4.1 s and 9.7 s at 3,000 students over a year. This index serves
-- the lookup directly (69 ms and 198 ms). The (school_id, student_id) index stays.
CREATE INDEX "enrolments_school_id_student_id_academic_year_id_idx" ON "enrolments"("school_id", "student_id", "academic_year_id");
