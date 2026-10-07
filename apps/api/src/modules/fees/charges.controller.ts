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
import { NoQueryDto } from '../../common/validation';
import {
  CampaignDto,
  CampaignPreviewDto,
  CancelCampaignDto,
  CreateCampaignDto,
  ListCampaignsQueryDto,
  PreviewCampaignTargetsDto,
  UpdateCampaignDto,
} from './campaigns.dto';
import { CampaignsService } from './campaigns.service';
import {
  AdjustChargeDto,
  ApproveConcessionDto,
  ChargeDto,
  ChargeRunDto,
  ConcessionDecisionDto,
  ConcessionDto,
  CreateChargeDto,
  CreateConcessionDto,
  GenerateMonthDto,
  ListChargeRunsQueryDto,
  ListChargesQueryDto,
  ListConcessionsQueryDto,
  StatementDto,
  StatementQueryDto,
} from './charges.dto';
import { ChargesService } from './charges.service';
import { ConcessionsService } from './concessions.service';
import { ReasonDto } from '../../common/reason.dto';

// phase-3-financial.md slice 19 (contracts/slice-19.md §1). Common to every route: 401 AUTH_REQUIRED,
// 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429. Teachers reach none of it (R234).
const COMMON = [401, 403, 429];

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function replayed(res: Response, outcome: { replayed: boolean }): void {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
}

