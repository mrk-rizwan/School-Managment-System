import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import { PlatformSettingsDto, UpdatePlatformSettingsDto } from './platform-settings.dto';
import { PlatformSettingsService } from './platform-settings.service';

const COMMON = [401, 403, 429];

@ApiTags('platform: settings')
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(private readonly service: PlatformSettingsService) {}

  @Get()
  @PlatformSession('full')
  @ApiOkResponse({ type: PlatformSettingsDto })
  @ApiErrors(...COMMON, 422)
  get(@Query() _query: NoQueryDto): Promise<PlatformSettingsDto> {
    return this.service.get();
  }

  @Patch()
  @PlatformSession('full')
  @ApiOkResponse({ type: PlatformSettingsDto })
  @ApiErrors(...COMMON, 422)
  update(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Body() body: UpdatePlatformSettingsDto,
    @Query() _query: NoQueryDto,
  ): Promise<PlatformSettingsDto> {
    return this.service.update(session.userId, body);
  }
}
