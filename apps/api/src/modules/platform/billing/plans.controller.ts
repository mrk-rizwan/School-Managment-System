import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { NoQueryDto } from '../../../common/validation';
import { CreatePlanDto, ListPlansQueryDto, PlanDto, UpdatePlanDto } from './billing.dto';
import { ReasonDto } from '../../../common/reason.dto';
import { PlansService } from './plans.service';

const COMMON = [401, 403, 429];

/** contracts/slice-26.md §1.1 (R219). */
@ApiTags('platform: billing')
@Controller('platform/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @PlatformSession('full')
  @ApiPaginated(PlanDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListPlansQueryDto): Promise<Page<PlanDto>> {
    return this.plans.list(query);
  }

  @Post()
  @PlatformSession('full')
  @ApiCreatedResponse({ type: PlanDto })
  @ApiErrors(...COMMON, 409, 422)
  create(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Body() body: CreatePlanDto,
    @Query() _query: NoQueryDto,
  ): Promise<PlanDto> {
    return this.plans.create(session.userId, body);
  }

  @Get(':id')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: PlanDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PlanDto> {
    return this.plans.get(id);
  }

  @Patch(':id')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: PlanDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: UpdatePlanDto,
    @Query() _query: NoQueryDto,
  ): Promise<PlanDto> {
    return this.plans.update(session.userId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: PlanDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archive(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<PlanDto> {
    return this.plans.archive(session.userId, id, body.reason);
  }
}
