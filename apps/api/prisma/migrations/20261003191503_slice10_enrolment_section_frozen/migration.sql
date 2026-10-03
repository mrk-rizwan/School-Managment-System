-- Slice 10 (contracts/slice-10.md §8.1, §12 item 2; R174): a section change is close-old/open-new
-- from this slice, so nothing edits enrolments.section_id in place any more. The database freezes
-- it with the other identity columns, so the roster of any past date stays reconstructible from
-- started_on / ended_on. Hand-written (create-only); no schema.prisma change.

DROP TRIGGER "enrolments_columns_immutable" ON "enrolments";

CREATE TRIGGER "enrolments_columns_immutable" BEFORE UPDATE ON "enrolments"
  FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(
    'student_id', 'academic_year_id', 'class_id', 'section_id');
