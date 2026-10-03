// /api/v1/guardians end to end (contracts/slice-5.md) over the real AppModule, the real access
// guard and the real database. Sessions are written by test/support/school-session.ts.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createStudent, linkGuardian } from '../support/students';

const BASE = '/api/v1/guardians';
const ORIGIN = new URL(loadEnv().APP_URL).origin;
const ID = /^[1-9][0-9]{0,18}$/;

interface Guardian {
  id: string;
  fullName: string;
  cnicMasked: string | null;
  hasCnic: boolean;
  phone: string | null;
  hasPhone: boolean;
  contactCapability: string;
  status: string;
  mergedIntoId: string | null;
  userId: string | null;
  email?: string | null;
  address?: string | null;
}
interface ErrorBody {
  error: {
    code: string;
    details: { guardianId?: string; fields?: { path: string; code: string }[] } | null;
  };
}

const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
const masked = (d: string) => `${d.slice(0, 5)}-*****-${d.slice(12)}`;

describe('guardians (e2e)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let office: string;
  /** Every response body and log line of the run, checked for identity numbers at the end (R16). */
  const bodies: string[] = [];
  const logs: string[] = [];
  const db = testDb();

  const http = () => request(app.getHttpServer());
  const record = <T extends { text: string }>(res: T): T => {
    bodies.push(res.text);
    return res;
  };
  const get = async (path: string, cookie = office) =>
    record(await http().get(path).set('Cookie', cookie));
  const send = async (
    method: 'post' | 'patch',
    path: string,
    body: object | undefined,
    cookie = office,
  ) => {
    const req = http()[method](path).set('Cookie', cookie).set('Origin', ORIGIN);
    return record(await (body === undefined ? req : req.send(body)));
  };
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

  async function sessionFor(
    target: TestSchool,
    systemRole: 'principal' | 'office_staff' | 'teacher',
  ): Promise<string> {
    const user = await createSchoolUser(db, target, { systemRole });
    return (await createSchoolSession(db, target, user)).cookie;
  }

  async function createGuardian(body: Record<string, unknown> = {}, cookie = office) {
    const res = await send(
      'post',
      BASE,
      {
        fullName: 'Ahmed Khan',
        cnic: randomIdentityDigits(),
        contactCapability: 'whatsapp',
        ...body,
      },
      cookie,
    );
    expect(res.status).toBe(201);
    return res.body as Guardian;
  }

  beforeAll(async () => {
    app = await createTestApp({ logStream: { write: (line: string) => void logs.push(line) } });
    school = await createSchool();
    office = await sessionFor(school, 'office_staff');
  });

  // A fresh office user per test: CNIC writes spend the per-user identity-probe budget.
  beforeEach(async () => {
    office = await sessionFor(school, 'office_staff');
  });

  it('create and patch with a CNIC spend the identity-probe budget; a patch without one does not', async () => {
    const target = await createGuardian({ cnic: null, phone: '03001112233' });
    for (let i = 0; i < 15; i++) await createGuardian();
    for (let i = 0; i < 15; i++) {
      expect(
        (await send('patch', `${BASE}/${target.id}`, { cnic: randomIdentityDigits() })).status,
      ).toBe(200);
    }
    const create = await send('post', BASE, {
      fullName: 'Ahmed Khan',
      cnic: randomIdentityDigits(),
      contactCapability: 'whatsapp',
    });
    expect(create.status).toBe(429);
    expect(errorOf(create).code).toBe('RATE_LIMITED');
    const patched = await send('patch', `${BASE}/${target.id}`, { cnic: randomIdentityDigits() });
    expect(patched.status).toBe(429);
    expect((await send('patch', `${BASE}/${target.id}`, { fullName: 'Ahmed Raza' })).status).toBe(
      200,
    );
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('401 without a session, 403 for a teacher (no guardian.manage, no student.create)', async () => {
    expect(record(await http().get(BASE)).status).toBe(401);
    const teacher = await sessionFor(school, 'teacher');
    expect(errorOf(await get(BASE, teacher)).code).toBe('PERMISSION_DENIED');
    const lookup = await send('post', `${BASE}/lookup`, { phone: '03001234567' }, teacher);
    expect(lookup.status).toBe(403);
  });

  it('POST normalises input, stores and returns the CNIC masked', async () => {
    const digits = randomIdentityDigits();
    const res = await send('post', BASE, {
      fullName: '  Ahmed   Raza  Khan ',
      cnic: dashed(digits),
      phone: '0300-123 4567',
      email: '  Parent@Example.COM ',
      contactCapability: 'smartphone_data',
      address: ' House 7, Street 2 ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(ID),
      fullName: 'Ahmed Raza Khan',
      cnicMasked: masked(digits),
      hasCnic: true,
      phone: '+923001234567',
      hasPhone: true,
      contactCapability: 'smartphone_data',
      status: 'active',
      mergedIntoId: null,
      userId: null,
      email: 'parent@example.com',
      address: 'House 7, Street 2',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(res.text).not.toContain(digits);
  });

  it('POST 422: bad phone, bad CNIC, no or unknown contact capability, a schoolId field', async () => {
    const base = { fullName: 'Valid Name', contactCapability: 'keypad' };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, phone: '12' }, 'phone'],
      [{ ...base, cnic: '35201-123-1' }, 'cnic'],
      [{ fullName: 'Valid Name' }, 'contactCapability'],
      [{ ...base, contactCapability: 'unknown' }, 'contactCapability'],
      [{ ...base, fullName: 'A' }, 'fullName'],
      [{ ...base, fullName: `Name ${randomIdentityDigits()}` }, 'fullName'],
      [{ ...base, schoolId: '1' }, 'schoolId'],
    ];
    for (const [body, path] of cases) {
      const res = await send('post', BASE, body);
      expect(res.status).toBe(422);
      expect(errorOf(res).details?.fields?.map((f) => f.path)).toContain(path);
    }
  });

  it('POST accepts null for the optional fields (recordable without CNIC or phone, R27)', async () => {
    const created = await createGuardian({ cnic: null, phone: null, email: null, address: null });
    expect(created).toMatchObject({ hasCnic: false, cnicMasked: null, hasPhone: false });
  });

  it('POST 409 GUARDIAN_CNIC_EXISTS points at the existing guardian, dashed or not', async () => {
    const digits = randomIdentityDigits();
    const first = await createGuardian({ cnic: digits });
    const res = await send('post', BASE, {
      fullName: 'Second Entry',
      cnic: dashed(digits),
      contactCapability: 'keypad',
    });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'GUARDIAN_CNIC_EXISTS',
      details: { guardianId: first.id },
    });
  });

  it('GET list filters and paginates; a CNIC in q is 422 pointing at the lookup', async () => {
    const own = await createSchool();
    const cookie = await sessionFor(own, 'office_staff');
    const a = await createGuardian({ fullName: 'Asma Bibi', phone: '03331234567' }, cookie);
    const b = await createGuardian({ fullName: 'Bilal Ahmed', cnic: null }, cookie);

    const all = await get(`${BASE}?status=active&sort=-fullName`, cookie);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, limit: 25, total: 2 });
    expect((all.body as { data: Guardian[] }).data.map((g) => g.id)).toEqual([b.id, a.id]);

    const ids = async (query: string) =>
      ((await get(`${BASE}?${query}`, cookie)).body as { data: Guardian[] }).data.map((g) => g.id);
    expect(await ids('hasCnic=false')).toEqual([b.id]);
    expect(await ids('hasPhone=true')).toEqual([a.id]);
    expect(await ids('hasLogin=false')).toEqual([a.id, b.id]);
    expect(await ids('q=bilal')).toEqual([b.id]);
    expect(await ids('q=0333123')).toEqual([a.id]);

    for (const query of [
      `q=${randomIdentityDigits()}`,
      `q=${dashed(randomIdentityDigits())}`,
      'hasCnic=yes',
      'sort=phone',
      'limit=51',
      'q=a',
      'unknown=1',
    ]) {
      expect((await get(`${BASE}?${query}`, cookie)).status).toBe(422);
    }
  });

  it('GET :id returns the detail; another school’s or a malformed id is 404', async () => {
    const created = await createGuardian({ email: 'x@example.com' });
    const res = await get(`${BASE}/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, email: 'x@example.com', address: null });

    const other = await createSchool();
    const otherCookie = await sessionFor(other, 'office_staff');
    for (const path of [`${BASE}/${created.id}`, `${BASE}/${created.id}/students`]) {
      expect(errorOf(await get(path, otherCookie)).code).toBe('NOT_FOUND');
    }
    const patch = await send(
      'patch',
      `${BASE}/${created.id}`,
      { fullName: 'Intruder' },
      otherCookie,
    );
    expect(patch.status).toBe(404);
    const issue = await send('post', `${BASE}/${created.id}/issue-login`, undefined, otherCookie);
    expect(issue.status).toBe(404);
    expect((await get(`${BASE}/abc`)).status).toBe(404);
    expect((await get(`${BASE}/${created.id}`)).body).toMatchObject({ fullName: 'Ahmed Khan' });
  });

  it('GET :id/students is an empty page until slice 6', async () => {
    const created = await createGuardian();
    const res = await get(`${BASE}/${created.id}/students?includeEnded=true`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], page: 1, limit: 25, total: 0 });
  });

  it('PATCH: absent unchanged, null clears; null fullName or contactCapability is 422', async () => {
    const created = await createGuardian({ phone: '03001112222', email: 'a@example.com' });
    for (const body of [{ fullName: null }, { contactCapability: null }]) {
      expect((await send('patch', `${BASE}/${created.id}`, body)).status).toBe(422);
    }
    const res = await send('patch', `${BASE}/${created.id}`, { phone: null, email: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fullName: 'Ahmed Khan',
      phone: null,
      hasPhone: false,
      email: null,
      hasCnic: true,
    });
  });

  it('lookup: by CNIC in the body, exactly one key, R31 survivor, never echoing the CNIC', async () => {
    const digits = randomIdentityDigits();
    const merged = await createGuardian({ cnic: digits });
    const survivor = await createGuardian({ cnic: null, fullName: 'Survivor Khan' });
    await db.guardian.update({
      where: { schoolId_id: { schoolId: school.id, id: BigInt(merged.id) } },
      data: { status: 'merged', mergedIntoId: BigInt(survivor.id) },
    });

    const res = await send('post', `${BASE}/lookup`, { cnic: dashed(digits) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          guardian: expect.objectContaining({ id: survivor.id, status: 'active' }),
          resolvedFromId: merged.id,
          students: [],
        },
      ],
      truncated: false,
    });
    expect(res.text).not.toContain(digits);

    // The merged row itself is returned as stored, and is read-only.
    expect((await get(`${BASE}/${merged.id}`)).body).toMatchObject({
      status: 'merged',
      mergedIntoId: survivor.id,
    });
    const patch = await send('patch', `${BASE}/${merged.id}`, { fullName: 'Changed' });
    expect(errorOf(patch).code).toBe('GUARDIAN_MERGED');

    for (const body of [{}, { cnic: digits, phone: '03001234567' }]) {
      const bad = await send('post', `${BASE}/lookup`, body);
      expect(bad.status).toBe(422);
      expect(errorOf(bad).details?.fields).toEqual([
        expect.objectContaining({ path: '', code: 'INVALID_VALUE' }),
      ]);
    }
    expect((await send('post', `${BASE}/lookup`, { cnic: '123' })).status).toBe(422);
  });

  it('lookup refuses null on either key as a field error (422, never a 500)', async () => {
    for (const [body, path] of [
      [{ cnic: null }, 'cnic'],
      [{ phone: null }, 'phone'],
      [{ cnic: null, phone: '03001234567' }, 'cnic'],
      [{ cnic: randomIdentityDigits(), phone: null }, 'phone'],
    ] as const) {
      const res = await send('post', `${BASE}/lookup`, body);
      expect(res.status).toBe(422);
      const paths = (errorOf(res).details?.fields ?? []).map((f) => f.path);
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set([path]));
    }
  });

  it('lookup R32: every guardian sharing a phone is returned', async () => {
    const phone = '+923009998877';
    const own = await createSchool();
    const cookie = await sessionFor(own, 'office_staff');
    const one = await createGuardian({ phone, fullName: 'Father One', cnic: null }, cookie);
    const two = await createGuardian({ phone, fullName: 'Mother Two', cnic: null }, cookie);
    const res = await send('post', `${BASE}/lookup`, { phone: '0300 9998877' }, cookie);
    expect((res.body as { data: { guardian: Guardian }[] }).data.map((h) => h.guardian.id)).toEqual(
      [one.id, two.id],
    );
  });

  it('lookup is throttled per user: 30 a minute, then 429 with Retry-After', async () => {
    const cookie = await sessionFor(school, 'office_staff');
    for (let i = 0; i < 30; i++) {
      expect((await send('post', `${BASE}/lookup`, { phone: '03000000000' }, cookie)).status).toBe(
        200,
      );
    }
    const limited = await send('post', `${BASE}/lookup`, { phone: '03000000000' }, cookie);
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another user is counted separately.
    const fresh = await send('post', `${BASE}/lookup`, { phone: '03000000000' });
    expect(fresh.status).toBe(200);
  });

  it('issue-login creates the parent login once; then the CNIC is locked', async () => {
    const digits = randomIdentityDigits();
    const created = await createGuardian({ cnic: digits });
    // Contract slice-6 §9: a live link with can_login is required first.
    const noLink = await send('post', `${BASE}/${created.id}/issue-login`, undefined);
    expect(errorOf(noLink).code).toBe('GUARDIAN_NO_LOGIN_LINK');
    const student = await createStudent(db, school);
    await linkGuardian(db, school, student, { id: BigInt(created.id) }, { canLogin: true });
    const res = await send('post', `${BASE}/${created.id}/issue-login`, undefined);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(ID),
      staffId: null,
      guardianId: created.id,
      studentId: null,
      fullName: 'Ahmed Khan',
      systemRoles: [],
      status: 'active',
      passwordIsDefault: true,
    });
    const again = await send('post', `${BASE}/${created.id}/issue-login`, undefined);
    expect(errorOf(again).code).toBe('LOGIN_ALREADY_EXISTS');

    const detail = await get(`${BASE}/${created.id}`);
    expect((detail.body as Guardian).userId).toBe((res.body as { id: string }).id);
    const locked = await send('patch', `${BASE}/${created.id}`, { cnic: randomIdentityDigits() });
    expect(errorOf(locked).code).toBe('GUARDIAN_CNIC_LOCKED');

    const noCnic = await createGuardian({ cnic: null });
    const missing = await send('post', `${BASE}/${noCnic.id}/issue-login`, undefined);
    expect(errorOf(missing).code).toBe('GUARDIAN_CNIC_MISSING');
  });

  it('issue-login needs user.account.manage; writes need the Origin header', async () => {
    const created = await createGuardian();
    const teacher = await sessionFor(school, 'teacher');
    expect(
      (await send('post', `${BASE}/${created.id}/issue-login`, undefined, teacher)).status,
    ).toBe(403);
    const noOrigin = record(
      await http()
        .post(BASE)
        .set('Cookie', office)
        .send({ fullName: 'No Origin', contactCapability: 'keypad' }),
    );
    expect(errorOf(noOrigin).code).toBe('ORIGIN_REJECTED');
  });

  it('a suspended school cannot write guardians (read-only)', async () => {
    const suspended = await createSchool({ status: 'suspended' });
    const cookie = await sessionFor(suspended, 'principal');
    expect((await get(BASE, cookie)).status).toBe(200);
    const res = await send(
      'post',
      BASE,
      { fullName: 'Blocked', contactCapability: 'keypad' },
      cookie,
    );
    expect(errorOf(res).code).toBe('SCHOOL_SUSPENDED');
  });

  it('R16: no identity number in any response body or log line of this suite', () => {
    const identity = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) expect(body).not.toMatch(identity);
    // The log stream is already scrubbed; a scrub marker means one reached a log line. The only
    // expected ones are the two list requests above that put a CNIC in `q` to prove the 422.
    const scrubbed = logs.filter((line) => line.includes('[id]'));
    expect(scrubbed).toHaveLength(2);
    for (const line of scrubbed) expect(line).toContain('"url":"/api/v1/guardians?q=[id]"');
  });
});
