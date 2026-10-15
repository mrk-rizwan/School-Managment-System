import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { DefaultPasswordInert, RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { ImportFileInterceptor, importFile } from './import-upload';
import {
  ImportDetailDto,
  ImportDto,
  ListImportsQueryDto,
  OpeningBalancesImportDto,
  OpeningBalancesUploadDto,
  PastResultsImportDto,
  PastResultsUploadDto,
} from './imports.dto';
import { ImportsService, type ImportOutcome } from './imports.service';

// Phase 5 slice 43 (contracts/slice-43.md §1). Common to every route: 401, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 426 (bearer), 429. Past results: result.publish (route) + assessment.define
// (service); opening balances: charge.create (route) + the principal role (service), rule-24 inert.

const COMMON = [401, 403, 429];

/** Every import write (preview, commit): 5/min, 30/hour per user (§5.1). */
export const ImportWritesThrottleGuard = perUserThrottle('import-writes', 5, 30);

const replayed = (res: Response, outcome: ImportOutcome, created: boolean): ImportDetailDto => {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  } else if (!created) {
    res.status(200);
  }
  return outcome.import;
};

@ApiTags('imports')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** R339: 201 with the preview (row errors included); 200 for a replay of the same key and file. */
  @Post('past-results')
  @RequireCapability(Capability.RESULT_PUBLISH)
  @UseGuards(IdempotencyKeyGuard, ImportWritesThrottleGuard)
  @UseInterceptors(ImportFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: PastResultsUploadDto })
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: ImportDetailDto })
  @ApiOkResponse({ type: ImportDetailDto, description: 'Replay of a committed preview' })
  @ApiErrors(...COMMON, 400, 404, 409, 413, 422)
  async previewPastResults(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: PastResultsImportDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportDetailDto> {
    const outcome = await this.imports.previewPastResults(session, body, importFile(req), req.header(IDEMPOTENCY_HEADER));
    return replayed(res, outcome, true);
  }

  /** R339, R342: 201 with the preview; rule-24 inert (R355). */
  @Post('opening-balances')
  @RequireCapability(Capability.CHARGE_CREATE)
  @DefaultPasswordInert('import.opening_balances')
  @UseGuards(IdempotencyKeyGuard, ImportWritesThrottleGuard)
  @UseInterceptors(ImportFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: OpeningBalancesUploadDto })
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: ImportDetailDto })
  @ApiOkResponse({ type: ImportDetailDto, description: 'Replay of a committed preview' })
  @ApiErrors(...COMMON, 400, 404, 409, 413, 422)
  async previewOpeningBalances(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: OpeningBalancesImportDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportDetailDto> {
    const outcome = await this.imports.previewOpeningBalances(session, body, importFile(req), req.header(IDEMPOTENCY_HEADER));
    return replayed(res, outcome, true);
  }

  /** R340-R342: one transaction; a replay of the same key answers the committed import. */
  @Post(':id/commit')
  @HttpCode(200)
  @RequireCapability(Capability.RESULT_PUBLISH, Capability.CHARGE_CREATE)
  @UseGuards(IdempotencyKeyGuard, ImportWritesThrottleGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiOkResponse({ type: ImportDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  async commit(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportDetailDto> {
    const outcome = await this.imports.commit(session, id, req.header(IDEMPOTENCY_HEADER));
    return replayed(res, outcome, false);
  }

  /** The history, newest first: the kinds the caller may import. */
  @Get()
  @RequireCapability(Capability.RESULT_PUBLISH, Capability.CHARGE_CREATE)
  @ApiPaginated(ImportDto)
  @ApiErrors(...COMMON, 422)
  list(@CurrentSchoolSession() session: SchoolSessionContext, @Query() query: ListImportsQueryDto): Promise<Page<ImportDto>> {
    return this.imports.list(session, query);
  }

  @Get(':id')
  @RequireCapability(Capability.RESULT_PUBLISH, Capability.CHARGE_CREATE)
  @ApiIdParam()
  @ApiOkResponse({ type: ImportDetailDto })
  @ApiErrors(...COMMON, 404)
  get(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<ImportDetailDto> {
    return this.imports.get(session, id);
  }
}
