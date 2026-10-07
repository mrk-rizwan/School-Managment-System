import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability } from '../../common/auth/route-access';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { FINANCE_READERS } from '../access/money-gates';
import { FeeHeadsService } from './fee-heads.service';
import { FeeStructuresService } from './fee-structures.service';
import {
  CopyFeeStructuresDto,
  CopyFeeStructuresResultDto,
  CreateFeeHeadDto,
  CreateFeeStructureDto,
  FeeHeadDto,
  FeeStructureClassDto,
  FeeStructureDto,
  ListFeeHeadsQueryDto,
  ListFeeStructuresQueryDto,
  UpdateFeeHeadDto,
} from './fees.dto';
import { ReasonDto } from '../../common/reason.dto';

// Common to every route: 401 AUTH_REQUIRED, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429.
const COMMON = [401, 403, 429];

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/** Fee heads (phase-3-financial.md slice 18, R176). Teachers reach none of it (R234). */
@ApiTags('fees')
@Controller('fee-heads')
export class FeeHeadsController {
  constructor(private readonly heads: FeeHeadsService) {}

  @Get()
  @RequireCapability(...FINANCE_READERS)
  @ApiPaginated(FeeHeadDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListFeeHeadsQueryDto): Promise<Page<FeeHeadDto>> {
    return this.heads.list(query);
  }

  @Post()
  @RequireCapability(Capability.FEE_HEAD_MANAGE)
  @ApiCreatedResponse({ type: FeeHeadDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateFeeHeadDto, @Query() _query: NoQueryDto): Promise<FeeHeadDto> {
    return this.heads.create(body);
  }

  @Get(':id')
  @RequireCapability(...FINANCE_READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: FeeHeadDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<FeeHeadDto> {
    return this.heads.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.FEE_HEAD_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: FeeHeadDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateFeeHeadDto,
    @Query() _query: NoQueryDto,
  ): Promise<FeeHeadDto> {
    return this.heads.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.FEE_HEAD_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: FeeHeadDto })
  @ApiErrors(...COMMON, 404, 422)
  archive(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<FeeHeadDto> {
    return this.heads.archive(id, body);
  }
}

/** Fee structures (slice 18, R177). */
@ApiTags('fees')
@Controller('fee-structures')
export class FeeStructuresController {
  constructor(private readonly structures: FeeStructuresService) {}

  @Get()
  @RequireCapability(...FINANCE_READERS)
  @ApiPaginated(FeeStructureClassDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListFeeStructuresQueryDto): Promise<Page<FeeStructureClassDto>> {
    return this.structures.list(query);
  }

  @Post()
  @RequireCapability(Capability.FEE_HEAD_MANAGE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: FeeStructureDto })
  @ApiOkResponse({ type: FeeStructureDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateFeeStructureDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FeeStructureDto> {
    const outcome = await this.structures.create(body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.structure;
  }

  @Post('copy')
  @HttpCode(200)
  @RequireCapability(Capability.FEE_HEAD_MANAGE)
  @ApiOkResponse({ type: CopyFeeStructuresResultDto })
  @ApiErrors(...COMMON, 409, 422)
  copy(@Body() body: CopyFeeStructuresDto, @Query() _query: NoQueryDto): Promise<CopyFeeStructuresResultDto> {
    return this.structures.copy(body);
  }
}
