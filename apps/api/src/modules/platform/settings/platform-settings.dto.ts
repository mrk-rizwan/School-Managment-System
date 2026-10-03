import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
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
}
