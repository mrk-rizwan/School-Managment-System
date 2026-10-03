import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthenticatedOnly } from '../../common/auth/route-access';
import {
  CurrentSchoolSession,
  setSchoolCookie,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { CredentialsService } from './credentials.service';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { ChangeEmailDto, ChangePasswordDto, LoginResultDto, MeDto } from './dto';
import { SchoolSessionThrottleGuard } from './login-limits';
import { loginResult, MeService, metaOf } from './me.service';

/** contracts/slice-2.md §4: the signed-in user's own account. Any capacity may call these. */
@ApiTags('me')
@Controller('me')
@AuthenticatedOnly()
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly credentials: CredentialsService,
  ) {}

  @Get()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401, 426, 429, 503)
  get(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MeDto> {
    return this.me.build(session.schoolId, session.access.userId, session.access, session.expiresAt);
  }

  @Post('change-email')
  @HttpCode(200)
  @UseGuards(SchoolSessionThrottleGuard)
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401, 403, 409, 422, 429, 503)
  changeEmail(
    @Body() body: ChangeEmailDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MeDto> {
    return this.credentials.changeEmail(session, body);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(SchoolSessionThrottleGuard)
  @ApiOkResponse({ type: LoginResultDto })
  @ApiErrors(401, 403, 409, 422, 426, 429, 503)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    const issued = await this.credentials.changePassword(session, body, metaOf(req));
    // R153: rotation on the caller's channel; the bearer token in the body, the cookie otherwise.
    if (issued.channel === 'cookie') setSchoolCookie(res, issued.token, issued.expiresAt);
    return loginResult(issued);
  }
}
