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
  CreateSubjectDto,
  ListSubjectsQueryDto,
  SubjectDto,
  UpdateSubjectDto,
} from './subjects.dto';
import { SubjectsService } from './subjects.service';

// Common to every route (contracts/slice-3.md §1): 401 AUTH_REQUIRED, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @RequireStaff()
  @ApiPaginated(SubjectDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListSubjectsQueryDto): Promise<Page<SubjectDto>> {
    return this.subjects.list(query);
  }

  @Post()
  @RequireCapability(Capability.SUBJECT_MANAGE)
  @ApiCreatedResponse({ type: SubjectDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateSubjectDto, @Query() _query: NoQueryDto): Promise<SubjectDto> {
    return this.subjects.create(body);
  }

  @Get(':id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: SubjectDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<SubjectDto> {
    return this.subjects.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.SUBJECT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: SubjectDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateSubjectDto,
    @Query() _query: NoQueryDto,
  ): Promise<SubjectDto> {
    return this.subjects.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.SUBJECT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: SubjectDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archive(
    @IdParam() id: bigint,
    @Body() body: ArchiveDto,
    @Query() _query: NoQueryDto,
  ): Promise<SubjectDto> {
    return this.subjects.archive(id, body);
  }
}
