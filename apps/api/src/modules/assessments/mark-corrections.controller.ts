import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { MarksWritesThrottleGuard } from './assessments.controller';
import {
  CorrectMarkDto,
  ListMarkCorrectionsQueryDto,
  MarkCorrectionDecisionDto,
  MarkCorrectionDto,
} from './mark-corrections.dto';
import { MarkCorrectionsService } from './mark-corrections.service';

// contracts/slice-32.md §1. Common to every route: 401, 403 PERMISSION_DENIED, 426 (bearer), 429.
// A mark or correction outside the caller's scope is 404.
const COMMON = [401, 403, 429];

@ApiTags('assessments')
@Controller()
export class MarkCorrectionsController {
  constructor(private readonly corrections: MarkCorrectionsService) {}

  /** R280: a pending correction of a mark on a published result. 201, or 200 on a replay. */
  @Post('marks/:id/correct')
  @RequireCapability(Capability.MARKS_ENTER)
  @UseGuards(IdempotencyKeyGuard, MarksWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: MarkCorrectionDto })
  @ApiOkResponse({ type: MarkCorrectionDto, description: 'Replay of a committed request' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async correct(
    @IdParam() id: bigint,
    @Body() body: CorrectMarkDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MarkCorrectionDto> {
    const outcome = await this.corrections.request(session, id, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.correction;
  }

  /** Newest request first; `status` pending | approved | rejected. */
  @Get('mark-corrections')
  @RequireCapability(Capability.RESULT_APPROVE, Capability.MARKS_VIEW_ALL)
  @ApiPaginated(MarkCorrectionDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListMarkCorrectionsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MarkCorrectionDto>> {
    return this.corrections.list(session, query);
  }

  @Get('mark-corrections/:id')
  @RequireCapability(Capability.RESULT_APPROVE, Capability.MARKS_VIEW_ALL)
  @ApiIdParam()
  @ApiOkResponse({ type: MarkCorrectionDto })
  @ApiErrors(...COMMON, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MarkCorrectionDto> {
    return this.corrections.get(session, id);
  }

  /** R280, R281: supersedes the mark, re-composes the term (and final) sheet as a new version. */
  @Post('mark-corrections/:id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_APPROVE)
  @UseGuards(MarksWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: MarkCorrectionDecisionDto })
  @ApiErrors(...COMMON, 404, 409)
  approve(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MarkCorrectionDecisionDto> {
    return this.corrections.approve(session, id);
  }

  @Post('mark-corrections/:id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_APPROVE)
  @UseGuards(MarksWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: MarkCorrectionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MarkCorrectionDto> {
    return this.corrections.reject(session, id, body.reason);
  }

  /** The requester takes back their own pending correction (rejected, audited withdrawn). */
  @Post('mark-corrections/:id/withdraw')
  @HttpCode(200)
  @RequireCapability(Capability.MARKS_ENTER)
  @UseGuards(MarksWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: MarkCorrectionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  withdraw(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MarkCorrectionDto> {
    return this.corrections.withdraw(session, id, body.reason);
  }
}
