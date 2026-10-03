import { Redis } from 'ioredis';
import { whatsappProviderEnabled, type Env } from '../../config/env';
import type { Mailer } from '../../modules/auth/mailer';
import { FcmPushDriver, LogPushDriver } from './push';
import { LogSmsDriver, SendpkSmsDriver } from './sms';
import type { EmailDriver, MessagingDrivers, SendOutcome } from './types';
import { CloudApiDriver, DisabledWhatsAppDriver, LogWhatsAppDriver, WahaDriver } from './whatsapp';

/** Email is Phase 1's Mailer (three attempts with backoff; it never rejects). */
export class MailerEmailDriver implements EmailDriver {
  constructor(private readonly mailer: Mailer) {}

  async send(to: string, subject: string, text: string): Promise<SendOutcome> {
    await this.mailer.send({ to, subject, text });
    return { kind: 'accepted', ref: null };
  }
}

/**
 * Selects every driver from the environment once, at boot. A WhatsApp provider not in
 * WHATSAPP_PROVIDERS_ENABLED gets the refusing driver (M1). An absent credential selects the log
 * driver; that happens only outside production, because env.ts refuses to start production
 * without every enabled driver's key (R112).
 */
export function createMessagingDrivers(env: Env, mailer: Mailer): MessagingDrivers {
  const log = new LogWhatsAppDriver();
  const disabled = new DisabledWhatsAppDriver();
  const wahaOn = whatsappProviderEnabled(env, 'waha');
  const cloudOn = whatsappProviderEnabled(env, 'cloud_api');
  const waha =
    wahaOn &&
    env.WAHA_URL !== undefined &&
    env.WAHA_API_KEY !== undefined &&
    env.WAHA_WEBHOOK_SECRET !== undefined
      ? new WahaDriver(
          {
            url: env.WAHA_URL.replace(/\/$/, ''),
            apiKey: env.WAHA_API_KEY,
            webhookUrl: `${new URL(env.APP_URL).origin}/api/v1/webhooks/waha`,
            webhookSecret: env.WAHA_WEBHOOK_SECRET,
          },
          new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true }),
        )
      : null;
  const cloud =
    cloudOn && env.META_APP_SECRET !== undefined ? new CloudApiDriver(env.META_GRAPH_VERSION) : null;
  const wahaDriver = wahaOn ? (waha ?? log) : disabled;
  const cloudDriver = cloudOn ? (cloud ?? log) : disabled;
  return {
    push:
      env.FCM_SERVICE_ACCOUNT_JSON !== undefined
        ? new FcmPushDriver(env.FCM_SERVICE_ACCOUNT_JSON)
        : new LogPushDriver(),
    whatsapp: { waha: wahaDriver, cloud_api: cloudDriver },
    waha: wahaDriver,
    cloud: cloudDriver,
    sms:
      env.SMS_API_KEY !== undefined && env.SMS_SENDER_ID !== undefined
        ? new SendpkSmsDriver({
            baseUrl: env.SMS_API_URL.replace(/\/$/, ''),
            apiKey: env.SMS_API_KEY,
            senderId: env.SMS_SENDER_ID,
          })
        : new LogSmsDriver(),
    email: new MailerEmailDriver(mailer),
  };
}
