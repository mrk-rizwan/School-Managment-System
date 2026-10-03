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
import {
  ChangeSchoolStatusDto,
  CreateSchoolDto,
  ListSchoolsQueryDto,
  SchoolDto,
  UpdateSchoolDto,
} from './schools.dto';
import { SchoolsService } from './schools.service';

// Common to every schools route (contract section 4): 401 AUTH_REQUIRED, 403 TOTP_REQUIRED /
// PASSWORD_CHANGE_REQUIRED / ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

@ApiTags('platform: schools')
@Controller('platform/schools')
export class SchoolsController {
  constructor(private readonly schools: SchoolsService) {}

  @Get()
  @PlatformSession('full')
  @ApiPaginated(SchoolDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListSchoolsQueryDto): Promise<Page<SchoolDto>> {
    return this.schools.list(query);
  }

  @Post()
  @PlatformSession('full')
  @ApiCreatedResponse({ type: SchoolDto })
  @ApiErrors(...COMMON, 409, 422)
  create(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Body() body: CreateSchoolDto,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolDto> {
    return this.schools.create(session.userId, body);
  }

  @Get(':id')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<SchoolDto> {
    return this.schools.get(id);
  }

  @Patch(':id')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: UpdateSchoolDto,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolDto> {
    return this.schools.update(session.userId, id, body);
  }

  @Post(':id/change-status')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  changeStatus(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: ChangeSchoolStatusDto,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolDto> {
    return this.schools.changeStatus(session.userId, id, body);
  }
}