@ApiTags('charges')
@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  // Static paths first: `generation-runs` is not an id.

  @Post('generate-month')
  @RequireCapability(Capability.CHARGE_CREATE)
  @ApiCreatedResponse({ type: ChargeRunDto })
  @ApiOkResponse({ type: ChargeRunDto, description: 'A run for that year and month is already queued or running' })
  @ApiErrors(...COMMON, 409, 422)
  async generateMonth(
    @Body() body: GenerateMonthDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChargeRunDto> {
    const outcome = await this.charges.generateMonth(session, body);
    res.status(outcome.created ? 201 : 200);
    return outcome.run;
  }

  @Get('generation-runs')
  @RequireCapability(Capability.CHARGE_CREATE, Capability.FINANCE_REPORT_VIEW)
  @ApiPaginated(ChargeRunDto)
  @ApiErrors(...COMMON, 422)
  listRuns(@Query() query: ListChargeRunsQueryDto): Promise<Page<ChargeRunDto>> {
    return this.charges.listRuns(query);
  }

  @Get('generation-runs/:id')
  @RequireCapability(Capability.CHARGE_CREATE, Capability.FINANCE_REPORT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: ChargeRunDto })
  @ApiErrors(...COMMON, 404, 422)
  getRun(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ChargeRunDto> {
    return this.charges.getRun(id);
  }

  @Get()
  @RequireCapability(Capability.FEE_STATEMENT_VIEW, Capability.CHARGE_CREATE)
  @ApiPaginated(ChargeDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListChargesQueryDto): Promise<Page<ChargeDto>> {
    return this.charges.list(query);
  }

  @Post()
  @RequireCapability(Capability.CHARGE_CREATE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: ChargeDto })
  @ApiOkResponse({ type: ChargeDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateChargeDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChargeDto> {
    const outcome = await this.charges.create(body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.charge;
  }

  @Get(':id')
  @RequireCapability(Capability.FEE_STATEMENT_VIEW, Capability.CHARGE_CREATE)
  @ApiIdParam()
  @ApiOkResponse({ type: ChargeDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ChargeDto> {
    return this.charges.get(id);
  }

  /** charge.create for manual and campaign charges; concession.grant + principal otherwise. */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.CHARGE_CREATE, Capability.CONCESSION_GRANT)
  @ApiIdParam()
  @ApiOkResponse({ type: ChargeDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ChargeDto> {
    return this.charges.void(session, id, body);
  }

  @Post(':id/waive')
  @HttpCode(200)
  @RequireCapability(Capability.CONCESSION_GRANT)
  @ApiIdParam()
  @ApiOkResponse({ type: ChargeDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  waive(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ChargeDto> {
    return this.charges.waive(session, id, body);
  }

  @Post(':id/adjust')
  @RequireCapability(Capability.CONCESSION_GRANT)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: ChargeDto, description: 'The adjustment (credit) row' })
  @ApiOkResponse({ type: ChargeDto, description: 'Replay of a committed adjustment' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async adjust(
    @IdParam() id: bigint,
    @Body() body: AdjustChargeDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChargeDto> {
    const outcome = await this.charges.adjust(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.charge;
  }
}

@ApiTags('charges')
@Controller('students')
export class FeeStatementController {
  constructor(private readonly charges: ChargesService) {}

  @Get(':id/fee-statement')
  @RequireCapability(Capability.FEE_STATEMENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StatementDto })
  @ApiErrors(...COMMON, 404, 422)
  statement(@IdParam() id: bigint, @Query() query: StatementQueryDto): Promise<StatementDto> {
    return this.charges.statement(id, query);
  }
}

@ApiTags('concessions')
@Controller('concessions')
export class ConcessionsController {
  constructor(private readonly concessions: ConcessionsService) {}

  @Get()
  @RequireCapability(Capability.CONCESSION_GRANT, Capability.CHARGE_CREATE)
  @ApiPaginated(ConcessionDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListConcessionsQueryDto): Promise<Page<ConcessionDto>> {
    return this.concessions.list(query);
  }

  @Post()
  @RequireCapability(Capability.CHARGE_CREATE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: ConcessionDto })
  @ApiOkResponse({ type: ConcessionDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateConcessionDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConcessionDto> {
    const outcome = await this.concessions.create(session, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.concession;
  }

  @Get(':id')
  @RequireCapability(Capability.CONCESSION_GRANT, Capability.CHARGE_CREATE)
  @ApiIdParam()
  @ApiOkResponse({ type: ConcessionDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ConcessionDto> {
    return this.concessions.get(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.CONCESSION_GRANT)
  @ApiIdParam()
  @ApiOkResponse({ type: ConcessionDecisionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  approve(
    @IdParam() id: bigint,
    @Body() body: ApproveConcessionDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ConcessionDecisionDto> {
    return this.concessions.approve(session, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.CONCESSION_GRANT)
  @ApiIdParam()
  @ApiOkResponse({ type: ConcessionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ConcessionDto> {
    return this.concessions.reject(session, id, body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequireCapability(Capability.CONCESSION_GRANT)
  @ApiIdParam()
  @ApiOkResponse({ type: ConcessionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  end(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ConcessionDto> {
    return this.concessions.end(session, id, body);
  }
}

@ApiTags('charge-campaigns')
@Controller('charge-campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiPaginated(CampaignDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListCampaignsQueryDto): Promise<Page<CampaignDto>> {
    return this.campaigns.list(query);
  }

  @Post()
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: CampaignDto })
  @ApiOkResponse({ type: CampaignDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateCampaignDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CampaignDto> {
    const outcome = await this.campaigns.create(session, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.campaign;
  }

  @Post('preview-targets')
  @HttpCode(200)
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiOkResponse({ type: CampaignPreviewDto })
  @ApiErrors(...COMMON, 409, 422)
  preview(@Body() body: PreviewCampaignTargetsDto, @Query() _query: NoQueryDto): Promise<CampaignPreviewDto> {
    return this.campaigns.preview(body);
  }

  @Get(':id')
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: CampaignDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<CampaignDto> {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: CampaignDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateCampaignDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CampaignDto> {
    return this.campaigns.update(session, id, body);
  }

  @Post(':id/generate')
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiIdParam()
  @ApiCreatedResponse({ type: ChargeRunDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  generate(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ChargeRunDto> {
    return this.campaigns.generate(session, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireCapability(Capability.CHARGE_CAMPAIGN_SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: CampaignDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  cancel(
    @IdParam() id: bigint,
    @Body() body: CancelCampaignDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CampaignDto> {
    return this.campaigns.cancel(session, id, body);
  }
}
