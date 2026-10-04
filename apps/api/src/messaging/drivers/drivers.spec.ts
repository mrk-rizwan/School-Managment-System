// M1: a WhatsApp provider not in WHATSAPP_PROVIDERS_ENABLED gets the refusing driver - every send
// fails as session_down (permanent: the guardian falls to SMS), health fails, onboarding throws.
import { randomBytes } from 'node:crypto';
import { parseEnv } from '../../config/env';
import type { Mailer } from '../../modules/auth/mailer';
import { createMessagingDrivers } from './drivers';
import { DisabledWhatsAppDriver } from './whatsapp';

const key = () => randomBytes(32).toString('base64');
const env = (enabled: string) =>
  parseEnv({
    NODE_ENV: 'test',
    API_PORT: '3461',
    APP_URL: 'http://localhost:3460',
    DATABASE_URL: 'postgresql://127.0.0.1:5432/asms',
    REDIS_URL: 'redis://127.0.0.1:6379',
    IDENTITY_HASH_KEY: key(),
    FIELD_ENCRYPTION_KEYS: `k1:${key()}`,
    PASSWORD_PEPPER: key(),
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'asms-documents',
    S3_ACCESS_KEY_ID: 'placeholder',
    S3_SECRET_ACCESS_KEY: 'placeholder',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_FROM: 'ASMS <no-reply@localhost>',
    META_APP_SECRET: randomBytes(16).toString('hex'),
    WHATSAPP_PROVIDERS_ENABLED: enabled,
  });
const mailer = {} as Mailer;
const sender = { wahaSession: 'asms_1', cloudPhoneNumberId: '123', cloudAccessToken: 'token' };

describe('createMessagingDrivers and WHATSAPP_PROVIDERS_ENABLED', () => {
  it('a disabled provider refuses every send as session_down and fails its health check', async () => {
    const drivers = createMessagingDrivers(env('waha'), mailer);
    expect(drivers.whatsapp.cloud_api).toBeInstanceOf(DisabledWhatsAppDriver);
    expect(drivers.cloud).toBeInstanceOf(DisabledWhatsAppDriver);
    expect(await drivers.whatsapp.cloud_api.sendText(sender, '+923001234567', 'hi', 'asms_messaging_test_v1')).toEqual({
      kind: 'failed',
      error: 'session_down',
    });
    expect(await drivers.whatsapp.cloud_api.health(sender)).toEqual({ ok: false, code: 'unreachable' });
    expect(await drivers.cloud.verify('123', 'token')).toEqual({ ok: false, reason: 'unreachable' });
    // WAHA is enabled but has no credentials here: the log driver (outside production only).
    expect(drivers.whatsapp.waha).not.toBeInstanceOf(DisabledWhatsAppDriver);
  });

  it('a disabled WAHA cannot be paired', async () => {
    const drivers = createMessagingDrivers(env('cloud_api'), mailer);
    expect(drivers.whatsapp.waha).toBeInstanceOf(DisabledWhatsAppDriver);
    await expect(drivers.waha.start('asms_1')).rejects.toThrow(/disabled/);
    expect(drivers.whatsapp.cloud_api).not.toBeInstanceOf(DisabledWhatsAppDriver);
  });
});
