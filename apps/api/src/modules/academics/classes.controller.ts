import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { ArchiveDto } from './academics.shared';
import {
  ClassDto,
  CopySectionsDto,
  CopySectionsResultDto,
  CreateClassDto,
  ListClassesQueryDto,
  UpdateClassDto,
} from './classes.dto';
import { ClassesService } from './classes.service';

// Common to every route (contracts/slice-3.md §1): 401 AUTH_REQUIRED, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

@ApiTags('classes')
@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  @RequireStaff()
  @ApiPaginated(ClassDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListClassesQueryDto): Promise<Page<ClassDto>> {
    return this.classes.list(query);
  }

  @Post()
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiCreatedResponse({ type: ClassDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateClassDto, @Query() _query: NoQueryDto): Promise<ClassDto> {
    return this.classes.create(body);
  }

  @Get(':id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: ClassDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ClassDto> {
    return this.classes.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: ClassDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateClassDto,
    @Query() _query: NoQueryDto,
  ): Promise<ClassDto> {
    return this.classes.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: ClassDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archive(
    @IdParam() id: bigint,
    @Body() body: ArchiveDto,
    @Query() _query: NoQueryDto,
  ): Promise<ClassDto> {
    return this.classes.archive(id, body);
  }

  @Post(':id/copy-sections')
  @HttpCode(200)
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: CopySectionsResultDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  copySections(
    @IdParam() id: bigint,
    @Body() body: CopySectionsDto,
    @Query() _query: NoQueryDto,
  ): Promise<CopySectionsResultDto> {
    return this.classes.copySections(id, body);
  }
}
