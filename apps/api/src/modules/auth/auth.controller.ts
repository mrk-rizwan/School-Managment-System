import { Body, Controller, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AllowWhenSuspended, AuthenticatedOnly, Public } from '../../common/auth/route-access';
import {
  clearSchoolCookie,
  CurrentSchoolSession,
  setSchoolCookie,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { SessionRepository } from '../../repositories/session.repository';
import { CredentialsService } from './credentials.service';
import { ForgotPasswordDto, MeDto, ResetPasswordDto, SchoolLoginDto, VerifyEmailDto } from './dto';
import { ForgotPasswordThrottleGuard, SchoolLoginThrottleGuard, TokenThrottleGuard } from './login-limits';
import { LoginService } from './login.service';
import { metaOf } from './me.service';

/** The empty 202 body of forgot-password: identical whatever happened (R2). */
class AcceptedDto {}

/**
 * contracts/slice-2.md §3. The public routes skip the global throttler: their own limits
 * (Redis, per account and per IP) replace it, so an unreachable Redis is their 503.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginService,
    private readonly credentials: CredentialsService,
    private readonly sessions: SessionRepository,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @SkipThrottle()
  @UseGuards(SchoolLoginThrottleGuard)
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401, 403, 422, 429, 503)
  async signIn(
    @Body() body: SchoolLoginDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeDto> {
    const issued = await this.login.login(body, req, metaOf(req));
    setSchoolCookie(res, issued.token, issued.expiresAt);
    return issued.me;
  }

  @Post('logout')
  @HttpCode(204)
  @AuthenticatedOnly()
  @AllowWhenSuspended()
  @ApiNoContentResponse()
  @ApiErrors(401, 403)
  async signOut(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revoke(session.schoolId, session.sessionId, new Date());
    clearSchoolCookie(res);
  }

  @Post('forgot-password')
  @HttpCode(202)
  @Public()
  @SkipThrottle()
  @UseGuards(ForgotPasswordThrottleGuard)
  @ApiAcceptedResponse({ type: AcceptedDto })
  @ApiErrors(403, 422, 429, 503)
  forgotPassword(@Body() body: ForgotPasswordDto, @Query() _query: NoQueryDto): AcceptedDto {
    // Answered before any lookup; the work runs after the response (R2).
    void this.credentials.forgotInBackground(body);
    return {};
  }

  @Post('reset-password')
  @HttpCode(204)
  @Public()
  @SkipThrottle()
  @UseGuards(TokenThrottleGuard)
  @ApiNoContentResponse()
  @ApiErrors(403, 409, 422, 429, 503)
  async resetPassword(@Body() body: ResetPasswordDto, @Query() _query: NoQueryDto): Promise<void> {
    await this.credentials.resetPassword(body);
  }

  @Post('verify-email')
  @HttpCode(204)
  @Public()
  @SkipThrottle()
  @UseGuards(TokenThrottleGuard)
  @ApiNoContentResponse()
  @ApiErrors(403, 409, 422, 429, 503)
  async verifyEmail(@Body() body: VerifyEmailDto, @Query() _query: NoQueryDto): Promise<void> {
    await this.credentials.verifyEmail(body);
  }
}
