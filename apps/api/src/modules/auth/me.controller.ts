import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AllowWhenSuspended, AuthenticatedOnly } from '../../common/auth/route-access';
import {
  CurrentSchoolSession,
  setSchoolCookie,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { CredentialsService } from './credentials.service';
import { ChangeEmailDto, ChangePasswordDto, MeDto } from './dto';
import { SchoolSessionThrottleGuard } from './login-limits';
import { MeService, metaOf } from './me.service';

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
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401)
  get(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MeDto> {
    return this.me.build(session.schoolId, session.access.userId, session.access, session.expiresAt);
  }

  @Post('change-email')
  @HttpCode(200)
  @AllowWhenSuspended()
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
  @AllowWhenSuspended()
  @UseGuards(SchoolSessionThrottleGuard)
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401, 403, 409, 422, 429, 503)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeDto> {
    const issued = await this.credentials.changePassword(session, body, metaOf(req));
    setSchoolCookie(res, issued.token, issued.expiresAt);
    return issued.me;
  }
}
