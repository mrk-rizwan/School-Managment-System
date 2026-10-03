// /api/v1/platform/schools end to end (contracts/slice-1.md section 4) over the real AppModule,
// the real access guard and the real database. Sessions are written by test/support/platform.ts.
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { SCHOOL_STATUSES, type SchoolStatus } from '@asms/shared';
import { summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { buildOpenApiDocuments } from '../../src/openapi-documents';
import { SchoolCounterRepository } from '../../src/repositories/school-counter.repository';
import { createTestApp } from '../core/app';
import {
  createPlatformSession,
  createPlatformUser,
  signedInPlatformAdmin,
  type TestPlatformSession,
} from '../support/platform';
import { closeTestDb, createSchool, testDb, uniqueShortCode } from '../support/schools';

const BASE = '/api/v1/platform/schools';
const ID = /^[1-9][0-9]{0,18}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface School {
  id: string;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}
interface ErrorBody {
  error: {
    code: string;
    details: { field?: string; from?: string; to?: string; fields?: { path: string; code: string }[] };
  };
}
interface PageBody {
  data: School[];
  page: number;
  limit: number;
  total: number;
}

/** A word unique to one test, so list assertions see only that test's schools. */
const tag = () => `Tg${randomBytes(5).toString('hex')}`;

/** Sessions on this database waiting for a lock (tests run in band, so they are this test's). */
async function lockWaiters(): Promise<number> {
  const [row] = await testDb().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row?.n ?? 0;
}

async function untilLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await lockWaiters()) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected ${n} request(s) waiting on the school row lock`);
}

/**
 * Holds the school row lock (changing nothing) while `run` starts requests, so every one of them
 * reads the row before any can write it: the interleaving a stale read gets wrong, made certain.
 */
async function withRowLocked<T>(id: bigint, run: () => Promise<T>): Promise<T> {
  return testDb().$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM schools WHERE id = ${id} FOR UPDATE`;
      return run();
    },
    { timeout: 20_000 },
  );
}

