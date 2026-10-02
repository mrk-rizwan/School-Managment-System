import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import request from 'supertest';
import { createTestApp } from './app';
import { TestCoreModule } from './test.controller';

const CNIC_DASHED = '35202-1234567-1';
const CNIC_DIGITS = '3520212345671';

describe('API core (slice 0.2)', () => {
  let app: NestExpressApplication;
  const logLines: string[] = [];

  beforeAll(async () => {
    app = await createTestApp({
      imports: [TestCoreModule],
      logStream: { write: (line: string) => void logLines.push(line) },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  type Envelope = {
    error: { code: string; message: string; details: { fields: { path: string; code: string }[] }; requestId: string };
  };
  const errorOf = (res: { body: unknown }) => (res.body as Envelope).error;

  function expectEnvelope(body: unknown, code: string): void {
    expect(Object.keys((body as { error: object }).error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
    expect(body).toMatchObject({
      error: { code, message: expect.any(String), requestId: expect.any(String) },
    });
  }

  it('GET /health is public, ok and not cacheable', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('an unknown route under the prefix is a 404 envelope', async () => {
    const res = await http().get('/api/v1/no-such-route').expect(404);
    expectEnvelope(res.body, 'NOT_FOUND');
    expect(errorOf(res).details).toBeNull();
    expect(errorOf(res).requestId).toBe(res.headers['x-request-id']);
  });

  it('a route outside the prefix is a 404 envelope too, not an Express page', async () => {
    const res = await http().get('/no-such-route').expect(404);
    expectEnvelope(res.body, 'NOT_FOUND');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('malformed JSON is 400 MALFORMED_REQUEST and does not echo the body', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .set('Content-Type', 'application/json')
      .send(`{"cnic": "${CNIC_DIGITS}",`)
      .expect(400);
    expectEnvelope(res.body, 'MALFORMED_REQUEST');
    expect(res.text).not.toContain(CNIC_DIGITS);
  });

  it('a non-JSON body on a state-changing request is 415', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('name=x')
      .expect(415);
    expectEnvelope(res.body, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('a bodiless POST is not refused as 415', async () => {
    await http().post('/api/v1/test/log').expect(201);
  });

  it('a body over 100 kB is 413', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .send({ name: 'x'.repeat(110_000) })
      .expect(413);
    expectEnvelope(res.body, 'PAYLOAD_TOO_LARGE');
  });

  it('validation is 422 with nested field paths and UNKNOWN_FIELD', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .send({ name: 'x', classId: '012', guardians: [{ phone: 5 }], extra: true })
      .expect(422);
    expectEnvelope(res.body, 'VALIDATION_FAILED');
    const fields = errorOf(res).details.fields as { path: string; code: string }[];
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'extra', code: 'UNKNOWN_FIELD' }),
        expect.objectContaining({ path: 'classId', code: 'INVALID_VALUE' }),
        expect.objectContaining({ path: 'guardians[0].phone', code: 'INVALID_VALUE' }),
      ]),
    );
    // validationError { value: false }: the submitted values are not echoed.
    expect(JSON.stringify(res.body)).not.toContain('012');
  });

  it('R63: schoolId in a body is refused 422 UNKNOWN_FIELD', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .send({ name: 'x', classId: '12', guardians: [], schoolId: '1' })
      .expect(422);
    expect(errorOf(res).details.fields).toEqual([
      expect.objectContaining({ path: 'schoolId', code: 'UNKNOWN_FIELD' }),
    ]);
  });

  it('R63: an unknown query parameter is refused 422', async () => {
    const res = await http().get('/api/v1/test/things?schoolId=1').expect(422);
    expect(errorOf(res).details.fields[0]).toMatchObject({ path: 'schoolId', code: 'UNKNOWN_FIELD' });
  });

  it('a body id above int8 max is 422 on that field; int8 max itself passes', async () => {
    const res = await http()
      .post('/api/v1/test/things')
      .send({ name: 'x', classId: '9223372036854775808', guardians: [] })
      .expect(422);
    expect(errorOf(res).details.fields).toEqual([
      expect.objectContaining({ path: 'classId', code: 'INVALID_VALUE' }),
    ]);
    await http()
      .post('/api/v1/test/things')
      .send({ name: 'x', classId: '9223372036854775807', guardians: [] })
      .expect(201);
  });

  it('a valid body passes through', async () => {
    const body = { name: 'x', classId: '12', guardians: [{ phone: '+923001234567' }] };
    const res = await http().post('/api/v1/test/things').send(body).expect(201);
    expect(res.body).toEqual(body);
  });

  it('R66: a bigint id is serialised as a string', async () => {
    const res = await http().get('/api/v1/test/things').expect(200);
    expect(res.body).toEqual({ data: [{ id: '9007199254740993' }], page: 1, limit: 25, total: 1 });
  });

  it('R67: limit above 50 is 422; 50 is fine; page 0 and non-numbers are 422', async () => {
    await http().get('/api/v1/test/things?limit=51').expect(422);
    await http().get('/api/v1/test/things?page=0').expect(422);
    await http().get('/api/v1/test/things?limit=abc').expect(422);
    const res = await http().get('/api/v1/test/things?limit=50&page=2').expect(200);
    expect(res.body).toMatchObject({ page: 2, limit: 50 });
    const max = await http().get('/api/v1/test/things?page=999999&limit=1').expect(200);
    expect(max.body).toMatchObject({ page: 999999, limit: 1 });
  });

  it('page and limit must be plain decimal digits in range; anything else is 422 on that field', async () => {
    const bad = ['1e300', '0x10', ' 5 ', '1.0', '9007199254740993', '01', '+5', '-1', ''];
    for (const field of ['page', 'limit']) {
      for (const value of [...bad, ...(field === 'page' ? ['1000000'] : ['51', '100'])]) {
        const res = await http()
          .get('/api/v1/test/things')
          .query({ [field]: value })
          .expect(422);
        expectEnvelope(res.body, 'VALIDATION_FAILED');
        const fields = errorOf(res).details.fields as { path: string }[];
        expect(fields.map((f) => f.path)).toEqual(expect.arrayContaining([field]));
        expect(fields.every((f) => f.path === field)).toBe(true);
      }
    }
    // A repeated key arrives as an array; refused, not coerced.
    await http().get('/api/v1/test/things?page=1&page=2').expect(422);
  });

  it('a path id becomes a bigint; a malformed one is 404', async () => {
    const ok = await http().get('/api/v1/test/items/12').expect(200);
    expect(ok.body).toEqual({ id: '12', typeOfId: 'bigint' });
    for (const bad of ['abc', '0', '012', '-1', '99999999999999999999', '9223372036854775808']) {
      const res = await http().get(`/api/v1/test/items/${bad}`).expect(404);
      expectEnvelope(res.body, 'NOT_FOUND');
    }
  });

  it('R68: an undecorated route is refused with 500 and logged', async () => {
    const res = await http().get('/api/v1/test/undecorated').expect(500);
    expectEnvelope(res.body, 'INTERNAL_ERROR');
    expect(logLines.some((line) => line.includes('undecorated route'))).toBe(true);
  });

  it('an unexpected error is 500 INTERNAL_ERROR with nothing leaked', async () => {
    const res = await http().get('/api/v1/test/boom').expect(500);
    expectEnvelope(res.body, 'INTERNAL_ERROR');
    expect(res.text).not.toContain('boom');
    expect(res.text).not.toContain('stack');
  });

  it('R101: req.ip is the one trusted hop, not a client-supplied X-Forwarded-For entry', async () => {
    const res = await http()
      .get('/api/v1/test/ip')
      .set('X-Forwarded-For', '6.6.6.6, 10.0.0.7')
      .expect(200);
    expect((res.body as { ip: string }).ip).toBe('10.0.0.7');
  });

  it('throttling answers 429 RATE_LIMITED with Retry-After', async () => {
    let limited: request.Response | undefined;
    // Limit is 2 per minute; Redis may still hold hits from a run in the last minute.
    for (let i = 0; i < 3 && !limited; i++) {
      const res = await http().get('/api/v1/test/throttled');
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expectEnvelope(limited!.body, 'RATE_LIMITED');
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logs carry a requestId and no identity number, cookie, token or password', async () => {
    logLines.length = 0;
    await http()
      .get(`/api/v1/health?cnic=${CNIC_DASHED}&b=${CNIC_DIGITS}`)
      .set('Cookie', '__Host-asms_session=cookie-secret-value')
      .set('Authorization', 'Bearer bearer-secret-value')
      .expect(422); // unknown query parameters, but still a logged request
    await http().post('/api/v1/test/log').expect(201);
    await http().get('/api/v1/test/boom').expect(500);

    const output = logLines.join('');
    expect(output).toContain('logging a user');
    expect(output).toContain('[id]');
    for (const secret of [CNIC_DASHED, CNIC_DIGITS, 'cookie-secret-value', 'bearer-secret-value', 'hunter2']) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/\d{13}/);
    for (const line of logLines) {
      expect(JSON.parse(line)).toHaveProperty('requestId');
    }
  });
});

describe('health with the throttler storage down', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    // Every throttler hit fails, as it would with Redis unreachable.
    const failingStorage = {
      increment: () => Promise.reject(new Error('Redis unreachable')),
      onModuleDestroy: () => undefined,
    };
    app = await createTestApp({
      imports: [TestCoreModule],
      overrides: [{ provide: ThrottlerStorageRedisService, useValue: failingStorage }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health is still 200: it is not throttled', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it('a throttled route does fail, so the storage override is in effect', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/throttled');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
