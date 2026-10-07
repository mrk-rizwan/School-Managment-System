import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { prefersMinimal } from '../attendance/attendance.dto';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import {
  AssessmentDto,
  AssessmentMarkDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksDto,
  AssessmentSubmitMarksMinimalResultDto,
  AssessmentSubmitMarksResultDto,
  CreateAssessmentDto,
  ExamSetUpResultDto,
  ListAssessmentsQueryDto,
  SetUpExamsDto,
  UpdateAssessmentDto,
} from './assessments.dto';
import { AssessmentsService } from './assessments.service';
import { MarksService } from './marks.service';

// contracts/slice-30.md §1. Common to every route: 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED,
// 426 (bearer), 429.
const COMMON = [401, 403, 429];

/** The marks writes (create, submit, excuse): 60 a minute, 1,000 an hour per school user. */
export const MarksWritesThrottleGuard = perUserThrottle('marks-writes', 60, 1000);

@ApiTags('assessments')
@Controller()
export class AssessmentsController {
  constructor(
    private readonly assessments: AssessmentsService,
    private readonly marks: MarksService,
  ) {}

  @Get('assessments')
  @RequireCapability(Capability.MARKS_ENTER, Capability.MARKS_VIEW_ALL)
  @ApiPaginated(AssessmentDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListAssessmentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<AssessmentDto>> {
    return this.assessments.list(session, query);
  }

  /** 201 for a new test; 200 for a replay of the same key and body. */
  @Post('assessments')
  @RequireCapability(Capability.MARKS_ENTER)
  @UseGuards(IdempotencyKeyGuard, MarksWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: AssessmentDto })
  @ApiOkResponse({ type: AssessmentDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @Body() body: CreateAssessmentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssessmentDto> {
    const outcome = await this.assessments.create(session, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.assessment;
  }

  @Get('assessments/:id')
  @RequireCapability(Capability.MARKS_ENTER, Capability.MARKS_VIEW_ALL)
  @ApiIdParam()
  @ApiOkResponse({ type: AssessmentDto })
  @ApiErrors(...COMMON, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AssessmentDto> {
    return this.assessments.get(session, id);
  }

  /** The creator (inside their write scope) or an assessment.define holder. */
  @Patch('assessments/:id')
  @RequireCapability(Capability.MARKS_ENTER, Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: AssessmentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateAssessmentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AssessmentDto> {
    return this.assessments.update(session, id, body);
  }

  @Post('assessments/:id/void')
  @HttpCode(200)
  @RequireCapability(Capability.MARKS_ENTER, Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: AssessmentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AssessmentDto> {
    return this.assessments.void(session, id, body.reason);
  }

  @Get('assessments/:id/marks')
  @RequireCapability(Capability.MARKS_ENTER, Capability.MARKS_VIEW_ALL)
  @ApiIdParam()
  @ApiOkResponse({ type: AssessmentMarksDto })
  @ApiErrors(...COMMON, 404)
  grid(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AssessmentMarksDto> {
    return this.marks.grid(session, id);
  }

  /**
   * §3.2: per-row outcomes in request order, always 200. With `Prefer: return=minimal` the answer
   * is AssessmentSubmitMarksMinimalResultDto and says `Preference-Applied: return=minimal`.
   */
  @Post('assessments/:id/submit-marks')
  @HttpCode(200)
  @RequireCapability(Capability.MARKS_ENTER)
  @UseGuards(MarksWritesThrottleGuard)
  @ApiIdParam()
  @ApiHeader({
    name: 'Prefer',
    required: false,
    description:
      'return=minimal: the answer is { assessmentId, entries } (AssessmentSubmitMarksMinimalResultDto), with Preference-Applied: return=minimal. Absent: the full AssessmentSubmitMarksResultDto.',
  })
  @ApiExtraModels(AssessmentSubmitMarksMinimalResultDto)
  @ApiOkResponse({
    type: AssessmentSubmitMarksResultDto,
    description: 'AssessmentSubmitMarksMinimalResultDto with Prefer: return=minimal',
  })
  @ApiErrors(...COMMON, 404, 409, 422)
  async submitMarks(
    @IdParam() id: bigint,
    @Body() body: AssessmentSubmitMarksDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssessmentSubmitMarksResultDto | AssessmentSubmitMarksMinimalResultDto> {
    const result = await this.marks.submit(session, id, body);
    res.vary('Prefer');
    // A header, not a body field: read from the request (asms/no-brand-in-request).
    if (!prefersMinimal(res.req.get('prefer'))) return result;
    res.setHeader('Preference-Applied', 'return=minimal');
    return { assessmentId: result.assessment.id, entries: result.entries };
  }

  @Post('marks/:id/excuse')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_APPROVE)
  @UseGuards(MarksWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: AssessmentMarkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  excuse(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AssessmentMarkDto> {
    return this.marks.excuse(session, id, body.reason);
  }

  /** §5: one exam per class-subject per live section; idempotent by the unique, no key. */
  @Post('terms/:id/set-up-exams')
  @HttpCode(200)
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: ExamSetUpResultDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  setUpExams(
    @IdParam() id: bigint,
    @Body() body: SetUpExamsDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ExamSetUpResultDto> {
    return this.assessments.setUpExams(session, id, body);
  }
}
