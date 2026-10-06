import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import {
  SMS_PROVIDERS,
  WHATSAPP_PROVIDERS,
  type SmsProvider,
  type WhatsAppProvider,
} from '@asms/shared';
import { IfPresent } from '../../../common/fields';

// contracts/slice-9.md §6.2: the platform-wide messaging defaults for every school on
// `platform_default`. One row; a change takes effect on each such school's next onboarding check
// and next SMS leg.

export class PlatformSettingsDto {
  @ApiProperty({ enum: WHATSAPP_PROVIDERS, enumName: 'WhatsAppProvider' })
  defaultWhatsappProvider: WhatsAppProvider;

  @ApiProperty({ enum: SMS_PROVIDERS, enumName: 'SmsProvider' })
  defaultSmsProvider: SmsProvider;

  /**
   * The WhatsApp providers this deployment runs (WHATSAPP_PROVIDERS_ENABLED). Choosing another,
   * as the default here or for a school, is refused (422).
   */
  @ApiProperty({ enum: WHATSAPP_PROVIDERS, enumName: 'WhatsAppProvider', isArray: true })
  enabledWhatsappProviders: WhatsAppProvider[];

  /** Day of the month a platform invoice falls due (phase-3-financial.md §4, default 10). */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 28 })
  invoiceDueDay: number;

  /** Days after the due day before an unpaid school is eligible for suspension (R221, default 15). */
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 90 })
  graceDays: number;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({ enum: WHATSAPP_PROVIDERS, enumName: 'WhatsAppProvider' })
  @IfPresent()
  @IsIn(WHATSAPP_PROVIDERS)
  defaultWhatsappProvider?: WhatsAppProvider;

  @ApiPropertyOptional({ enum: SMS_PROVIDERS, enumName: 'SmsProvider' })
  @IfPresent()
  @IsIn(SMS_PROVIDERS)
  defaultSmsProvider?: SmsProvider;

  /** Applies to invoices issued from the next run; issued invoices keep their due date. */
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 28 })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(28)
  invoiceDueDay?: number;

  /** Applies at the next daily run to invoices not yet stamped eligible. */
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 90 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(90)
  graceDays?: number;
}
