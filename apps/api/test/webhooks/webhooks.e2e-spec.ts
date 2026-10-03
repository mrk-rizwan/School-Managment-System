// R172 and named exception 5 (contracts/slice-9.md §8): provider webhooks verified over the raw
// bytes, forward-only, 204 for every verified body, 401 without details for a bad signature, a
// failed-verification bucket per IP, and the exception-5 repository's isolation.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ENV, loadEnv } from '../../src/config/env';
import { DeliveryWebhookRepository } from '../../src/repositories/platform/delivery-webhook.repository';
import { closeTestDb, testDb, type TestSchool } from '../support/schools';
import { createGuardian } from '../support/students';
import { nextIp } from '../school-auth/support';
import { connectedNumber, messagingApp, messagingSchool, type Enqueued } from '../messaging/support';

const WAHA_SECRET = randomBytes(24).toString('hex');
const META_SECRET = randomBytes(24).toString('hex');
const VERIFY_TOKEN = randomBytes(24).toString('hex');
const sign = (algorithm: 'sha512' | 'sha256', secret: string, raw: string) =>
  createHmac(algorithm, secret).update(raw).digest('hex');
const refHash = (ref: string) => createHash('sha256').update(`whatsapp|${ref}`).digest('hex');

describe('webhooks (e2e, R172)', () => {
  let app: NestExpressApplication;
  let enqueued: Enqueued[];
  const db = testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      WAHA_WEBHOOK_SECRET: WAHA_SECRET,
      META_APP_SECRET: META_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    };
    ({ app, enqueued } = await messagingApp(undefined, [{ provide: ENV, useValue: Object.freeze(env) }]));
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
  });

  /** An accepted WhatsApp delivery whose provider reference is `ref`. */
  async function acceptedDelivery(school: TestSchool, ref: string): Promise<{ messageId: bigint; deliveryId: bigint }> {
    const g = await createGuardian(db, school);
    const message = await db.message.create({
      data: {
        schoolId: school.id,
        type: 'holiday_notice',
        priority: 'normal',
        subjectType: 'holiday',
        subjectId: BigInt(Math.floor(Math.random() * 1e9)),
        guardianId: g.id,
        body: 'Iqra Model School: School closed Mon 9 Nov for Iqbal Day.',
        channelPlan: ['whatsapp', 'sms'],
        status: 'sent',
        finishedAt: new Date(),
      },
    });
    const delivery = await db.messageDelivery.create({
      data: { schoolId: school.id, messageId: message.id, channel: 'whatsapp', attempt: 1, status: 'accepted', providerRefHash: refHash(ref) },
    });
    return { messageId: message.id, deliveryId: delivery.id };
  }

  const waha = (body: object, opts: { ip?: string; signature?: string } = {}) => {
    const raw = JSON.stringify(body);
    return http()
      .post('/api/v1/webhooks/waha')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', opts.ip ?? nextIp())
      .set('X-Webhook-Hmac', opts.signature ?? sign('sha512', WAHA_SECRET, raw))
      .set('X-Webhook-Hmac-Algorithm', 'sha512')
      .send(raw);
  };
  const meta = (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    return http()
      .post('/api/v1/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', nextIp())
      .set('X-Hub-Signature-256', `sha256=${signature ?? sign('sha256', META_SECRET, raw)}`)
      .send(raw);
  };

  it('R172: a WAHA ack 2 moves the accepted delivery to delivered and enqueues a rollup; a replay is 204 and changes nothing', async () => {
    const school = await messagingSchool();
    const ref = `true_923001234567@c.us_${randomBytes(8).toString('hex')}`;
    const { deliveryId, messageId } = await acceptedDelivery(school, ref);
    const body = { event: 'message.ack', session: 'asms_x', timestamp: Date.now(), payload: { id: ref, ack: 3, from: '923001234567@c.us' } };
    const res = await waha(body);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await db.messageDelivery.findFirst({ where: { schoolId: school.id, id: deliveryId } })).toMatchObject({ status: 'delivered' });
    expect(enqueued).toEqual([{ kind: 'rollup', schoolId: school.id, id: messageId }]);
    // Forward only: a later ERROR ack for the same message cannot move it back.
    enqueued.length = 0;
    expect((await waha({ ...body, payload: { id: ref, ack: -1 } })).status).toBe(204);
    expect(await db.messageDelivery.findFirst({ where: { schoolId: school.id, id: deliveryId } })).toMatchObject({ status: 'delivered' });
    expect(enqueued).toEqual([]);
  });

  it('R172: an unknown reference, a stale event and an unparseable signed body are 204 with no effect', async () => {
    expect((await waha({ event: 'message.ack', session: 's', timestamp: Date.now(), payload: { id: 'nobody', ack: 2 } })).status).toBe(204);
    expect((await waha({ event: 'message.ack', session: 's', timestamp: Date.now() - 6 * 60_000, payload: { id: 'x', ack: 2 } })).status).toBe(204);
    expect((await waha({ hello: 'world' })).status).toBe(204);
    expect(enqueued).toEqual([]);
  });

  it('R172: a bad or missing signature is 401 WEBHOOK_SIGNATURE_INVALID with no details', async () => {
    const res = await waha({ event: 'message.ack', session: 's', timestamp: Date.now() }, { signature: 'ab'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', details: null } });
    expect(res.text).not.toContain('message.ack');
    const unsigned = await http().post('/api/v1/webhooks/waha').set('Content-Type', 'application/json').set('X-Forwarded-For', nextIp()).send('{}');
    expect(unsigned.status).toBe(401);
  });

  it('R172: ten failed verifications from one IP spend its budget: the next request is 429 before verification', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      expect((await waha({ event: 'x', session: 's', timestamp: Date.now() }, { ip, signature: 'cd'.repeat(64) })).status).toBe(401);
    }
    const valid = await waha({ event: 'x', session: 's', timestamp: Date.now() }, { ip });
    expect(valid.status).toBe(429);
    expect(valid.headers['retry-after']).toBeDefined();
  });

  it('decision 8: session.status never writes status; it queues a health check for the number', async () => {
    const school = await messagingSchool();
    const id = await connectedNumber(db, school);
    const res = await waha({ event: 'session.status', session: `asms_${id}`, timestamp: Date.now(), payload: { status: 'FAILED' } });
    expect(res.status).toBe(204);
    expect(enqueued).toEqual([{ kind: 'health', schoolId: school.id, id }]);
    expect(await db.whatsAppNumber.findFirst({ where: { schoolId: school.id, id } })).toMatchObject({ status: 'connected' });
    expect((await waha({ event: 'message', session: `asms_${id}`, timestamp: Date.now(), payload: { body: 'hello' } })).status).toBe(204);
    expect(await db.whatsAppNumber.findFirst({ where: { schoolId: school.id, id } })).toMatchObject({ inboundIgnoredCount: 1 });
  });

  it('R172: Meta handshake answers the challenge only for the verify token', async () => {
    const ok = await http()
      .get('/api/v1/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' })
      .set('X-Forwarded-For', nextIp());
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('abc123');
    const bad = await http()
      .get('/api/v1/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'abc123' })
      .set('X-Forwarded-For', nextIp());
    expect(bad.status).toBe(401);
  });

  it('R172: a Meta failed status maps its error code; read is recorded as delivered; a bad signature is 401', async () => {
    const school = await messagingSchool();
    const failedRef = `wamid.${randomBytes(10).toString('hex')}`;
    const readRef = `wamid.${randomBytes(10).toString('hex')}`;
    const failed = await acceptedDelivery(school, failedRef);
    const read = await acceptedDelivery(school, readRef);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1234567890' },
                statuses: [
                  { id: failedRef, status: 'failed', errors: [{ code: 131026, title: 'raw text never stored' }], recipient_id: '923001234567' },
                  { id: readRef, status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect((await meta(body, 'ee'.repeat(32))).status).toBe(401);
    expect((await meta(body)).status).toBe(204);
    expect(await db.messageDelivery.findFirst({ where: { schoolId: school.id, id: failed.deliveryId } })).toMatchObject({ status: 'failed', errorCode: 'not_on_whatsapp' });
    expect(await db.messageDelivery.findFirst({ where: { schoolId: school.id, id: read.deliveryId } })).toMatchObject({ status: 'delivered' });
  });

  it('R172: no SMS webhook is mounted (Sendpk is pull-only, §8.4)', async () => {
    const res = await http().post('/api/v1/webhooks/sms/sendpk').set('Content-Type', 'application/json').set('X-Forwarded-For', nextIp()).send('{}');
    expect(res.status).toBe(404);
  });

  it('named exception 5: statement A touches only the delivery its reference names, and returns its own school', async () => {
    const a = await messagingSchool();
    const b = await messagingSchool();
    const refA = `ref-${randomBytes(8).toString('hex')}`;
    const refB = `ref-${randomBytes(8).toString('hex')}`;
    const inA = await acceptedDelivery(a, refA);
    const inB = await acceptedDelivery(b, refB);
    const repo = app.get(DeliveryWebhookRepository, { strict: false });
    const reported = await repo.reportWhatsApp(refHash(refA), 'delivered', null);
    expect(reported).toEqual({ schoolId: a.id, messageId: inA.messageId, deliveryId: inA.deliveryId });
    expect(await db.messageDelivery.findFirst({ where: { schoolId: b.id, id: inB.deliveryId } })).toMatchObject({ status: 'accepted' });
    expect(await repo.reportWhatsApp(refHash(refA), 'failed', 'rejected')).toBeNull();
    expect(await repo.countInboundByWahaSession('asms_no_such_session', 1)).toBeNull();
  });
});
