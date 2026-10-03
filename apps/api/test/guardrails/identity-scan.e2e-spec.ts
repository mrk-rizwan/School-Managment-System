// R16 (plan §5 slice 8): no identity number (13 digits, or #####-#######-#) in any log line, URL,
// audit row, idempotency row or response after the flows that handle CNIC and B-Form numbers.
//
// One app, one run through every such flow: the platform issuing a principal login, school login
// (failed and successful, dashed and plain), staff create and issue-login, office reset,
// forgot-password, guardian create and lookup, admission with a replay, student lookup, student
// and guardian issue-login and their logins, and a search URL carrying a dashed number. Then:
//   - every captured log line and every response body is checked for the exact digits used,
//     plain and dashed, and for both generic patterns;
//   - audit_log, platform_audit_log and idempotency_keys are scanned WHOLE (every school any
//     suite ever wrote, since tests never truncate), as text, for both patterns. The 64-hex
//     request_hash is excluded from the pattern scan only (hex holds a 13-digit run by chance
//     about one time in 23) and is still searched for the exact digits.
import { randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { randomIdentityDigits } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection, randomPhone, type TestSection } from '../support/students';
import { FakeMailer, nextIp, ORIGIN, sessionCookieOf } from '../school-auth/support';

const PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;

describe('R16: identity numbers never reach logs, responses, audit or idempotency rows', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let section: TestSection;
  const logs: string[] = [];
  const bodies: string[] = [];
  const used: string[] = [];
  const db = testDb();
  const http = () => request(app.getHttpServer());

  const digits = () => {
    const d = randomIdentityDigits();
    used.push(d);
    return d;
  };
  const keep = (res: request.Response) => {
    bodies.push(res.text);
    return res;
  };
  const post = async (path: string, body: object, cookie?: string, headers: Record<string, string> = {}) => {
    const req = http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp());
    if (cookie) req.set('Cookie', cookie);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return keep(await req.send(body));
  };
  const get = async (path: string, cookie: string) =>
    keep(await http().get(`/api/v1${path}`).set('Cookie', cookie));
  const login = (username: string, password: string) =>
    post('/auth/login', { schoolCode: school.shortCode, username, password });

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: Mailer, useValue: new FakeMailer() }],
      logStream: { write: (line: string) => void logs.push(line) },
    });
    school = await createSchool({ status: 'trial' });
    await db.schoolCounter.create({ data: { schoolId: school.id, name: 'admission_no', value: 0n } });
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true } });
    ({ section } = await createClassWithSection(db, school));
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R16: runs every identity-number flow (each step succeeds, so the scan below is not vacuous)', async () => {
    // Platform issues the principal login (platform_audit_log and audit_log).
    const admin = await signedInPlatformAdmin();
    const principalCnic = digits();
    const issued = keep(
      await http()
        .post(`/api/v1/platform/schools/${school.id}/issue-principal-login`)
        .set('Cookie', admin.cookie)
        .set('Origin', ORIGIN)
        .send({ fullName: 'Nadia Principal', cnic: dashed(principalCnic), phone: '0300 1234567' }),
    );
    expect(issued.status).toBe(201);

    // School login: a failure, then success with the dashed username and the default password.
    expect((await login(principalCnic, 'not-the-password')).status).toBe(401);
    const signedIn = await login(dashed(principalCnic), principalCnic);
    expect(signedIn.status).toBe(200);
    const principal = sessionCookieOf(signedIn);

    // Staff: create with a dashed CNIC, a duplicate refusal, issue-login, login, office reset.
    const staffCnic = digits();
    const staff = await post('/staff', { fullName: 'Rabia Khan', phone: '03001234567', cnic: dashed(staffCnic) }, principal);
    expect(staff.status).toBe(201);
    const duplicate = await post('/staff', { fullName: 'Rabia Again', phone: '03001234568', cnic: staffCnic }, principal);
    expect(duplicate.status).toBe(409);
    const staffId = (staff.body as { id: string }).id;
    const staffLogin = await post(`/staff/${staffId}/issue-login`, { systemRole: 'office_staff' }, principal);
    expect(staffLogin.status).toBe(201);
    const staffUserId = (staffLogin.body as { id: string }).id;
    expect((await login(staffCnic, staffCnic)).status).toBe(200);
    const reset = await post(`/users/${staffUserId}/reset-password`, { reason: 'Forgot it', clearEmail: false }, principal);
    expect(reset.status).toBe(200);
    expect((await post('/auth/forgot-password', { schoolCode: school.shortCode, username: dashed(staffCnic) })).status).toBe(202);

    // Guardians: create, a duplicate refusal, lookup by CNIC.
    const guardianCnic = digits();
    const guardian = await post('/guardians', { fullName: 'Ahmed Khan', cnic: dashed(guardianCnic), phone: randomPhone(), contactCapability: 'whatsapp' }, principal);
    expect(guardian.status).toBe(201);
    expect((await post('/guardians', { fullName: 'Ahmed Again', cnic: guardianCnic, contactCapability: 'keypad' }, principal)).status).toBe(409);
    const lookup = await post('/guardians/lookup', { cnic: dashed(guardianCnic) }, principal);
    expect(lookup.status).toBe(200);

    // Admission with a new guardian and a B-Form, replayed with the same key; student lookup.
    const bForm = digits();
    const parentCnic = digits();
    const admission = {
      student: { fullName: `Ali ${randomBytes(3).toString('hex')}`, gender: 'male', dateOfBirth: '2018-03-01', bForm: dashed(bForm) },
      guardians: [
        {
          newGuardian: { fullName: 'Imran Raza', cnic: dashed(parentCnic), phone: randomPhone(), contactCapability: 'whatsapp' },
          relationship: 'father',
          isPrimaryContact: true,
          isFeePayer: true,
          canLogin: true,
        },
      ],
      enrolment: { classId: section.classId.toString(), sectionId: section.id.toString() },
    };
    const key = `adm_${randomBytes(12).toString('base64url')}`;
    const admitted = await post('/admissions', admission, principal, { 'Idempotency-Key': key });
    expect(admitted.status).toBe(201);
    const replay = await post('/admissions', admission, principal, { 'Idempotency-Key': key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const result = admitted.body as { student: { id: string }; guardianLinks: { guardianId: string }[] };
    expect((await post('/students/lookup', { bForm }, principal)).status).toBe(200);

    // Student and guardian logins issued, then used.
    expect((await post(`/students/${result.student.id}/issue-login`, {}, principal)).status).toBe(201);
    expect((await login(bForm, bForm)).status).toBe(200);
    const parentId = result.guardianLinks[0]?.guardianId ?? '';
    expect((await post(`/guardians/${parentId}/issue-login`, {}, principal)).status).toBe(201);
    expect((await login(dashed(parentCnic), parentCnic)).status).toBe(200);

    // A search URL carrying a dashed number: refused, and its request line scrubbed in the log.
    expect((await get(`/users?q=${dashed(staffCnic)}`, principal)).status).toBe(422);
    expect((await get(`/guardians?q=${guardianCnic}`, principal)).status).toBe(422);

    // Lists the office reads every day.
    for (const path of ['/users', '/staff', '/guardians', '/students']) {
      expect((await get(path, principal)).status).toBe(200);
    }
    expect(used).toHaveLength(5);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('R16: no captured log line holds an identity number', () => {
    const all = logs.join('\n');
    for (const d of used) {
      expect(all).not.toContain(d);
      expect(all).not.toContain(dashed(d));
    }
    const hits = logs.filter((l) => PATTERN.test(l));
    expect(hits).toEqual([]);
    // Not vacuous: request URLs are logged, and the two search URLs reached the log masked.
    expect(logs.filter((l) => l.includes('/api/v1/users?q=[id]') || l.includes('/api/v1/guardians?q=[id]'))).not.toEqual([]);
  });

  it('R16: no response body holds an identity number', () => {
    const all = bodies.join('\n');
    for (const d of used) {
      expect(all).not.toContain(d);
      expect(all).not.toContain(dashed(d));
    }
    expect(bodies.filter((b) => PATTERN.test(b))).toEqual([]);
  });

  describe('the stored trails, whole tables', () => {
    let pg: Client;

    beforeAll(async () => {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
    });

    afterAll(async () => {
      await pg.end();
    });

    /** Each row of `table` as JSON text, optionally without some columns. */
    async function rowsAsText(table: string, without: string[] = []): Promise<string[]> {
      const drop = without.map((c) => ` - '${c}'`).join('');
      const res = await pg.query<{ row: string }>(`SELECT (to_jsonb(t)${drop})::text AS row FROM ${table} t`);
      return res.rows.map((r) => r.row);
    }

    it.each(['audit_log', 'platform_audit_log', 'idempotency_keys'])(
      'R16: %s holds none of the identity numbers this run sent',
      async (table) => {
        const rows = (await rowsAsText(table)).join('\n');
        expect(rows.length).toBeGreaterThan(0);
        for (const d of used) {
          expect(rows).not.toContain(d);
          expect(rows).not.toContain(dashed(d));
        }
      },
    );

    it.each([
      ['audit_log', []],
      ['platform_audit_log', []],
      ['idempotency_keys', ['request_hash']],
    ])('R16: no row of %s matches an identity-number pattern', async (table, without) => {
      const hits = (await rowsAsText(table, without)).filter((row) => PATTERN.test(row));
      expect(hits).toEqual([]);
    });

    it('R16: this run wrote the rows the scan relies on', async () => {
      const audit = await pg.query<{ action: string }>(
        'SELECT action FROM audit_log WHERE school_id = $1 ORDER BY id',
        [school.id.toString()],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'staff.created',
          'user.principal_login_issued',
          'user.login_issued',
          'user.office_reset',
          'guardian.created',
          'student.admitted',
        ]),
      );
      const platform = await pg.query('SELECT 1 FROM platform_audit_log WHERE school_id = $1', [school.id.toString()]);
      expect(platform.rowCount).toBeGreaterThan(0);
      const keys = await pg.query('SELECT 1 FROM idempotency_keys WHERE school_id = $1', [school.id.toString()]);
      expect(keys.rowCount).toBe(1);
    });
  });
});
