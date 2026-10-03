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
  CreateSectionDto,
  ListSectionsQueryDto,
  SectionDto,
  UpdateSectionDto,
} from './sections.dto';
import { SectionsService } from './sections.service';

// Common to every route (contracts/slice-3.md §1): 401 AUTH_REQUIRED, 403 PERMISSION_DENIED /
// SCHOOL_SUSPENDED / ORIGIN_REJECTED, 429 RATE_LIMITED.
const COMMON = [401, 403, 429];

/** Listed and created under their class; addressed flat by their own id (plan §3.9). */
@ApiTags('sections')
@Controller()
export class SectionsController {
  constructor(private readonly sections: SectionsService) {}

  @Get('classes/:id/sections')
  @RequireStaff()
  @ApiIdParam()
  @ApiPaginated(SectionDto)
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() classId: bigint,
    @Query() query: ListSectionsQueryDto,
  ): Promise<Page<SectionDto>> {
    return this.sections.listForClass(classId, query);
  }

  @Post('classes/:id/sections')
  @RequireCapability(Capability.SECTION_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: SectionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  create(
    @IdParam() classId: bigint,
    @Body() body: CreateSectionDto,
    @Query() _query: NoQueryDto,
  ): Promise<SectionDto> {
    return this.sections.create(classId, body);
  }

  @Get('sections/:id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: SectionDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<SectionDto> {
    return this.sections.get(id);
  }

  @Patch('sections/:id')
  @RequireCapability(Capability.SECTION_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: SectionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateSectionDto,
    @Query() _query: NoQueryDto,
  ): Promise<SectionDto> {
    return this.sections.update(id, body);
  }

  @Post('sections/:id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.SECTION_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: SectionDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archive(
    @IdParam() id: bigint,
    @Body() body: ArchiveDto,
    @Query() _query: NoQueryDto,
  ): Promise<SectionDto> {
    return this.sections.archive(id, body);
  }
}
