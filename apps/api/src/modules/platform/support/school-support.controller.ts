import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../../common/pagination';
import { ReasonDto } from '../../../common/reason.dto';
import { SchoolContext } from '../../../common/school-context';
import { NoQueryDto } from '../../../common/validation';
import { SupportSessionsService } from './support-sessions.service';
import { SchoolSupportSessionDto } from './support.dto';

// Phase 5 slice 45 (contracts/slice-45.md §1): the school's side of platform support access, in
// the school OpenAPI document (SchoolSupportModule is imported by AppModule, not PlatformModule).
// It lives beside the platform routes because only src/modules/platform/support/** may touch the
// support-session repository (eslint.config.mjs, R353); every read here is keyed by the session's
// SchoolId.

@ApiTags('support sessions')
@Controller('school/support-sessions')
export class SchoolSupportController {
  constructor(
    private readonly context: SchoolContext,
    private readonly sessions: SupportSessionsService,
  ) {}

  @Get()
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiPaginated(SchoolSupportSessionDto)
  @ApiErrors(401, 403, 422)
  list(@Query() query: PageQueryDto): Promise<Page<SchoolSupportSessionDto>> {
    return this.sessions.listForSchool(this.context.schoolId, query);
  }

  /** R349: the school ends support access now; the next support read answers 403 (R352). */
  @Post(':id/revoke')
  @HttpCode(200)
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: SchoolSupportSessionDto })
  @ApiErrors(401, 403, 404, 422)
  revoke(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<SchoolSupportSessionDto> {
    const { schoolId, userId } = this.context.actor();
    return this.sessions.revoke(schoolId, userId, id, body.reason);
  }
}
