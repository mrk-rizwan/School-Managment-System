import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { SchoolSettingsDto, UpdateSchoolSettingsDto } from './school-settings.dto';
import { SchoolSettingsService } from './school-settings.service';

/** contracts/slice-2.md §6. */
@ApiTags('school settings')
@Controller('school/settings')
@RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
export class SchoolSettingsController {
  constructor(private readonly settings: SchoolSettingsService) {}

  @Get()
  @ApiOkResponse({ type: SchoolSettingsDto })
  @ApiErrors(401, 403)
  get(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SchoolSettingsDto> {
    return this.settings.get(session.schoolId);
  }

  @Patch()
  @ApiOkResponse({ type: SchoolSettingsDto })
  @ApiErrors(401, 403, 422)
  update(
    @Body() body: UpdateSchoolSettingsDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SchoolSettingsDto> {
    return this.settings.update(session, body);
  }
}
