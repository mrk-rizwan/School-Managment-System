import type { CsvColumn } from '@asms/shared';
import type { MeritListRowDto, SectionSubjectSummaryDto, SubjectReportSectionDto } from './result-reports.dto';

// Phase 5 slice 42 (contracts/slice-42.md §3, R336): the result reports' CSV columns, the rows the
// web tab shows. A percentage is written as a number with two decimals (7850 bp → 78.5).

const percent = (bp: number | null): number | null => (bp === null ? null : bp / 100);

export const MERIT_LIST_COLUMNS: readonly CsvColumn<MeritListRowDto>[] = [
  { header: 'Position', value: (r) => r.classPosition },
  { header: 'Of', value: (r) => r.positionOf },
  { header: 'Student', value: (r) => r.studentName },
  { header: 'Admission no', value: (r) => r.admissionNo },
  { header: 'Section', value: (r) => r.sectionName },
  { header: 'Percent', value: (r) => percent(r.percentBp) },
  { header: 'Grade', value: (r) => r.grade },
  { header: 'Passed', value: (r) => r.passed },
];

/** The section summary's per-subject table. */
export const SECTION_SUBJECT_COLUMNS: readonly CsvColumn<SectionSubjectSummaryDto>[] = [
  { header: 'Subject', value: (r) => r.subjectName },
  { header: 'Assessed', value: (r) => r.assessed },
  { header: 'Passed', value: (r) => r.passed },
  { header: 'Failed', value: (r) => r.failed },
  { header: 'Average percent', value: (r) => percent(r.averageBp) },
  { header: 'Grades', value: (r) => r.grades.map((g) => `${g.grade} ${g.count}`).join('; ') },
];

/** The subject report's per-section table. */
export const SUBJECT_SECTION_COLUMNS: readonly CsvColumn<SubjectReportSectionDto>[] = [
  { header: 'Section', value: (r) => r.sectionName },
  { header: 'Published', value: (r) => r.published },
  { header: 'Students', value: (r) => r.students },
  { header: 'Assessed', value: (r) => r.assessed },
  { header: 'Average percent', value: (r) => percent(r.averageBp) },
];
