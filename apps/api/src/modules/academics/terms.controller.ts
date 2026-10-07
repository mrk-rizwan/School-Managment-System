import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { ResultSettingsDto, UpdateResultSettingsDto } from './result-settings.dto';
import { ResultSettingsService } from './result-settings.service';
import { CreateTermDto, ListTermsQueryDto, SkipClassDto, TermDto, UpdateTermDto } from './terms.dto';
import { TermsService } from './terms.service';

// Common to every route (contracts/slice-29.md §1): 401 AUTH_REQUIRED, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

/** Terms and result settings of an academic year (phase-4-academic.md slice 29). */
@ApiTags('terms and results')
@Controller()
export class TermsController {
  constructor(
    private readonly terms: TermsService,
    private readonly settings: ResultSettingsService,
  ) {}

  @Get('academic-years/:id/terms')
  @RequireStaff()
  @ApiIdParam()
  @ApiPaginated(TermDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@IdParam() id: bigint, @Query() query: ListTermsQueryDto): Promise<Page<TermDto>> {
    return this.terms.list(id, query);
  }

  @Post('academic-years/:id/terms')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: TermDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  create(@IdParam() id: bigint, @Body() body: CreateTermDto, @Query() _query: NoQueryDto): Promise<TermDto> {
    return this.terms.create(id, body);
  }

  @Patch('terms/:id')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: TermDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(@IdParam() id: bigint, @Body() body: UpdateTermDto, @Query() _query: NoQueryDto): Promise<TermDto> {
    return this.terms.update(id, body);
  }

  @Post('terms/:id/skip-class')
  @HttpCode(200)
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: TermDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  skipClass(@IdParam() id: bigint, @Body() body: SkipClassDto, @Query() _query: NoQueryDto): Promise<TermDto> {
    return this.terms.skipClass(id, body);
  }

  @Post('terms/:id/unskip-class')
  @HttpCode(200)
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: TermDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  unskipClass(@IdParam() id: bigint, @Body() body: SkipClassDto, @Query() _query: NoQueryDto): Promise<TermDto> {
    return this.terms.unskipClass(id, body);
  }

  @Get('academic-years/:id/result-settings')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSettingsDto })
  @ApiErrors(...COMMON, 404, 422)
  getSettings(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ResultSettingsDto> {
    return this.settings.get(id);
  }

  @Patch('academic-years/:id/result-settings')
  @RequireCapability(Capability.ASSESSMENT_DEFINE)
  @ApiIdParam()
  @ApiOkResponse({ type: ResultSettingsDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  updateSettings(
    @IdParam() id: bigint,
    @Body() body: UpdateResultSettingsDto,
    @Query() _query: NoQueryDto,
  ): Promise<ResultSettingsDto> {
    return this.settings.update(id, body);
  }
}
