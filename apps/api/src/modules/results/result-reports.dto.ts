import { ApiProperty } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';
import { RESULT_SHEET_STATUSES, type ResultSheetStatus } from '@asms/shared';
import { IsIdString } from '../../common/ids';

// contracts/slice-33.md §3 (phase-4-academic.md slice 33, R287): the two result reports, read
// from the stored rows only (never recomposed). Percentages are basis points (7850 = 78.50 %);
// an average is the mean of the stored percent_bp, rounded half-up.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const BP = { type: 'integer', minimum: 0, maximum: 10000 } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;

export class SectionSummaryQueryDto {
  @ApiProperty({ ...ID, description: 'An approved or published sheet (any version)' })
  @IsDefined()
  @IsIdString()
  sheetId: string;
}

export class SubjectReportQueryDto {
  @ApiProperty(ID)
  @IsDefined()
  @IsIdString()
  termId: string;

  @ApiProperty(ID)
  @IsDefined()
  @IsIdString()
  classSubjectId: string;
}

export class GradeCountDto {
  @ApiProperty() grade: string;
  @ApiProperty(COUNT) count: number;
}

export class SectionSubjectSummaryDto {
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty({ ...COUNT, description: 'Students assessed in the subject' }) assessed: number;
  @ApiProperty({ ...COUNT, description: "Printed obtained ÷ max at or above the sheet's pass mark" })
  passed: number;
  @ApiProperty(COUNT) failed: number;
  @ApiProperty({ ...BP, nullable: true, description: 'Null when nobody was assessed' })
  averageBp: number | null;
  @ApiProperty({ type: () => GradeCountDto, isArray: true }) grades: GradeCountDto[];
}

export class SectionSummaryReportDto {
  @ApiProperty(ID) sheetId: string;
  @ApiProperty({ enum: RESULT_SHEET_STATUSES, enumName: 'ResultSheetStatus' }) status: ResultSheetStatus;
  @ApiProperty({ type: 'integer', minimum: 1 }) version: number;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty({ ...ID, nullable: true, description: 'Null for the final sheet' }) termId: string | null;
  @ApiProperty({ type: String, nullable: true }) termName: string | null;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, maximum: 100 }) passPercent: number | null;
  @ApiProperty({ ...COUNT, description: 'Results on the sheet version' }) students: number;
  @ApiProperty({ ...COUNT, description: 'Results with something assessed' }) assessed: number;
  @ApiProperty({ ...COUNT, description: 'Stored passed = true' }) passed: number;
  @ApiProperty({ ...COUNT, description: 'Stored passed = false' }) failed: number;
  @ApiProperty({ ...BP, nullable: true }) averageBp: number | null;
  @ApiProperty({ type: () => GradeCountDto, isArray: true, description: 'Overall grades, most frequent first' })
  grades: GradeCountDto[];
  @ApiProperty({ type: () => SectionSubjectSummaryDto, isArray: true, description: 'In the card order' })
  subjects: SectionSubjectSummaryDto[];
}

export class SubjectReportStudentDto {
  @ApiProperty(ID) resultId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty(BP) percentBp: number;
}

export class SubjectReportSectionDto {
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ description: 'Every live row of the section is published' }) published: boolean;
  @ApiProperty(COUNT) students: number;
  @ApiProperty(COUNT) assessed: number;
  @ApiProperty({ ...BP, nullable: true }) averageBp: number | null;
  @ApiProperty({ type: () => SubjectReportStudentDto, isArray: true, description: 'The highest three, best first' })
  top: SubjectReportStudentDto[];
  @ApiProperty({ type: () => SubjectReportStudentDto, isArray: true, description: 'The lowest three, lowest first' })
  bottom: SubjectReportStudentDto[];
}

export class SubjectReportDto {
  @ApiProperty(ID) termId: string;
  @ApiProperty() termName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty(COUNT) assessed: number;
  @ApiProperty({ ...BP, nullable: true, description: 'Across every section' }) averageBp: number | null;
  @ApiProperty({
    type: () => SubjectReportSectionDto,
    isArray: true,
    description: 'Sections with an approved or published sheet, by name',
  })
  sections: SubjectReportSectionDto[];
}
