import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  clearPlatformCookie,
  CurrentPlatformSession,
  presentedPlatformTokenHash,
  setPlatformCookie,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession, Public } from '../../../common/auth/route-access';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import {
  ChangePlatformPasswordDto,
  ConfirmTotpDto,
  PlatformLoginDto,
  PlatformMeDto,
  TotpEnrolmentDto,
} from './dto';
import { LoginThrottleGuard, SessionThrottleGuard } from './login-limits';
import { PlatformAuthService, type IssuedSession, type RequestMeta } from './platform-auth.service';

function metaOf(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
    presentedTokenHash: presentedPlatformTokenHash(req),
  };
}

/** The token goes into the cookie only; the body carries PlatformMeDto. */
function issue(res: Response, issued: IssuedSession): PlatformMeDto {
  setPlatformCookie(res, issued.token);
  return issued.me;
}

/** contracts/slice-1.md §3. Every route here is @Public (login only) or @PlatformSession. */
@ApiTags('platform auth')
@Controller('platform')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  @Public()
  // The login limits (LoginThrottleGuard, per IP included) replace the global one here, so an
  // unreachable Redis is a 503 from them rather than a 500 from the global guard.
  @SkipThrottle()
  @UseGuards(LoginThrottleGuard)
  @ApiOkResponse({ type: PlatformMeDto })
  @ApiErrors(401, 403, 422, 429, 503)
  async login(
    @Body() body: PlatformLoginDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformMeDto> {
    return issue(res, await this.auth.login(body, metaOf(req)));
  }

  @Get('me')
  @PlatformSession('any')
  @ApiOkResponse({ type: PlatformMeDto })
  @ApiErrors(401)
  me(
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): PlatformMeDto {
    return this.auth.me(session);
  }

  @Post('auth/logout')
  @HttpCode(204)
  @PlatformSession('any')
  @ApiNoContentResponse()
  @ApiErrors(401, 403)
  async logout(
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(session);
    clearPlatformCookie(res);
  }

  @Post('auth/totp/enrol')
  @HttpCode(200)
  @PlatformSession('any')
  @ApiOkResponse({ type: TotpEnrolmentDto })
  @ApiErrors(401, 403, 409)
  enrol(
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<TotpEnrolmentDto> {
    return this.auth.enrolTotp(session);
  }

  @Post('auth/totp/confirm')
  @HttpCode(200)
  @PlatformSession('any')
  @UseGuards(SessionThrottleGuard)
  @ApiOkResponse({ type: PlatformMeDto })
  @ApiErrors(401, 403, 409, 422, 429)
  async confirm(
    @Body() body: ConfirmTotpDto,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformMeDto> {
    return issue(res, await this.auth.confirmTotp(session, body.code, metaOf(req)));
  }

  @Post('auth/change-password')
  @HttpCode(200)
  @PlatformSession('password-change')
  @UseGuards(SessionThrottleGuard)
  @ApiOkResponse({ type: PlatformMeDto })
  @ApiErrors(401, 403, 409, 422, 429)
  async changePassword(
    @Body() body: ChangePlatformPasswordDto,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformMeDto> {
    return issue(res, await this.auth.changePassword(session, body, metaOf(req)));
  }
}
