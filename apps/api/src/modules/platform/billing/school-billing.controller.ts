import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import { AssignPlanDto, SchoolBillingDto, SubscriptionDto } from './billing.dto';
import { ReasonDto } from '../../../common/reason.dto';
import { SchoolBillingService } from './school-billing.service';

const COMMON = [401, 403, 429];

/** contracts/slice-26.md §1.2 (R223, A12): a school's plan, cap and invoices. */
@ApiTags('platform: billing')
@Controller('platform/schools')
export class SchoolBillingController {
  constructor(private readonly billing: SchoolBillingService) {}

  @Get(':id/billing')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolBillingDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<SchoolBillingDto> {
    return this.billing.get(id);
  }

  @Post(':id/assign-plan')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  assign(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: AssignPlanDto,
    @Query() _query: NoQueryDto,
  ): Promise<SubscriptionDto> {
    return this.billing.assign(session.userId, id, body);
  }

  @Post(':id/unpin-plan')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolBillingDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  unpin(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolBillingDto> {
    return this.billing.unpin(session.userId, id, body.reason);
  }

  /** A12: clears a manual SMS cap override; the cap becomes the live plan's allowance. */
  @Post(':id/use-plan-allowance')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolBillingDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  usePlanAllowance(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolBillingDto> {
    return this.billing.usePlanAllowance(session.userId, id);
  }
}
