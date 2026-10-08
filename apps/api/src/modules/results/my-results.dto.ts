import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { TEST_TYPES, type TestType } from '@asms/shared';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { ResultDto } from './results.dto';

// contracts/slice-33.md §2 (phase-4-academic.md slice 33, §0.29, R274, R282, R285, R286): the
// family's and the student's views of results and class tests, and the student page's results.
// Percentages are basis points (7850 = 78.50 %).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const BP = { type: 'integer', minimum: 0, maximum: 10000 } as const;
const DATE = { type: String, format: 'date', example: '2026-05-10' } as const;

const WITHHELD_DOC =
  'The school withholds report cards while dues are owed (withhold_card_for_dues) and this child owes: the per-subject card is not served until the dues are cleared or the principal overrides (R282). A later payment unlocks it with no write';
const OUTSTANDING_DOC =
  'The amount owed in whole rupees when withheld; null otherwise, and always null on a student login (the student sees no figure)';

export class MyResultsQueryDto {
  @ApiPropertyOptional({
    ...ID,
    description: 'Default: the latest year in which the child has a published result',
  })
  @IsOptional()
  @IsIdString()
  academicYearId?: string;
}

export class MyResultYearDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
}

export class MyResultSummaryDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty({ ...ID, nullable: true, description: 'Null for the final result of the year' })
  termId: string | null;
  @ApiProperty({ type: String, nullable: true, description: "The term's name; null for the final result" })
  termName: string | null;
  @ApiProperty() isFinal: boolean;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({
    ...BP,
    nullable: true,
    description: 'Null when nothing was assessed, and on a student login while the card is withheld',
  })
  percentBp: number | null;
  @ApiProperty({ type: String, nullable: true, description: 'Null as percentBp' }) grade: string | null;
  @ApiProperty({ description: 'A correction revised it after publication' }) revised: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) publishedAt: Date;
}

export class MyChildResultsDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty({ ...ID, nullable: true, description: 'The year shown; null when there is no published result' })
  academicYearId: string | null;
  @ApiProperty({
    type: () => MyResultYearDto,
    isArray: true,
    description: 'The years with a published result, newest first',
  })
  years: MyResultYearDto[];
  @ApiProperty({
    type: () => MyResultSummaryDto,
    isArray: true,
    description: "The year's published term results, in term order",
  })
  terms: MyResultSummaryDto[];
  @ApiProperty({ type: () => MyResultSummaryDto, nullable: true, description: "The year's published final result" })
  final: MyResultSummaryDto | null;
  @ApiProperty({ description: WITHHELD_DOC }) withheld: boolean;
  @ApiProperty({ type: 'integer', nullable: true, description: OUTSTANDING_DOC }) outstanding: number | null;
}

export class MyResultDto {
  @ApiProperty({ description: WITHHELD_DOC }) withheld: boolean;
  @ApiProperty({ type: 'integer', nullable: true, description: OUTSTANDING_DOC }) outstanding: number | null;
  @ApiProperty({
    type: () => ResultDto,
    nullable: true,
    description: 'The report card; null while withheld',
  })
  result: ResultDto | null;
}

export class MyAssessmentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  termId?: string;
}

/** A class-test mark as the family sees it (R286): live, of a non-voided test. */
export class MyAssessmentMarkDto {
  @ApiProperty(ID) markId: string;
  @ApiProperty(ID) assessmentId: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: TEST_TYPES, enumName: 'TestType', nullable: true }) testType: TestType | null;
  @ApiProperty(DATE) heldOn: string;
  @ApiProperty(ID) termId: string;
  @ApiProperty() termName: string;
  @ApiProperty() subjectName: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) maxMarks: number;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Null when absent' }) obtained: number | null;
  @ApiProperty() absent: boolean;
  @ApiProperty({ description: 'An absence the principal excused: it does not count' }) excused: boolean;
}
