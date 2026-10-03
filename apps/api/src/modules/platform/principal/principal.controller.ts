import { Body, Controller, HttpCode, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import { IssuedPrincipalLoginDto, IssuePrincipalLoginDto } from './principal.dto';
import { PrincipalLoginService } from './principal.service';

/** contracts/slice-2.md §7. */
@ApiTags('platform schools')
@Controller('platform/schools')
export class PrincipalLoginController {
  constructor(private readonly principals: PrincipalLoginService) {}

  @Post(':id/issue-principal-login')
  @HttpCode(201)
  @PlatformSession()
  @ApiIdParam()
  @ApiCreatedResponse({ type: IssuedPrincipalLoginDto })
  @ApiErrors(401, 403, 404, 409, 422)
  issue(
    @IdParam() id: bigint,
    @Body() body: IssuePrincipalLoginDto,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<IssuedPrincipalLoginDto> {
    return this.principals.issue(session.userId, id, body);
  }
}
