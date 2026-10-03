import { ErrorCode, type WhatsAppProviderChoice } from '@asms/shared';
import { fieldRefused } from '../../common/errors/api-exception';
import { whatsappProviderEnabled, type Env } from '../../config/env';

/**
 * M1: the platform cannot choose a WhatsApp provider this deployment does not run
 * (WHATSAPP_PROVIDERS_ENABLED) - as the platform default (PATCH /platform/settings) or for a
 * school (PATCH /platform/schools/:id). `platform_default` and an absent value always pass.
 */
export function refuseDisabledWhatsappProvider(
  env: Env,
  path: string,
  choice: WhatsAppProviderChoice | undefined,
): void {
  if (choice === undefined || choice === 'platform_default') return;
  if (!whatsappProviderEnabled(env, choice)) {
    throw fieldRefused(path, ErrorCode.INVALID_VALUE, 'That WhatsApp provider is not enabled on this platform.');
  }
}
