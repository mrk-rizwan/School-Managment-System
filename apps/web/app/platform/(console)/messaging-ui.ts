import type { SmsProvider, WhatsAppProvider } from '@asms/shared';

// Provider names shared by the platform's school detail, settings and delivery-health screens
// (contracts/slice-9.md §6).

export const WHATSAPP_PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  waha: 'WAHA (QR pairing)',
  cloud_api: 'WhatsApp Business Cloud API',
};

export const SMS_PROVIDER_LABELS: Record<SmsProvider, string> = {
  sendpk: 'Sendpk',
};