describe('platform schools', () => {
  let app: NestExpressApplication;
  let admin: TestPlatformSession & { id: bigint };
  const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signedInPlatformAdmin();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string, session: { cookie: string } = admin) =>
    http().get(path).set('Cookie', session.cookie);
  const post = (path: string, body: object, session: { cookie: string } = admin) =>
    http().post(path).set('Cookie', session.cookie).set('Origin', origin).send(body);
  const patch = (path: string, body: object) =>
    http().patch(path).set('Cookie', admin.cookie).set('Origin', origin).send(body);

  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details.fields ?? []).map((f) => `${f.path}:${f.code}`);
  const auditRows = (schoolId: bigint | string, action?: string) =>
    testDb().platformAuditLog.findMany({
      where: { schoolId: BigInt(schoolId), ...(action ? { action } : {}) },
      orderBy: { id: 'asc' },
    });

  const createViaApi = async (body: Record<string, unknown> = {}): Promise<School> => {
    const res = await post(BASE, { name: 'Created School', shortCode: uniqueShortCode(), ...body });
    expect(res.status).toBe(201);
    return res.body as School;
  };

  describe('access', () => {
    it('refuses a request with no platform session', async () => {
      const res = await http().get(BASE).expect(401);
      expect(errorOf(res).code).toBe('AUTH_REQUIRED');
    });

    it('refuses a session that must still change its password, and an enrolment-stage one', async () => {
      const mustChange = await createPlatformSession(
        (await createPlatformUser({ mustChangePassword: true })).id,
      );
      expect(errorOf(await get(BASE, mustChange).expect(403)).code).toBe(
        'PASSWORD_CHANGE_REQUIRED',
      );
      const enrolling = await createPlatformSession(
        (await createPlatformUser({ totpEnrolled: false })).id,
        { stage: 'totp_enrolment' },
      );
      expect(errorOf(await get(BASE, enrolling).expect(403)).code).toBe('TOTP_REQUIRED');
    });

    it('refuses a write without the app Origin', async () => {
      const res = await http()
        .post(BASE)
        .set('Cookie', admin.cookie)
        .send({ name: 'No Origin', shortCode: uniqueShortCode() })
        .expect(403);
      expect(errorOf(res).code).toBe('ORIGIN_REJECTED');
    });
  });

  describe('POST /schools', () => {
    it('creates school, settings, admission counter and audit row; ids are strings', async () => {
      const shortCode = uniqueShortCode();
      const res = await post(BASE, { name: '  Iqra Grammar School ', shortCode: ` ${shortCode.toUpperCase()} ` }).expect(201);
      const school = res.body as School;
      expect(school).toEqual({
        id: expect.stringMatching(ID),
        name: 'Iqra Grammar School',
        shortCode,
        status: 'trial',
        timezone: 'Asia/Karachi',
        // contracts/slice-9.md §2.2: the messaging knobs, at their defaults.
        smsMonthlyCap: 500,
        whatsappProvider: 'platform_default',
        smsProvider: 'platform_default',
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });

      const schoolId = BigInt(school.id);
      const settings = await testDb().schoolSettings.findMany({ where: { schoolId } });
      expect(settings).toEqual([
        expect.objectContaining({ feeDueDay: 10, studentLoginEnabled: false }),
      ]);
      const counters = await testDb().schoolCounter.findMany({ where: { schoolId } });
      expect(counters).toEqual([expect.objectContaining({ name: 'admission_no', value: 0n })]);

      const audit = await auditRows(schoolId);
      expect(audit).toEqual([
        expect.objectContaining({
          actorPlatformUserId: admin.id,
          schoolId,
          action: 'school.created',
          subjectType: 'school',
          subjectId: schoolId,
          reason: null,
          metadata: {
            shortCode,
            name: 'Iqra Grammar School',
            timezone: 'Asia/Karachi',
            feeDueDay: 10,
          },
        }),
      ]);
    });

    it('takes timezone and feeDueDay when given', async () => {
      const school = await createViaApi({ timezone: 'Asia/Dubai', feeDueDay: 28 });
      expect(school.timezone).toBe('Asia/Dubai');
      const settings = await testDb().schoolSettings.findFirst({
        where: { schoolId: BigInt(school.id) },
      });
      expect(settings?.feeDueDay).toBe(28);
    });

    it('a taken short code is 409 SCHOOL_SHORT_CODE_TAKEN and creates nothing', async () => {
      const first = await createViaApi();
      const res = await post(BASE, { name: 'Second', shortCode: first.shortCode.toUpperCase() });
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'SCHOOL_SHORT_CODE_TAKEN',
        details: { field: 'shortCode' },
      });
      expect(await testDb().school.count({ where: { shortCode: first.shortCode } })).toBe(1);
      expect(await auditRows(first.id)).toHaveLength(1);
    });

    it.each([
      [{ feeDueDay: 29 }, 'feeDueDay:INVALID_VALUE'],
      [{ feeDueDay: 0 }, 'feeDueDay:INVALID_VALUE'],
      [{ feeDueDay: '10' }, 'feeDueDay:INVALID_VALUE'],
      [{ feeDueDay: 10.5 }, 'feeDueDay:INVALID_VALUE'],
      [{ feeDueDay: null }, 'feeDueDay:INVALID_VALUE'],
      [{ timezone: 'Mars/Olympus' }, 'timezone:INVALID_VALUE'],
      [{ timezone: null }, 'timezone:INVALID_VALUE'],
      [{ shortCode: 'ab' }, 'shortCode:INVALID_VALUE'],
      [{ shortCode: 'abc-123' }, 'shortCode:INVALID_VALUE'],
      [{ shortCode: 'abcdefghijklm' }, 'shortCode:INVALID_VALUE'],
      [{ name: 'x' }, 'name:INVALID_VALUE'],
      [{ name: 'Bad\u0007Name' }, 'name:INVALID_VALUE'],
      [{ name: 'School 3520212345671' }, 'name:INVALID_VALUE'],
      [{ schoolId: '1' }, 'schoolId:UNKNOWN_FIELD'],
      [{ status: 'active' }, 'status:UNKNOWN_FIELD'],
    ])('%j is 422 (%s)', async (override, expected) => {
      const shortCode = uniqueShortCode();
      const res = await post(BASE, { name: 'Valid Name', shortCode, ...override });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res)).toContain(expected);
      expect(await testDb().school.count({ where: { shortCode } })).toBe(0);
    });
  });

  it('documents feeDueDay as an integer within the allowed days', () => {
    const { platform } = buildOpenApiDocuments(app);
    const schema = platform.components?.schemas?.CreateSchoolDto as
      | { properties: Record<string, unknown> }
      | undefined;
    expect(schema?.properties.feeDueDay).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 28,
      default: 10,
    });
  });

  describe('POST /schools is one unit of work', () => {
    let failing: NestExpressApplication;
    // The school id the failing request had inserted (and settings written for) before it failed.
    const attempted: bigint[] = [];

    beforeAll(async () => {
      failing = await createTestApp({
        overrides: [
          {
            // Fails the third insert, after schools and school_settings were written.
            provide: SchoolCounterRepository,
            useValue: {
              create: (schoolId: bigint) => {
                attempted.push(schoolId);
                return Promise.reject(new Error('forced counter failure'));
              },
            },
          },
        ],
      });
    });

    afterAll(async () => {
      await failing.close();
    });

    it('a failure after the school and settings inserts leaves neither, and no audit row', async () => {
      const shortCode = uniqueShortCode();
      const res = await request(failing.getHttpServer())
        .post(BASE)
        .set('Cookie', admin.cookie)
        .set('Origin', origin)
        .send({ name: 'Rolled Back', shortCode });
      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_ERROR');
      expect(attempted).toHaveLength(1);
      const [schoolId] = attempted;
      if (schoolId === undefined) throw new Error('the counter step never ran');
      expect(await testDb().school.count({ where: { id: schoolId } })).toBe(0);
      expect(await testDb().school.count({ where: { shortCode } })).toBe(0);
      expect(await testDb().schoolSettings.count({ where: { schoolId } })).toBe(0);
      expect(await testDb().platformAuditLog.count({ where: { schoolId } })).toBe(0);
      expect(
        await testDb().platformAuditLog.count({
          where: { action: 'school.created', metadata: { path: ['shortCode'], equals: shortCode } },
        }),
      ).toBe(0);
    });
  });

  describe('GET /schools/:id', () => {
    it('returns the school', async () => {
      const created = await createViaApi();
      const res = await get(`${BASE}/${created.id}`).expect(200);
      expect(res.body).toEqual(created);
    });

    it.each([['999999999999'], ['abc'], ['0'], ['01'], ['99999999999999999999']])(
      '%s is 404',
      async (id) => {
        const res = await get(`${BASE}/${id}`).expect(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      },
    );

    it('an unknown query parameter is 422', async () => {
      const created = await createViaApi();
      await get(`${BASE}/${created.id}?x=1`).expect(422);
    });
  });

  describe('PATCH /schools/:id', () => {
    it('changes name and timezone and audits only what changed', async () => {
      const created = await createViaApi({ name: 'Old Name' });
      const res = await patch(`${BASE}/${created.id}`, {
        name: ' New Name ',
        timezone: 'Asia/Karachi',
      }).expect(200);
      expect(res.body).toMatchObject({ id: created.id, name: 'New Name', timezone: 'Asia/Karachi' });
      const updated = await auditRows(created.id, 'school.updated');
      expect(updated).toEqual([
        expect.objectContaining({
          actorPlatformUserId: admin.id,
          subjectType: 'school',
          subjectId: BigInt(created.id),
          metadata: { changes: { name: { from: 'Old Name', to: 'New Name' } } },
        }),
      ]);
    });

    it('an empty body or unchanged values are a 200 no-op with no audit row', async () => {
      const created = await createViaApi({ name: 'Same Name' });
      await patch(`${BASE}/${created.id}`, {}).expect(200);
      const res = await patch(`${BASE}/${created.id}`, { name: 'Same Name' }).expect(200);
      expect((res.body as School).updatedAt).toBe(created.updatedAt);
      expect(await auditRows(created.id, 'school.updated')).toEqual([]);
    });

    it.each([[null], ['newcode'], [undefined]])(
      'shortCode present (%p) is 409 SCHOOL_SHORT_CODE_IMMUTABLE',
      async (value) => {
        const created = await createViaApi();
        const res = await patch(`${BASE}/${created.id}`, {
          name: 'Ignored',
          shortCode: value === undefined ? created.shortCode : value,
        }).expect(409);
        expect(errorOf(res).code).toBe('SCHOOL_SHORT_CODE_IMMUTABLE');
        const row = await testDb().school.findUnique({ where: { id: BigInt(created.id) } });
        expect(row).toMatchObject({ shortCode: created.shortCode, name: created.name });
      },
    );

    it('status, null and invalid values are 422', async () => {
      const created = await createViaApi();
      expect(fieldsOf(await patch(`${BASE}/${created.id}`, { status: 'active' }).expect(422))).toEqual(
        ['status:UNKNOWN_FIELD'],
      );
      await patch(`${BASE}/${created.id}`, { name: null }).expect(422);
      await patch(`${BASE}/${created.id}`, { timezone: null }).expect(422);
      await patch(`${BASE}/${created.id}`, { timezone: 'Nowhere/Here' }).expect(422);
    });

    it('a terminated school is 409 SCHOOL_TERMINATED and unchanged', async () => {
      const school = await createSchool({ name: 'Frozen', status: 'terminated' });
      const res = await patch(`${BASE}/${school.id}`, { name: 'Thawed' }).expect(409);
      expect(errorOf(res).code).toBe('SCHOOL_TERMINATED');
      const row = await testDb().school.findUnique({ where: { id: school.id } });
      expect(row?.name).toBe('Frozen');
    });

    it('an unknown school is 404', async () => {
      await patch(`${BASE}/999999999999`, { name: 'Nobody' }).expect(404);
    });

    const nameChanges = async (id: bigint) =>
      (await auditRows(id, 'school.updated')).map(
        (a) => (a.metadata as { changes: { name: { from: string; to: string } } }).changes.name,
      );

    it('concurrent changes are decided under the row lock: the audit chains X to Y to Z', async () => {
      const school = await createSchool({ name: 'Name X' });
      const [first, second] = await withRowLocked(school.id, async () => {
        const toY = patch(`${BASE}/${school.id}`, { name: 'Name Y' }).then((r) => r);
        await untilLockWaiters(1);
        const toZ = patch(`${BASE}/${school.id}`, { name: 'Name Z' }).then((r) => r);
        await untilLockWaiters(2);
        return [toY, toZ];
      });
      expect([(await first).status, (await second).status]).toEqual([200, 200]);
      expect(await nameChanges(school.id)).toEqual([
        { from: 'Name X', to: 'Name Y' },
        { from: 'Name Y', to: 'Name Z' },
      ]);
      const row = await testDb().school.findUnique({ where: { id: school.id } });
      expect(row?.name).toBe('Name Z');
    });

    it('setting the value a concurrent PATCH is replacing is applied after it, not a no-op', async () => {
      const school = await createSchool({ name: 'Name X' });
      const [toY, backToX] = await withRowLocked(school.id, async () => {
        const y = patch(`${BASE}/${school.id}`, { name: 'Name Y' }).then((r) => r);
        await untilLockWaiters(1);
        // Reads X, as the first did. Decided on that read, it would answer at once as a no-op.
        const x = patch(`${BASE}/${school.id}`, { name: 'Name X' }).then((r) => r);
        await untilLockWaiters(2);
        return [y, x];
      });
      expect((await toY).status).toBe(200);
      const res = await backToX;
      expect(res.status).toBe(200);
      expect((res.body as School).name).toBe('Name X');
      expect(await nameChanges(school.id)).toEqual([
        { from: 'Name X', to: 'Name Y' },
        { from: 'Name Y', to: 'Name X' },
      ]);
      const row = await testDb().school.findUnique({ where: { id: school.id } });
      expect(row?.name).toBe('Name X');
    });

  });

  describe('POST /schools/:id/change-status', () => {
    const TARGETS = ['active', 'suspended', 'terminated'] as const;
    const LEGAL: Record<SchoolStatus, readonly string[]> = {
      trial: ['active', 'suspended', 'terminated'],
      active: ['suspended', 'terminated'],
      suspended: ['active', 'terminated'],
      terminated: [],
    };
    const cases = SCHOOL_STATUSES.flatMap((from) => TARGETS.map((to) => [from, to] as const));

    it.each(cases)('%s -> %s', async (from, to) => {
      const school = await createSchool({ status: from });
      const res = await post(`${BASE}/${school.id}/change-status`, {
        status: to,
        reason: '  Invoice unpaid for March  ',
      });
      const audit = await auditRows(school.id, 'school.status_changed');
      const row = await testDb().school.findUnique({ where: { id: school.id } });

      if (from === to) {
        expect(res.status).toBe(200);
        expect((res.body as School).status).toBe(from);
        expect(audit).toEqual([]);
      } else if (LEGAL[from].includes(to)) {
        expect(res.status).toBe(200);
        expect((res.body as School).status).toBe(to);
        expect(row?.status).toBe(to);
        expect(audit).toEqual([
          expect.objectContaining({
            actorPlatformUserId: admin.id,
            subjectType: 'school',
            subjectId: school.id,
            reason: 'Invoice unpaid for March',
            metadata: { from, to },
          }),
        ]);
      } else {
        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({
          code: 'ILLEGAL_STATUS_TRANSITION',
          details: { from, to },
        });
        expect(row?.status).toBe(from);
        expect(audit).toEqual([]);
      }
    });

    it.each([
      [{ status: 'trial', reason: 'Back to trial' }, 'status:INVALID_VALUE'],
      [{ status: 'active' }, 'reason:INVALID_VALUE'],
      [{ status: 'active', reason: '  ab ' }, 'reason:INVALID_VALUE'],
      [{ status: 'active', reason: 'x'.repeat(501) }, 'reason:INVALID_VALUE'],
      [{ status: 'active', reason: 'Owner CNIC 35202-1234567-1' }, 'reason:INVALID_VALUE'],
      [{ status: 'active', reason: 'Owner 3520212345671' }, 'reason:INVALID_VALUE'],
    ])('%j is 422 (%s)', async (body, expected) => {
      const school = await createSchool({ status: 'trial' });
      const res = await post(`${BASE}/${school.id}/change-status`, body).expect(422);
      expect(fieldsOf(res)).toContain(expected);
    });

    it('concurrent identical changes apply once: one audit row, both 200', async () => {
      const school = await createSchool({ status: 'active' });
      const send = () =>
        post(`${BASE}/${school.id}/change-status`, { status: 'suspended', reason: 'Unpaid' });
      const results = await Promise.all([send(), send(), send()]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(await auditRows(school.id, 'school.status_changed')).toHaveLength(1);
    });

    it('concurrent conflicting changes: each applied change is audited from the status it saw', async () => {
      const school = await createSchool({ status: 'active' });
      const results = await Promise.all([
        post(`${BASE}/${school.id}/change-status`, { status: 'terminated', reason: 'Closed' }),
        post(`${BASE}/${school.id}/change-status`, { status: 'suspended', reason: 'Unpaid' }),
      ]);
      const audit = await auditRows(school.id, 'school.status_changed');
      const row = await testDb().school.findUnique({ where: { id: school.id } });
      // Whatever the order, the audit trail chains from active to the final status.
      const chain = audit.map((a) => a.metadata as { from: string; to: string });
      expect(chain[0]?.from).toBe('active');
      chain.slice(1).forEach((step, i) => expect(step.from).toBe(chain[i]?.to));
      expect(chain.at(-1)?.to).toBe(row?.status);
      expect(results.filter((r) => r.status === 200)).toHaveLength(audit.length);
    });

    it('an unknown school is 404', async () => {
      await post(`${BASE}/999999999999/change-status`, { status: 'active', reason: 'Paid up' }).expect(
        404,
      );
    });
  });

  describe('GET /schools', () => {
    it('filters by q (name contains, short code prefix), by status, sorts and pages', async () => {
      const t = tag();
      const names = [`${t} Alpha`, `${t} Bravo`, `${t} Charlie`];
      for (const name of names) await createViaApi({ name });
      const suspended = await createSchool({ name: `${t} Delta`, status: 'suspended' });

      const all = (await get(`${BASE}?q=${t.toLowerCase()}`).expect(200)).body as PageBody;
      expect(all.total).toBe(4);
      expect(all.data.map((s) => s.name)).toEqual([...names, `${t} Delta`]);
      expect(all.data.every((s) => ID.test(s.id))).toBe(true);

      const page2 = (await get(`${BASE}?q=${t}&sort=-name&limit=2&page=2`).expect(200))
        .body as PageBody;
      expect(page2).toMatchObject({ page: 2, limit: 2, total: 4 });
      expect(page2.data.map((s) => s.name)).toEqual([`${t} Bravo`, `${t} Alpha`]);

      const onlySuspended = (await get(`${BASE}?q=${t}&status=suspended`).expect(200))
        .body as PageBody;
      expect(onlySuspended.data.map((s) => s.id)).toEqual([String(suspended.id)]);

      const byCode = (await get(`${BASE}?q=${suspended.shortCode.slice(0, 6).toUpperCase()}`).expect(200))
        .body as PageBody;
      expect(byCode.data.map((s) => s.id)).toContain(String(suspended.id));
    });

    it('treats % _ and \\ in q as literal characters', async () => {
      const t = tag();
      await createViaApi({ name: `${t} 100% Sure` });
      await createViaApi({ name: `${t} 100X Sure` });
      const pct = (await get(`${BASE}?q=${encodeURIComponent(`${t} 100%`)}`).expect(200))
        .body as PageBody;
      expect(pct.data.map((s) => s.name)).toEqual([`${t} 100% Sure`]);
      const under = (await get(`${BASE}?q=${encodeURIComponent(`${t} 100_`)}`).expect(200))
        .body as PageBody;
      expect(under.total).toBe(0);
      // Unescaped, the backslash would make LIKE read `\B` as a plain B and match "AB" instead.
      await createViaApi({ name: `${t} A\\B` });
      await createViaApi({ name: `${t} AB` });
      const slash = (await get(`${BASE}?q=${encodeURIComponent(`${t} A\\B`)}`).expect(200))
        .body as PageBody;
      expect(slash.data.map((s) => s.name)).toEqual([`${t} A\\B`]);
    });

    it('sorts by every allowlisted field in both directions, ties broken by id ascending', async () => {
      const t = tag();
      const code = uniqueShortCode().slice(0, 11);
      const at = Date.parse('2026-01-01T00:00:00.000Z');
      // Inserted in this order, so ids ascend r1 < r2 < r3 < r4. Ties: name (r2, r4), status
      // (r1, r3), createdAt (r2, r3). Status sorts in enum order: trial, active, suspended.
      const seed = [
        ['r1', 'Bravo', 'b', 'active', at + 1000],
        ['r2', 'Alpha', 'c', 'trial', at],
        ['r3', 'Charlie', 'a', 'active', at],
        ['r4', 'Alpha', 'd', 'suspended', at + 2000],
      ] as const;
      const label = new Map<string, string>();
      for (const [key, name, suffix, status, createdAt] of seed) {
        const row = await testDb().school.create({
          data: {
            name: `${t} ${name}`,
            shortCode: `${code}${suffix}`,
            status,
            createdAt: new Date(createdAt),
          },
        });
        label.set(String(row.id), key);
      }
      const expected: Record<string, string[]> = {
        name: ['r2', 'r4', 'r1', 'r3'],
        '-name': ['r3', 'r1', 'r2', 'r4'],
        shortCode: ['r3', 'r1', 'r2', 'r4'],
        '-shortCode': ['r4', 'r2', 'r1', 'r3'],
        status: ['r2', 'r1', 'r3', 'r4'],
        '-status': ['r4', 'r1', 'r3', 'r2'],
        createdAt: ['r2', 'r3', 'r1', 'r4'],
        '-createdAt': ['r4', 'r1', 'r2', 'r3'],
      };
      for (const [sort, order] of Object.entries(expected)) {
        const page = (await get(`${BASE}?q=${t}&sort=${sort}`).expect(200)).body as PageBody;
        expect([sort, page.data.map((s) => label.get(s.id))]).toEqual([sort, order]);
      }
      // No sort given is name ascending.
      const byDefault = (await get(`${BASE}?q=${t}`).expect(200)).body as PageBody;
      expect(byDefault.data.map((s) => label.get(s.id))).toEqual(expected.name);
    });

    it.each([
      ['limit=51'],
      ['limit=0'],
      ['page=0'],
      ['sort=id'],
      ['sort=name&sort=-name'],
      ['status=deleted'],
      ['q=a'],
      [`q=${'a'.repeat(101)}`],
      ['q=3520212345671'],
      ['schoolId=1'],
    ])('%s is 422', async (query) => {
      const res = await get(`${BASE}?${query}`).expect(422);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('defaults to page 1, limit 25', async () => {
      const res = (await get(BASE).expect(200)).body as PageBody;
      expect(res).toMatchObject({ page: 1, limit: 25 });
      expect(res.data.length).toBeLessThanOrEqual(25);
    });
  });

  describe('constraint names behind the mapped codes (recorded shapes still hold)', () => {
    it('short code unique, short code immutable and fee due day check name themselves', async () => {
      const school = await createSchool();
      const db = testDb();
      const unique = await db.school
        .create({ data: { name: 'Dup', shortCode: school.shortCode } })
        .catch((e: unknown) => e);
      expect(summariseDatabaseError(unique)).toEqual({
        prismaCode: 'P2002',
        constraint: 'schools_short_code_key',
      });
      const immutable = await db.school
        .update({ where: { id: school.id }, data: { shortCode: uniqueShortCode() } })
        .catch((e: unknown) => e);
      expect(summariseDatabaseError(immutable)?.constraint).toBe('schools_short_code_immutable');
      const check = await db.schoolSettings
        .create({ data: { schoolId: school.id, feeDueDay: 29 } })
        .catch((e: unknown) => e);
      expect(summariseDatabaseError(check)?.constraint).toBe('school_settings_fee_due_day_check');
    });
  });
});
