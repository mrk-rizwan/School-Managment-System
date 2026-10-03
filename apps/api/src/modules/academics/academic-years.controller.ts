import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import {
  AcademicYearDto,
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
} from './academic-years.dto';
import { AcademicYearsService } from './academic-years.service';

// Common to every route (contracts/slice-3.md §1): 401 AUTH_REQUIRED, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

@ApiTags('academic years')
@Controller('academic-years')
export class AcademicYearsController {
  constructor(private readonly years: AcademicYearsService) {}

  @Get()
  @RequireStaff()
  @ApiPaginated(AcademicYearDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListAcademicYearsQueryDto): Promise<Page<AcademicYearDto>> {
    return this.years.list(query);
  }

  @Post()
  @RequireCapability(Capability.ACADEMIC_YEAR_MANAGE)
  @ApiCreatedResponse({ type: AcademicYearDto })
  @ApiErrors(...COMMON, 409, 422)
  create(
    @Body() body: CreateAcademicYearDto,
    @Query() _query: NoQueryDto,
  ): Promise<AcademicYearDto> {
    return this.years.create(body);
  }

  @Get(':id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: AcademicYearDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<AcademicYearDto> {
    return this.years.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.ACADEMIC_YEAR_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: AcademicYearDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateAcademicYearDto,
    @Query() _query: NoQueryDto,
  ): Promise<AcademicYearDto> {
    return this.years.update(id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequireCapability(Capability.ACADEMIC_YEAR_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: AcademicYearDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  activate(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<AcademicYearDto> {
    return this.years.activate(id);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequireCapability(Capability.ACADEMIC_YEAR_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: AcademicYearDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  close(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<AcademicYearDto> {
    return this.years.close(id);
  }
}
