import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  MyAssessmentMarkDto,
  MyAssessmentsQueryDto,
  MyChildResultsDto,
  MyResultDto,
  MyResultsQueryDto,
} from './my-results.dto';
import { MyResultsService } from './my-results.service';
import {
  SectionSummaryQueryDto,
  SectionSummaryReportDto,
  SubjectReportDto,
  SubjectReportQueryDto,
} from './result-reports.dto';
import { ResultReportsService } from './result-reports.service';
import { ResultDto } from './results.dto';

// contracts/slice-33.md §1 (phase-4-academic.md slice 33). A child outside the guardian's live
// login links, a result that is not the child's or not published and live, and a student outside
// the caller's scope are all 404, the same as absent (R78, R285). Every /me/* read sits under the
// per-user me-reads bucket (R166).
const COMMON = [401, 403, 429];

/** The result reports: 30 a minute, 300 an hour per user (plan §5). */
export const ResultReportsThrottleGuard = perUserThrottle('result-reports', 30, 300);

@ApiTags('me')
@Controller('me/children/:id')
@RequireCapacity('guardian')
@UseGuards(MeReadsThrottleGuard)
export class MyChildResultsController {
  constructor(private readonly results: MyResultsService) {}

  @Get('results')
  @ApiIdParam()
  @ApiOkResponse({ type: MyChildResultsDto })
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() id: bigint,
    @Query() query: MyResultsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyChildResultsDto> {
    return this.results.results(session, 'guardian', id, query);
  }

  @Get('results/:resultId')
  @ApiIdParam()
  @ApiIdParam('resultId')
  @ApiOkResponse({ type: MyResultDto })
  @ApiErrors(...COMMON, 404)
  card(
    @IdParam() id: bigint,
    @IdParam('resultId') resultId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyResultDto> {
    return this.results.result(session, 'guardian', id, resultId);
  }

  /** Class tests only, live marks of non-voided tests, newest test first (R286). */
  @Get('assessments')
  @ApiIdParam()
  @ApiPaginated(MyAssessmentMarkDto)
  @ApiErrors(...COMMON, 404, 422)
  assessments(
    @IdParam() id: bigint,
    @Query() query: MyAssessmentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyAssessmentMarkDto>> {
    return this.results.assessments(session, id, query);
  }
}

@ApiTags('me')
@Controller('me/student')
@RequireCapacity('student')
@UseGuards(MeReadsThrottleGuard)
export class MyStudentResultsController {
  constructor(private readonly results: MyResultsService) {}

  /** The student from the session (§0.29); `outstanding` is always null. */
  @Get('results')
  @ApiOkResponse({ type: MyChildResultsDto })
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: MyResultsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyChildResultsDto> {
    return this.results.results(session, 'student', ownId(session), query);
  }

  @Get('results/:resultId')
  @ApiIdParam('resultId')
  @ApiOkResponse({ type: MyResultDto })
  @ApiErrors(...COMMON, 404)
  card(
    @IdParam('resultId') resultId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyResultDto> {
    return this.results.result(session, 'student', ownId(session), resultId);
  }

  @Get('assessments')
  @ApiPaginated(MyAssessmentMarkDto)
  @ApiErrors(...COMMON, 422)
  assessments(
    @Query() query: MyAssessmentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyAssessmentMarkDto>> {
    return this.results.assessments(session, ownId(session), query);
  }
}

@ApiTags('results')
@Controller('students')
export class StudentResultsController {
  constructor(private readonly results: MyResultsService) {}

  /** The student page's results (R288): published, live, newest first, across years. */
  @Get(':id/results')
  @RequireCapability(Capability.MARKS_VIEW_ALL, Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(ResultDto)
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<ResultDto>> {
    return this.results.ofStudent(session, id, query);
  }
}

@ApiTags('results')
@Controller('result-reports')
@RequireCapability(Capability.MARKS_VIEW_ALL)
@UseGuards(ResultReportsThrottleGuard)
export class ResultReportsController {
  constructor(private readonly reports: ResultReportsService) {}

  /** Pass and fail counts, averages per subject, grade distribution (R287). */
  @Get('section-summary')
  @ApiOkResponse({ type: SectionSummaryReportDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  sectionSummary(
    @Query() query: SectionSummaryQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SectionSummaryReportDto> {
    return this.reports.sectionSummary(scopeOf(session), query);
  }

  /** Per-section averages, top and bottom, of one class-subject in a term (R287). */
  @Get('subject')
  @ApiOkResponse({ type: SubjectReportDto })
  @ApiErrors(...COMMON, 404, 422)
  subject(
    @Query() query: SubjectReportQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SubjectReportDto> {
    return this.reports.subject(scopeOf(session), query);
  }
}

/** The caller's own student id: the student capacity requires it (contracts/slice-13.md §1.2). */
function ownId(session: SchoolSessionContext): bigint {
  return session.access.studentId ?? 0n;
}
