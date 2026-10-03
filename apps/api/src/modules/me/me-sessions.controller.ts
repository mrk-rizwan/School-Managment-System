import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { AuthenticatedOnly } from '../../common/auth/route-access';
import {
  CurrentSchoolSession,
  presentedSchoolToken,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { DeviceDto, RegisterDeviceDto, SessionsRevokedDto } from './me-sessions.dto';
import { MeSessionsService } from './me-sessions.service';
import { DevicesThrottleGuard, RevokeSessionsThrottleGuard } from './me-throttles';

/**
 * contracts/slice-9.md §3.5: a push address belongs to a bearer session. A guard, so a cookie
 * session is refused before the body is validated, as the contract orders it.
 */
@Injectable()
class BearerSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (presentedSchoolToken(context.switchToHttp().getRequest<Request>()).kind !== 'bearer') {
      throw new ApiException(
        409,
        ErrorCode.BEARER_SESSION_REQUIRED,
        'Only the mobile app can register a device.',
      );
    }
    return true;
  }
}

/** The caller's own sessions and devices (contracts/slice-9.md §3.5, §3.6). Any capacity. */
@ApiTags('me')
@Controller('me')
@AuthenticatedOnly()
export class MeSessionsController {
  constructor(private readonly service: MeSessionsService) {}

  @Post('devices')
  @HttpCode(200)
  @UseGuards(BearerSessionGuard, DevicesThrottleGuard)
  @ApiCreatedResponse({ type: DeviceDto, description: 'Registered for this session.' })
  @ApiOkResponse({ type: DeviceDto, description: 'Refreshed.' })
  @ApiErrors(401, 403, 409, 422, 426, 429, 503)
  async registerDevice(
    @Body() body: RegisterDeviceDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeviceDto> {
    // Always present and well-formed here: a bearer request without it is 426 (R161).
    const appVersion = req.headers['x-app-version'];
    if (typeof appVersion !== 'string') {
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    const { created, device } = await this.service.register(session, body, appVersion);
    if (created) res.status(201);
    return device;
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(RevokeSessionsThrottleGuard)
  @ApiOkResponse({ type: SessionsRevokedDto })
  @ApiErrors(401, 403, 422, 426, 429, 503)
  revokeOthers(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SessionsRevokedDto> {
    return this.service.revokeOthers(session);
  }
}
