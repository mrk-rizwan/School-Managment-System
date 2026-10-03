import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  EXTERNAL_CHANNELS,
  SCHOOL_STATUSES,
  WHATSAPP_ERROR_CODES,
  type MessageChannel,
  type SchoolStatus,
  type WhatsAppErrorCode,
  type WhatsAppStatus,
} from '@asms/shared';
import { SearchField } from '../../../common/fields';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-9.md §6.3 (R114): the platform's delivery-health view, read only from
// platform_delivery_health and the schools table. Never a body, a recipient or a phone number;
// never messages, message_deliveries or whatsapp_numbers. Schools are few enough (hundreds) that
// the filter, sort and page run in memory over one read.

/** The channels with delivery rows, in the shared order (`in_app` has none). */
export const HEALTH_CHANNELS = EXTERNAL_CHANNELS;
const WHATSAPP_FILTERS = ['pending', 'connected', 'down', 'none'] as const;
const SNAPSHOT_STATUSES = ['pending', 'connected', 'down', 'disabled', 'none'] as const;
export const HEALTH_SORTS = ['name', '-name', '-failedToday', '-smsUsed'] as const;

export class DeliveryHealthQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: WHATSAPP_FILTERS, enumName: 'WhatsAppHealthFilter' })
  @IsOptional()
  @IsIn(WHATSAPP_FILTERS)
  whatsappStatus?: (typeof WHATSAPP_FILTERS)[number];

  @ApiPropertyOptional({ enum: SCHOOL_STATUSES, enumName: 'SchoolStatus', description: 'Absent: all but terminated' })
  @IsOptional()
  @IsIn(SCHOOL_STATUSES)
  schoolStatus?: SchoolStatus;

  @SearchField('Name contains, or short code starts with (case-insensitive)', 100)
  q?: string;

  @ApiPropertyOptional({ enum: HEALTH_SORTS, enumName: 'DeliveryHealthSort', default: 'name' })
  @IsOptional()
  @IsIn(HEALTH_SORTS)
  sort?: (typeof HEALTH_SORTS)[number];
}

export class HealthWhatsAppDto {
  @ApiProperty({ enum: SNAPSHOT_STATUSES, enumName: 'WhatsAppHealthStatus' })
  status: WhatsAppStatus | 'none';

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastHealthyAt: Date | null;

  @ApiProperty({ enum: WHATSAPP_ERROR_CODES, enumName: 'WhatsAppErrorCode', nullable: true })
  lastErrorCode: WhatsAppErrorCode | null;
}

export class HealthDayChannelDto {
  @ApiProperty({ enum: HEALTH_CHANNELS, enumName: 'HealthChannel' })
  channel: MessageChannel;

  @ApiProperty({ type: 'integer' })
  accepted: number;

  @ApiProperty({ type: 'integer' })
  delivered: number;

  @ApiProperty({ type: 'integer' })
  failed: number;

  @ApiProperty({ type: 'integer' })
  suppressed: number;
}

export class HealthSmsDto {
  @ApiProperty({ type: 'integer' })
  used: number;

  @ApiProperty({ type: 'integer' })
  cap: number;
}

export class PlatformDeliveryHealthDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]{0,18}$' })
  schoolId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  shortCode: string;

  @ApiProperty({ enum: SCHOOL_STATUSES, enumName: 'SchoolStatus' })
  schoolStatus: SchoolStatus;

  @ApiProperty({ type: HealthWhatsAppDto })
  whatsapp: HealthWhatsAppDto;

  @ApiProperty({ type: [HealthDayChannelDto] })
  today: HealthDayChannelDto[];

  @ApiProperty({ type: [HealthDayChannelDto] })
  yesterday: HealthDayChannelDto[];

  @ApiProperty({ type: HealthSmsDto })
  sms: HealthSmsDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  computedAt: Date | null;
}
