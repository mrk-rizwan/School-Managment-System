import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { CurrentDevice, type DeviceContext } from '../../common/auth/device-token';
import { DefaultPasswordInert, DeviceToken, RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import {
  DevicePunchBatchDto,
  DevicePunchBatchResultDto,
  DevicePunchDto,
  DeviceTokenDto,
  DeviceTokenRevokedDto,
  ListDevicePunchesQueryDto,
  SetDeviceUserDto,
  StaffDeviceUserDto,
} from './biometric.dto';
import { BiometricService } from './biometric.service';
import { PunchIntakeService } from './punch-intake.service';

// contracts/slice-44.md §1 (R344, R345, R348).
const COMMON = [401, 403, 429];

/** The device token's rotation and the device mapping: 10 a minute, 60 an hour per user. */
export const DeviceAdminThrottleGuard = perUserThrottle('device-admin', 10, 60);

/**
 * The punch route carries no session: the device token names the school (DevicePunchService,
 * named exception 4 widened), with its per-school and per-IP throttles, before this runs.
 */
@Controller('device-punches')
export class DevicePunchesController {
  constructor(
    private readonly intake: PunchIntakeService,
    private readonly biometric: BiometricService,
  ) {}

  @Post()
  @HttpCode(200)
  @DeviceToken()
  @ApiTags('device')
  @ApiOperation({
    summary: 'A biometric device posts punches',
    description:
      'Authorization: Bearer <the school device token>; no cookie, no Origin. Always 200 with one outcome per punch.',
  })
  @ApiOkResponse({ type: DevicePunchBatchResultDto })
  @ApiErrors(401, 422, 429)
  receive(
    @CurrentDevice() device: DeviceContext,
    @Body() body: DevicePunchBatchDto,
    @Query() _query: NoQueryDto,
  ): Promise<DevicePunchBatchResultDto> {
    return this.intake.receive(device.schoolId, body);
  }

  @Get()
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @ApiTags('staff-attendance')
  @ApiPaginated(DevicePunchDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListDevicePunchesQueryDto): Promise<Page<DevicePunchDto>> {
    return this.biometric.listPunches(query);
  }
}

@ApiTags('school settings')
@Controller('school/device-token')
export class DeviceTokenController {
  constructor(private readonly biometric: BiometricService) {}

  /** The token is in this answer only (R344). Rule 24: inert on a default password. */
  @Post('rotate')
  @HttpCode(200)
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @DefaultPasswordInert('device_token.rotate')
  @UseGuards(DeviceAdminThrottleGuard)
  @ApiOkResponse({ type: DeviceTokenDto })
  @ApiErrors(...COMMON)
  rotate(@Query() _query: NoQueryDto): Promise<DeviceTokenDto> {
    return this.biometric.rotate();
  }

  /** "Turn off device": the token stops working at once. Rule 24: inert on a default password. */
  @Post('revoke')
  @HttpCode(200)
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @DefaultPasswordInert('device_token.revoke')
  @UseGuards(DeviceAdminThrottleGuard)
  @ApiOkResponse({ type: DeviceTokenRevokedDto })
  @ApiErrors(...COMMON)
  revoke(@Query() _query: NoQueryDto): Promise<DeviceTokenRevokedDto> {
    return this.biometric.revoke();
  }
}

@ApiTags('staff-attendance')
@Controller('staff')
export class StaffDeviceUserController {
  constructor(private readonly biometric: BiometricService) {}

  /** A11: the device user id; never one's own record. */
  @Patch(':id/device-user')
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @UseGuards(DeviceAdminThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffDeviceUserDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  setDeviceUser(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: SetDeviceUserDto,
    @Query() _query: NoQueryDto,
  ): Promise<StaffDeviceUserDto> {
    return this.biometric.setDeviceUser(session, id, body);
  }
}
