import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import {
  ListPromotionSheetsQueryDto,
  OpenPromotionSheetDto,
  PromotionSheetDetailDto,
  PromotionSheetDto,
  UpdatePromotionSheetDto,
} from './promotion.dto';
import { PromotionService, type PromotionSheetOutcome } from './promotion.service';

// phase-4-academic.md slice 35; contracts/slice-35.md §1. Every route needs assessment.define.
// Common to every route: 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429. A sheet
// or section outside the caller's scope is 404.
const COMMON = [401, 403, 429];

/** Opening, deciding and applying: 30 a minute, 300 an hour per user. */
export const PromotionWritesThrottleGuard = perUserThrottle('promotion-writes', 30, 300);

/** A keyed write: its status, or 200 with Idempotency-Replayed on a replay. */
function keyed(res: Response, outcome: PromotionSheetOutcome): PromotionSheetDetailDto {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
  return outcome.sheet;
}

@ApiTags('promotion')
@Controller()
export class PromotionController {
  constructor(private readonly promotion: PromotionService) {}

  /** R294: one open sheet per section, proposals from the final (or only held term's) result. */
  @Post('sections/:id/promotion-sheets')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @UseGuards(IdempotencyKeyGuard, PromotionWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: PromotionSheetDetailDto })
  @ApiOkResponse({ type: PromotionSheetDetailDto, description: 'Replay of a committed open' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async open(
    @IdParam() sectionId: bigint,
    @Body() body: OpenPromotionSheetDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionSheetDetailDto> {
    return keyed(res, await this.promotion.open(session, sectionId, body, req.header(IDEMPOTENCY_HEADER)));
  }

  @Get('promotion-sheets')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiPaginated(PromotionSheetDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListPromotionSheetsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<PromotionSheetDto>> {
    return this.promotion.list(session, query);
  }

  @Get('promotion-sheets/:id')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: PromotionSheetDetailDto })
  @ApiErrors(...COMMON, 404)
  detail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PromotionSheetDetailDto> {
    return this.promotion.detail(session, id);
  }

  /** R295: the given rows only; overrides carry reasons. */
  @Patch('promotion-sheets/:id')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @UseGuards(PromotionWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: PromotionSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  decide(
    @IdParam() id: bigint,
    @Body() body: UpdatePromotionSheetDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PromotionSheetDetailDto> {
    return this.promotion.decide(session, id, body);
  }

  /** R297: one transaction; 200 with the applied sheet (also for a replay of the same key). */
  @Post('promotion-sheets/:id/apply')
  @HttpCode(200)
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @UseGuards(IdempotencyKeyGuard, PromotionWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiOkResponse({ type: PromotionSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  async apply(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionSheetDetailDto> {
    return keyed(res, await this.promotion.apply(session, id, req.header(IDEMPOTENCY_HEADER)));
  }

  /** The principal cancels an open sheet, with a reason: its rows stay; the section may open another. */
  @Post('promotion-sheets/:id/cancel')
  @HttpCode(200)
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @UseGuards(PromotionWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: PromotionSheetDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  cancel(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PromotionSheetDetailDto> {
    return this.promotion.cancel(session, id, body.reason);
  }
}
