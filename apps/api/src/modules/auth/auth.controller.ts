import { Body, Controller, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthenticatedOnly, Public } from '../../common/auth/route-access';
import {
  clearSchoolCookie,
  CurrentSchoolSession,
  setSchoolCookie,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { CredentialsService } from './credentials.service';
import { ForgotPasswordDto, LoginResultDto, ResetPasswordDto, SchoolLoginDto, VerifyEmailDto } from './dto';
import { ForgotPasswordThrottleGuard, SchoolLoginThrottleGuard, TokenThrottleGuard } from './login-limits';
import { LoginService } from './login.service';
import { loginResult, metaOf } from './me.service';

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
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @SkipThrottle()
  @UseGuards(SchoolLoginThrottleGuard)
  @ApiOkResponse({ type: LoginResultDto })
  @ApiErrors(401, 403, 422, 426, 429, 503)
  async signIn(
    @Body() body: SchoolLoginDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    // contracts/slice-9.md §3.1 step 3: only the app asks for a bearer session, and it always
    // sends its version (the floor itself was checked before this, in middleware).
    if (body.channel === 'bearer' && req.headers['x-app-version'] === undefined) {
      throw new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
        fields: [{ path: 'channel', code: ErrorCode.INVALID_VALUE, message: 'The app must send its version' }],
      });
    }
    const issued = await this.login.login(body, req, metaOf(req));
    // R153: a cookie client never sees a token in a body; a bearer client never gets a cookie.
    if (issued.channel === 'cookie') setSchoolCookie(res, issued.token, issued.expiresAt);
    return loginResult(issued);
  }

  @Post('logout')
  @HttpCode(204)
  @AuthenticatedOnly()
  @ApiNoContentResponse()
  @ApiErrors(401, 403, 426)
  async signOut(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.login.logout(session);
    if (session.channel === 'cookie') clearSchoolCookie(res);
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
