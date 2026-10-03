import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import {
  MESSAGE_CHANNELS,
  WHATSAPP_ERROR_CODES,
  WHATSAPP_PROVIDERS,
  WHATSAPP_STATUSES,
  type MessageChannel,
  type WhatsAppErrorCode,
  type WhatsAppProvider,
  type WhatsAppStatus,
} from '@asms/shared';
import { IfPresent, PhoneField, TextField } from '../../common/fields';

// contracts/slice-9.md §2.2, §5.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;

export const TEST_CHANNELS = ['whatsapp', 'sms', 'push'] as const;

export class MessagingTestDto {
  @ApiProperty({ enum: TEST_CHANNELS, enumName: 'MessagingTestChannel' })
  @IsIn(TEST_CHANNELS)
  channel: (typeof TEST_CHANNELS)[number];
}

export class MessagingTestResultDto {
  @ApiProperty(ID)
  messageId: string;
}

export class UsageChannelDto {
  @ApiProperty({ enum: MESSAGE_CHANNELS, enumName: 'MessageChannel' })
  channel: MessageChannel;

  @ApiProperty({ type: 'integer' })
  count: number;
}

export class UsageMonthDto {
  @ApiProperty({ pattern: '^[0-9]{4}-[0-9]{2}$' })
  yearMonth: string;

  @ApiProperty({ type: [UsageChannelDto] })
  byChannel: UsageChannelDto[];
}

export class MessagingUsageDto {
  @ApiProperty({ type: [UsageMonthDto], description: 'This month, then last month (Asia/Karachi)' })
  months: UsageMonthDto[];

  @ApiProperty({ type: 'integer', description: 'SMS segments a month, set by the platform' })
  cap: number;

  @ApiProperty({ type: 'integer' })
  remaining: number;
}

export class WhatsAppNumberDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty({ enum: WHATSAPP_PROVIDERS, enumName: 'WhatsAppProvider' })
  provider: WhatsAppProvider;

  @ApiProperty({ example: '+9230*****67' })
  phoneMasked: string;

  @ApiProperty({ enum: WHATSAPP_STATUSES, enumName: 'WhatsAppStatus' })
  status: WhatsAppStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastHealthyAt: Date | null;

  @ApiProperty({ enum: WHATSAPP_ERROR_CODES, enumName: 'WhatsAppErrorCode', nullable: true })
  lastErrorCode: WhatsAppErrorCode | null;

  @ApiProperty({ type: 'integer' })
  inboundIgnoredCount: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pairedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class WhatsAppSettingsDto {
  @ApiProperty({ enum: WHATSAPP_PROVIDERS, enumName: 'WhatsAppProvider' })
  effectiveProvider: WhatsAppProvider;

  @ApiProperty({ type: WhatsAppNumberDto, nullable: true })
  number: WhatsAppNumberDto | null;
}

export class WhatsAppPairDto {
  @ApiPropertyOptional({ description: 'The school number; required for the first pairing' })
  @IfPresent()
  @PhoneField()
  phone?: string;
}

export class WhatsAppPairingDto {
  @ApiProperty({ description: 'data:image/png;base64,...; never stored or logged' })
  qr: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

export class ConnectCloudApiDto {
  @ApiProperty()
  @PhoneField()
  phone: string;

  @ApiProperty({ pattern: '^[0-9]{5,20}$' })
  @IsString()
  @Matches(/^[0-9]{5,20}$/, { message: '$property must be 5-20 digits' })
  phoneNumberId: string;

  @ApiProperty({ minLength: 20, maxLength: 1024, writeOnly: true })
  @IsString()
  @Length(20, 1024)
  @Matches(/^[A-Za-z0-9_.|-]+$/, { message: '$property has characters a Meta token never has' })
  accessToken: string;
}

export class DisableWhatsAppDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;
}
