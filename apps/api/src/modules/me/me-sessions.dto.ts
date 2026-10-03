import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { DEVICE_PLATFORMS, type DevicePlatform } from '@asms/shared';

// contracts/slice-9.md §2.2, §3.5, §3.6.

export const PUSH_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]+$/;

export class RegisterDeviceDto {
  @ApiProperty({ enum: DEVICE_PLATFORMS, enumName: 'DevicePlatform' })
  @IsIn(DEVICE_PLATFORMS)
  platform: DevicePlatform;

  /** The FCM registration token. Write-only: never returned, never logged (R173). */
  @ApiProperty({ minLength: 1, maxLength: 512, pattern: PUSH_TOKEN_PATTERN.source })
  @IsString()
  @Length(1, 512)
  @Matches(PUSH_TOKEN_PATTERN, { message: 'pushToken is not valid' })
  pushToken: string;
}

/** A push address of this session. Never the push token (R173). */
export class DeviceDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ enum: DEVICE_PLATFORMS, enumName: 'DevicePlatform' })
  platform: DevicePlatform;

  @ApiProperty()
  appVersion: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  lastSeenAt: Date;
}

export class SessionsRevokedDto {
  @ApiProperty({ type: Number, minimum: 0 })
  revoked: number;
}
