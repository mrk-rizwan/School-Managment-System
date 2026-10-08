import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { ResultApprovalService } from './result-approval.service';
import { ResultSheetsService } from './result-sheets.service';
import {
  CreateResultSheetDto,
  ListResultSheetsQueryDto,
  ResultSheetDetailDto,
  ResultSheetDto,
  UpdateResultSheetDto,
} from './results.dto';

// contracts/slice-31.md §1. Common to every route: 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED,
// 426 (bearer), 429. A sheet outside the caller's scope is 404.
const COMMON = [401, 403, 429];

/** The sheet writes (create, remarks, submit, return, approve, publish): 30 a minute, 300 an hour per user. */
export const ResultSheetWritesThrottleGuard = perUserThrottle('result-sheet-writes', 30, 300);

/** The sheet reads (the list, the detail; both may compose): 120 a minute, 2000 an hour per user. */
export const ResultSheetReadsThrottleGuard = perUserThrottle('result-sheet-reads', 120, 2000);

/** Who reads sheets (§3.1): the class teacher (own section), marks.view_all, result.approve. */
const READERS = [
  Capability.MARKS_ENTER,
  Capability.MARKS_VIEW_ALL,
  Capability.RESULT_APPROVE,
] as const;

@ApiTags('results')
@Controller()
export class ResultsController {
  constructor(
    private readonly sheets: ResultSheetsService,
    private readonly approval: ResultApprovalService,
  ) {}

  /** R267: 201 for a new sheet; 200 with the open version on a repeat. */
  @Post('sections/:id/result-sheets')
  @RequireCapability(Capability.MARKS_ENTER, Capability.ASSESSMENT_DEFINE)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiCreatedResponse({ type: ResultSheetDetailDto })
  @ApiOkResponse({ type: ResultSheetDetailDto, description: 'The open version, already created' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @IdParam() sectionId: bigint,
    @Body() body: CreateResultSheetDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ResultSheetDetailDto> {
    const outcome = await this.sheets.create(session, sectionId, body);
    if (!outcome.created) res.status(200);
    return outcome.sheet;
  }

  @Get('result-sheets')
  @RequireCapability(...READERS)
  @UseGuards(ResultSheetReadsThrottleGuard)
  @ApiPaginated(ResultSheetDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListResultSheetsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<ResultSheetDto>> {
    return this.sheets.list(session, query);
  }

  @Get('result-sheets/:id')
  @RequireCapability(...READERS)
  @UseGuards(ResultSheetReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404)
  detail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.sheets.detail(session, id);
  }

  /** The class teacher's term remarks, the given rows only (draft or returned). */
  @Patch('result-sheets/:id')
  @RequireCapability(Capability.MARKS_ENTER, Capability.ASSESSMENT_DEFINE)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateResultSheetDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.sheets.updateRemarks(session, id, body);
  }

  @Post('result-sheets/:id/submit')
  @HttpCode(200)
  @RequireCapability(Capability.MARKS_ENTER, Capability.ASSESSMENT_DEFINE)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409)
  submit(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.sheets.submit(session, id);
  }

  @Post('result-sheets/:id/return')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_APPROVE)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  return(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.sheets.return(session, id, body.reason);
  }

  /** Composes and stores (R269); publishes too when the approver holds result.publish (R272). */
  @Post('result-sheets/:id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_APPROVE)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  approve(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.approval.approve(session, id);
  }

  @Post('result-sheets/:id/publish')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_PUBLISH)
  @UseGuards(ResultSheetWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409)
  publish(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ResultSheetDetailDto> {
    return this.sheets.publish(session, id);
  }
}
