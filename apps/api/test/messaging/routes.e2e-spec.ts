// Slice 9 HTTP routes (contracts/slice-9.md §5, §6): the school's messaging settings and the
// platform's messaging knobs, settings and delivery health (R114). Fake drivers throughout.
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DeliveryHealthRollup } from '../../src/jobs/delivery-health-rollup';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { signedInPlatformAdmin } from '../support/platform';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, testDb, type TestSchool } from '../support/schools';
import { randomPhone } from '../support/students';
import { nextIp, ORIGIN } from '../school-auth/support';
import {
  asSchool,
  connectedNumber,
  device,
  messagingApp,
  messagingSchool,
  type Enqueued,
  type FakeDrivers,
} from './support';

const ID_PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;

describe('slice 9 messaging routes (e2e)', () => {
  let app: NestExpressApplication;
  let drivers: FakeDrivers;
  let enqueued: Enqueued[];
  const db = testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, drivers, enqueued } = await messagingApp());
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(() => {
    drivers.calls.length = 0;
    enqueued.length = 0;
    drivers.wahaStart = 'needs_qr';
  });

  async function signedIn(school: TestSchool, role: 'principal' | 'teacher' = 'principal') {
    const user = await createSchoolUser(db, school, { systemRole: role });
    const session = await createSchoolSession(db, school, user);
    return { user, cookie: session.cookie };
  }
  const post = (path: string, cookie: string, body: object = {}) =>
    http().post(`/api/v1${path}`).set('Cookie', cookie).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp()).send(body);
  const get = (path: string, cookie: string) =>
    http().get(`/api/v1${path}`).set('Cookie', cookie).set('X-Forwarded-For', nextIp());

  // ---------------------------------------------------------------------- §5.1 test message

  describe('POST /messaging/test', () => {
    it('sends a push test to the caller own devices; with none the message is suppressed no_channel', async () => {
      const school = await messagingSchool();
      const { user, cookie } = await signedIn(school);
      const res = await post('/messaging/test', cookie, { channel: 'push' });
      expect(res.status).toBe(200);
      const messageId = BigInt((res.body as { messageId: string }).messageId);
      const message = await db.message.findFirst({ where: { schoolId: school.id, id: messageId } });
      expect(message).toMatchObject({ type: 'messaging_test', staffId: user.staffId, status: 'suppressed', suppressedReason: 'no_channel' });
      const audit = await db.auditLog.findFirst({ where: { schoolId: school.id, action: 'messaging.test_sent' } });
      expect(audit).toMatchObject({ subjectType: 'user', subjectId: user.userId, metadata: { channel: 'push' } });
      expect(message?.subjectId).toBe(audit?.id);

      await device(db, school, user.userId);
      const second = await post('/messaging/test', cookie, { channel: 'push' });
      const queued = await db.message.findFirst({ where: { schoolId: school.id, id: BigInt((second.body as { messageId: string }).messageId) } });
      expect(queued).toMatchObject({ status: 'queued', channelPlan: ['push'] });
      expect(enqueued.map((e) => e.id)).toContain(queued?.id);
    });

    it('R109: an SMS test counts against the cap; over it is 409 SMS_CAP_EXCEEDED with { cap, used }', async () => {
      const school = await messagingSchool({ cap: 1 });
      const { cookie } = await signedIn(school);
      const first = await post('/messaging/test', cookie, { channel: 'sms' });
      expect(first.status).toBe(200);
      const message = await db.message.findFirst({ where: { schoolId: school.id, id: BigInt((first.body as { messageId: string }).messageId) } });
      expect(message?.channelPlan).toEqual(['sms']);
      await asSchool(app, school.id, () => app.get(MessageProcessor, { strict: false }).run(school.id, message?.id ?? 0n));
      expect(drivers.of('sms')).toHaveLength(1);
      const refused = await post('/messaging/test', cookie, { channel: 'sms' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: { code: 'SMS_CAP_EXCEEDED', details: { cap: 1, used: 1 } } });
    });

    it('a WhatsApp test needs a live number (409 WHATSAPP_NUMBER_MISSING); with one it plans WhatsApp then SMS', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school);
      const missing = await post('/messaging/test', cookie, { channel: 'whatsapp' });
      expect(missing.status).toBe(409);
      expect(missing.body).toMatchObject({ error: { code: 'WHATSAPP_NUMBER_MISSING' } });
      await connectedNumber(db, school, 'down');
      const ok = await post('/messaging/test', cookie, { channel: 'whatsapp' });
      expect(ok.status).toBe(200);
      const message = await db.message.findFirst({ where: { schoolId: school.id, id: BigInt((ok.body as { messageId: string }).messageId) } });
      expect(message?.channelPlan).toEqual(['whatsapp', 'sms']);
      // A down number is still tried by a test (§5.1); the fallback follows its failure.
      drivers.whatsappOutcomes.push({ kind: 'failed', error: 'session_down' });
      await asSchool(app, school.id, () => app.get(MessageProcessor, { strict: false }).run(school.id, message?.id ?? 0n));
      expect(drivers.of('whatsapp')).toHaveLength(1);
      expect(drivers.of('sms')).toHaveLength(1);
    });

    it('R80 lifted: a suspended school sends a test message like any other school', async () => {
      const school = await messagingSchool({ status: 'suspended' });
      const { cookie } = await signedIn(school);
      expect((await post('/messaging/test', cookie, { channel: 'push' })).status).toBe(200);
    });

    it('needs school.settings.manage (a teacher is 403) and a valid channel (422)', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school, 'teacher');
      expect((await post('/messaging/test', cookie, { channel: 'push' })).status).toBe(403);
      const principalCookie = (await signedIn(school)).cookie;
      expect((await post('/messaging/test', principalCookie, { channel: 'email' })).status).toBe(422);
    });
  });

  // ---------------------------------------------------------------------- §5.2 usage

  it('GET /messaging/usage: this month then last, four channels with zeros, cap and remaining', async () => {
    const school = await messagingSchool({ cap: 50 });
    const { cookie } = await signedIn(school);
    const res = await get('/messaging/usage', cookie);
    expect(res.status).toBe(200);
    const body = res.body as { months: { yearMonth: string; byChannel: { channel: string; count: number }[] }[]; cap: number; remaining: number };
    expect(body.months).toHaveLength(2);
    expect(body.months[0]?.byChannel.map((c) => c.channel)).toEqual(['sms', 'whatsapp', 'push', 'email']);
    expect(body).toMatchObject({ cap: 50, remaining: 50 });
  });

  // ---------------------------------------------------------------------- §5.3-§5.6 WhatsApp

  describe('the school WhatsApp number', () => {
    it('pairs with WAHA: first pairing needs the phone; every QR is audited; a different phone is 422', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school);
      expect((await get('/messaging/whatsapp', cookie)).body).toEqual({ effectiveProvider: 'waha', number: null });
      const missing = await post('/messaging/whatsapp/pair', cookie, {});
      expect(missing.body).toMatchObject({ error: { code: 'WHATSAPP_NUMBER_MISSING' } });
      const phone = randomPhone();
      const paired = await post('/messaging/whatsapp/pair', cookie, { phone });
      expect(paired.status).toBe(200);
      expect((paired.body as { qr: string }).qr).toMatch(/^data:image\/png;base64,/);
      const view = (await get('/messaging/whatsapp', cookie)).body as { number: { status: string; phoneMasked: string } };
      expect(view.number).toMatchObject({ status: 'pending', phoneMasked: `${phone.slice(0, 5)}*****${phone.slice(-2)}` });
      expect(JSON.stringify(view)).not.toContain(phone);
      expect((await post('/messaging/whatsapp/pair', cookie, {})).status).toBe(200);
      const other = await post('/messaging/whatsapp/pair', cookie, { phone: randomPhone() });
      expect(other.status).toBe(422);
      const audits = await db.auditLog.findMany({ where: { schoolId: school.id, action: 'whatsapp.pairing_started' } });
      expect(audits.map((a) => (a.metadata as { firstPairing: boolean }).firstPairing)).toEqual([true, false]);
    });

    it('pair: an already paired session is 409 WHATSAPP_ALREADY_CONNECTED and a health check is queued; WAHA down is 503', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school);
      drivers.wahaStart = 'working';
      const res = await post('/messaging/whatsapp/pair', cookie, { phone: randomPhone() });
      expect(res.body).toMatchObject({ error: { code: 'WHATSAPP_ALREADY_CONNECTED' } });
      expect(enqueued.some((e) => e.kind === 'health')).toBe(true);
      drivers.wahaStart = 'fail';
      expect((await post('/messaging/whatsapp/pair', cookie, {})).status).toBe(503);
    });

    it('connect-cloud-api: wrong effective provider is 409 MISMATCH; verified details connect, token never returned', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school);
      const phone = randomPhone();
      const phoneNumberId = String(Date.now()).slice(-12);
      const accessToken = `EAAG${'x'.repeat(40)}`;
      const wrong = await post('/messaging/whatsapp/connect-cloud-api', cookie, { phone, phoneNumberId, accessToken });
      expect(wrong.body).toMatchObject({ error: { code: 'WHATSAPP_PROVIDER_MISMATCH', details: { provider: 'waha' } } });
      await db.school.update({ where: { id: school.id }, data: { whatsappProvider: 'cloud_api' } });
      drivers.cloudVerify = { ok: true, displayPhoneNumber: '+92 300 0000000' };
      const mismatch = await post('/messaging/whatsapp/connect-cloud-api', cookie, { phone, phoneNumberId, accessToken });
      expect(mismatch.body).toMatchObject({ error: { code: 'WHATSAPP_VERIFICATION_FAILED', details: { reason: 'number_mismatch' } } });
      drivers.cloudVerify = { ok: true, displayPhoneNumber: phone };
      const ok = await post('/messaging/whatsapp/connect-cloud-api', cookie, { phone, phoneNumberId, accessToken });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ effectiveProvider: 'cloud_api', number: { provider: 'cloud_api', status: 'connected' } });
      expect(ok.text).not.toContain(accessToken);
      expect(ok.text).not.toContain(phoneNumberId);
      const row = await db.whatsAppNumber.findFirst({ where: { schoolId: school.id, status: 'connected' } });
      expect(row?.cloudAccessToken?.startsWith('v1:')).toBe(true);
      drivers.cloudVerify = { ok: false, reason: 'token_rejected' };
      const again = await post('/messaging/whatsapp/connect-cloud-api', cookie, { phone, phoneNumberId, accessToken });
      expect(again.body).toMatchObject({ error: { code: 'WHATSAPP_ALREADY_CONNECTED' } });
    });

    it('disable: ends the live row with a reason, audited; a second disable is 200 with no audit', async () => {
      const school = await messagingSchool();
      const { cookie } = await signedIn(school);
      await post('/messaging/whatsapp/pair', cookie, { phone: randomPhone() });
      const res = await post('/messaging/whatsapp/disable', cookie, { reason: 'SIM lost' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ effectiveProvider: 'waha', number: null });
      expect(drivers.stopped).toHaveLength(1);
      expect((await post('/messaging/whatsapp/disable', cookie, { reason: 'Again' })).status).toBe(200);
      const audits = await db.auditLog.findMany({ where: { schoolId: school.id, action: 'whatsapp.disabled' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ reason: 'SIM lost', metadata: { provider: 'waha', fromStatus: 'pending' } });
    });
  });

  // ---------------------------------------------------------------------- §6 platform

  describe('platform', () => {
    const platformPatch = (path: string, cookie: string, body: object) =>
      http().patch(`/api/v1/platform${path}`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

    it('PATCH /platform/schools/:id sets the cap and providers, audited as school.updated; null is 422', async () => {
      const admin = await signedInPlatformAdmin();
      const school = await messagingSchool();
      const res = await platformPatch(`/schools/${school.id}`, admin.cookie, { smsMonthlyCap: 900, whatsappProvider: 'cloud_api' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ smsMonthlyCap: 900, whatsappProvider: 'cloud_api', smsProvider: 'platform_default' });
      const audit = await db.platformAuditLog.findFirst({ where: { schoolId: school.id, action: 'school.updated' } });
      expect(audit?.metadata).toEqual({ changes: { smsMonthlyCap: { from: 500, to: 900 }, whatsappProvider: { from: 'platform_default', to: 'cloud_api' } } });
      expect((await platformPatch(`/schools/${school.id}`, admin.cookie, { smsMonthlyCap: null })).status).toBe(422);
      expect((await platformPatch(`/schools/${school.id}`, admin.cookie, { smsMonthlyCap: 100001 })).status).toBe(422);
    });

    it('GET|PATCH /platform/settings: platform_default is not a value; a no-op writes no audit', async () => {
      const admin = await signedInPlatformAdmin();
      const current = await http().get('/api/v1/platform/settings').set('Cookie', admin.cookie);
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({
        defaultWhatsappProvider: expect.any(String),
        defaultSmsProvider: 'sendpk',
        enabledWhatsappProviders: ['waha', 'cloud_api'],
      });
      expect((await platformPatch('/settings', admin.cookie, { defaultWhatsappProvider: 'platform_default' })).status).toBe(422);
      const before = await db.platformAuditLog.count({ where: { action: 'platform_settings.updated' } });
      const same = (current.body as { defaultWhatsappProvider: string }).defaultWhatsappProvider;
      expect((await platformPatch('/settings', admin.cookie, { defaultWhatsappProvider: same })).status).toBe(200);
      expect(await db.platformAuditLog.count({ where: { action: 'platform_settings.updated' } })).toBe(before);
    });

    it('R114: GET /platform/messaging/health shows counts, statuses and caps only, from the rollup', async () => {
      const admin = await signedInPlatformAdmin();
      const school = await messagingSchool({ cap: 77 });
      const numberId = await connectedNumber(db, school);
      const numberRow = await db.whatsAppNumber.findFirst({ where: { schoolId: school.id, id: numberId } });
      await asSchool(app, school.id, () => app.get(DeliveryHealthRollup, { strict: false }).run(school.id));
      const shortCode = (await db.school.findUnique({ where: { id: school.id } }))?.shortCode ?? '';
      const res = await http()
        .get(`/api/v1/platform/messaging/health?q=${shortCode}`)
        .set('Cookie', admin.cookie);
      expect(res.status).toBe(200);
      const body = res.body as { data: Record<string, unknown>[]; total: number };
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({
        schoolId: school.id.toString(),
        whatsapp: { status: 'connected' },
        sms: { used: 0, cap: 77 },
      });
      expect(res.text).not.toContain(numberRow?.phone ?? 'x');
      expect(res.text).not.toMatch(ID_PATTERN);
      const user: TestSchoolUser = await createSchoolUser(db, school, { systemRole: 'principal' });
      const cookie = (await createSchoolSession(db, school, user)).cookie;
      // A school session never reaches the platform route.
      expect((await http().get('/api/v1/platform/messaging/health').set('Cookie', cookie)).status).toBe(401);
    });
  });
});
