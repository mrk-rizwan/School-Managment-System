// M1: WHATSAPP_PROVIDERS_ENABLED. A provider this deployment does not run has no webhook routes
// (404), cannot be chosen by the platform (422 INVALID_VALUE), and GET /platform/settings lists
// the enabled ones so the console can grey the others out. Here only WAHA is enabled.
import { createHmac, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ENV, loadEnv } from '../../src/config/env';
import { signedInPlatformAdmin } from '../support/platform';
import { closeTestDb } from '../support/schools';
import { nextIp, ORIGIN } from '../school-auth/support';
import { messagingApp, messagingSchool } from '../messaging/support';

const WAHA_SECRET = randomBytes(24).toString('hex');
const META_SECRET = randomBytes(24).toString('hex');
const VERIFY_TOKEN = randomBytes(24).toString('hex');
const sign = (algorithm: 'sha512' | 'sha256', secret: string, raw: string) =>
  createHmac(algorithm, secret).update(raw).digest('hex');

describe('WhatsApp providers enabled (e2e, M1)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      WAHA_WEBHOOK_SECRET: WAHA_SECRET,
      META_APP_SECRET: META_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_PROVIDERS_ENABLED: ['waha'] as const,
    };
    ({ app } = await messagingApp(undefined, [{ provide: ENV, useValue: Object.freeze(env) }]));
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const platformPatch = (path: string, cookie: string, body: object) =>
    http().patch(`/api/v1/platform${path}`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

  it('the disabled provider webhook routes answer 404, correctly signed or not; the enabled one still works', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const meta = await http()
      .post('/api/v1/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', nextIp())
      .set('X-Hub-Signature-256', `sha256=${sign('sha256', META_SECRET, raw)}`)
      .send(raw);
    expect(meta.status).toBe(404);
    expect(meta.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const handshake = await http()
      .get('/api/v1/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' })
      .set('X-Forwarded-For', nextIp());
    expect(handshake.status).toBe(404);
    expect(handshake.text).not.toContain('abc123');

    const wahaRaw = JSON.stringify({ event: 'message', session: 'nobody', timestamp: Date.now() });
    const waha = await http()
      .post('/api/v1/webhooks/waha')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', nextIp())
      .set('X-Webhook-Hmac', sign('sha512', WAHA_SECRET, wahaRaw))
      .set('X-Webhook-Hmac-Algorithm', 'sha512')
      .send(wahaRaw);
    expect(waha.status).toBe(204);
  });

  it('GET /platform/settings lists the enabled providers; PATCH to a disabled default is 422 INVALID_VALUE', async () => {
    const admin = await signedInPlatformAdmin();
    const current = await http().get('/api/v1/platform/settings').set('Cookie', admin.cookie);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ enabledWhatsappProviders: ['waha'] });
    const refused = await platformPatch('/settings', admin.cookie, { defaultWhatsappProvider: 'cloud_api' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { fields: [{ path: 'defaultWhatsappProvider', code: 'INVALID_VALUE' }] } },
    });
    const ok = await platformPatch('/settings', admin.cookie, { defaultWhatsappProvider: 'waha' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ defaultWhatsappProvider: 'waha', enabledWhatsappProviders: ['waha'] });
  });

  it('PATCH /platform/schools/:id choosing a disabled provider is 422 INVALID_VALUE; enabled or platform_default is 200', async () => {
    const admin = await signedInPlatformAdmin();
    const school = await messagingSchool();
    const refused = await platformPatch(`/schools/${school.id}`, admin.cookie, { whatsappProvider: 'cloud_api' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: { details: { fields: [{ path: 'whatsappProvider', code: 'INVALID_VALUE' }] } },
    });
    expect((await platformPatch(`/schools/${school.id}`, admin.cookie, { whatsappProvider: 'waha' })).status).toBe(200);
    const back = await platformPatch(`/schools/${school.id}`, admin.cookie, { whatsappProvider: 'platform_default' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ whatsappProvider: 'platform_default' });
  });
});
