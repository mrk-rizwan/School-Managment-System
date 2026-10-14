// Biometric staff attendance end to end (Phase 5 slice 44, contracts/slice-44.md; R344, R345,
// R348): the device token's rotation (shown once, hashed, rule-24 inert), the punch route with no
// session (one identical 401 for every bad token, the per-school and per-IP throttles), every
// per-punch outcome, the device marks, the device mapping, the punches day view and the day
// sheet's punch columns. Each device request comes from its own X-Forwarded-For address (the API
// trusts one hop), so the per-IP bucket of one test never touches another.
import { createHash, randomBytes } from 'node:crypto';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import request from 'supertest';
import { Capability, ErrorCode, weekdayOf } from '@asms/shared';
import { DeviceTokenLockout } from '../../src/modules/staff-attendance/device-punch.service';
import { errorOf, schoolDay, StaffHarness, type Caller } from '../staff/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';

const api = (path: string) => `/api/v1${path}`;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A local school time on a school day (every test school runs on Asia/Karachi, +05:00). */
const at = (date: string, time: string) => `${date}T${time}:00+05:00`;

// Three past working days and one weekly-off day, all within the 7-day window; the off day is made
// one by the school's settings, so the suite does not depend on today's weekday.
const D1 = schoolDay(-1);
const D2 = schoolDay(-2);
const OFF = schoolDay(-3);
const D4 = schoolDay(-4);

interface PunchResult {
  deviceUserId: string;
  punchedAt: string;
  outcome: string;
  staffAttendanceId: string | null;
}

let ipSeq = 0;
/** A fresh documentation-range address per call (RFC 5737), unique to this run. */
const nextIp = () => `198.51.${100 + (process.pid % 50)}.${(ipSeq++ % 250) + 1}`;

describe('biometric staff attendance (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  interface Fixture {
    school: TestSchool;
    principal: Caller;
    office: Caller;
    teacher: Caller;
    token: string;
  }

  /** A school with the off day, late after 08:30, an office granted attendance.staff.manage, and a token. */
  async function fresh(lateAfter: string | null = '08:30'): Promise<Fixture> {
    const school = await createSchool();
    await db.schoolSettings.create({
      data: {
        schoolId: school.id,
        feeDueDay: 10,
        weeklyOffDays: [weekdayOf(OFF)],
        staffLateAfter: lateAfter === null ? null : new Date(`1970-01-01T${lateAfter}:00.000Z`),
      },
    });
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const office = await h.caller(school, 'office_staff', 'Omar Office');
    await db.userCapabilityGrant.create({
      data: {
        schoolId: school.id,
        userId: office.userId,
        capabilityKey: Capability.ATTENDANCE_STAFF_MANAGE,
        effect: 'grant',
        grantedBy: principal.userId,
        reason: 'Records staff attendance',
      },
    });
    const teacher = await h.caller(school, 'teacher', 'Tariq Teacher');
    const rotated = await rotate(principal);
    expect(rotated.status).toBe(200);
    return { school, principal, office, teacher, token: (rotated.body as { token: string }).token };
  }

  const rotate = (caller: Caller) => h.send('post', api('/school/device-token/rotate'), {}, caller.cookie);
  const map = (school: TestSchool, staffId: bigint, deviceUserId: string | null) =>
    db.staff.update({ where: { schoolId_id: { schoolId: school.id, id: staffId } }, data: { deviceUserId } });

  const post = (token: string | null, body: object, ip = nextIp(), extra: Record<string, string> = {}) => {
    let req = request(h.app.getHttpServer()).post(api('/device-punches')).set('X-Forwarded-For', ip);
    if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(extra)) req = req.set(name, value);
    return req.send(body);
  };
  const punches = async (token: string, list: object[]): Promise<PunchResult[]> => {
    const res = await post(token, { punches: list });
    expect(res.status).toBe(200);
    h.bodies.push(res.text);
    return (res.body as { results: PunchResult[] }).results;
  };
  const marksOf = (school: TestSchool, staffId: bigint) =>
    db.staffAttendance.findMany({ where: { schoolId: school.id, staffId }, orderBy: { date: 'asc' } });
  const auditOf = (school: TestSchool, action: string) =>
    db.auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  // ------------------------------------------------------------------------------- R344

  describe('R344: the device token', () => {
    it('is shown once, stored only as its sha-256, audited without the token, and visible only as a rotation time', async () => {
      const f = await fresh();
      expect(f.token).toMatch(TOKEN);
      const row = await db.school.findFirstOrThrow({ where: { id: f.school.id } });
      expect(row.deviceTokenHash).toBe(createHash('sha256').update(f.token).digest('hex'));
      expect(row.deviceTokenRotatedAt).not.toBeNull();
      const settings = await h.get(api('/school/settings'), f.principal.cookie);
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({ deviceTokenRotatedAt: row.deviceTokenRotatedAt?.toISOString(), staffLateAfter: '08:30' });
      expect(settings.text).not.toContain(f.token);
      expect(settings.text).not.toContain(row.deviceTokenHash);
      const audit = await auditOf(f.school, 'device_token.rotated');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: f.principal.userId, subjectType: 'school', subjectId: f.school.id });
      expect(audit[0]?.metadata).toEqual({ first: true });
      expect(JSON.stringify(audit, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(f.token);
      expect(h.logs.join('\n')).not.toContain(f.token);
    });

    it('rotation invalidates the old token at once; the new one works', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      const second = await rotate(f.principal);
      expect(second.status).toBe(200);
      const next = (second.body as { token: string }).token;
      expect(next).not.toBe(f.token);
      const old = await post(f.token, { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] });
      expect(old.status).toBe(401);
      expect(errorOf(old).code).toBe(ErrorCode.DEVICE_TOKEN_INVALID);
      expect((await punches(next, [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }]))[0]?.outcome).toBe('marked');
      expect((await auditOf(f.school, 'device_token.rotated')).map((a) => a.metadata)).toEqual([{ first: true }, { first: false }]);
    });

    it('the rotate verb is rule-24 inert; a caller without school.settings.manage is PERMISSION_DENIED', async () => {
      const school = await createSchool();
      await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
      const user = await createSchoolUser(db, school, { systemRole: 'principal', defaultPassword: true });
      const { cookie } = await createSchoolSession(db, school, user);
      const res = await h.send('post', api('/school/device-token/rotate'), {}, cookie);
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe(ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION);
      expect((await db.school.findFirstOrThrow({ where: { id: school.id } })).deviceTokenHash).toBeNull();
      const f = await fresh();
      const office = await rotate(f.office);
      expect(office.status).toBe(403);
      expect(errorOf(office).code).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('turning the device off: the token answers the same 401 at once, audited once; a second turn-off writes nothing', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      const revoke = (caller: Caller) => h.send('post', api('/school/device-token/revoke'), {}, caller.cookie);
      const off = await revoke(f.principal);
      expect([off.status, off.body]).toEqual([200, { revoked: true }]);
      const row = await db.school.findFirstOrThrow({ where: { id: f.school.id } });
      expect([row.deviceTokenHash, row.deviceTokenRotatedAt]).toEqual([null, null]);
      const refused = await post(f.token, { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] });
      expect(refused.status).toBe(401);
      expect(errorOf(refused)).toEqual({
        code: ErrorCode.DEVICE_TOKEN_INVALID,
        message: 'The device token is not valid.',
        details: null,
        requestId: expect.any(String),
      });
      expect(await marksOf(f.school, f.teacher.staffId)).toEqual([]);
      expect((await h.get(api('/school/settings'), f.principal.cookie)).body).toMatchObject({ deviceTokenRotatedAt: null });
      const again = await revoke(f.principal);
      expect([again.status, again.body]).toEqual([200, { revoked: false }]);
      const audit = await auditOf(f.school, 'device_token.revoked');
      expect(audit.map((a) => [a.actorUserId, a.subjectType, a.subjectId])).toEqual([[f.principal.userId, 'school', f.school.id]]);
      // Not the office's verb; inert on a default password like the rotation.
      const office = await revoke(f.office);
      expect([office.status, errorOf(office).code]).toEqual([403, ErrorCode.PERMISSION_DENIED]);
      const user = await createSchoolUser(db, f.school, { systemRole: 'principal', defaultPassword: true });
      const { cookie } = await createSchoolSession(db, f.school, user);
      const inert = await h.send('post', api('/school/device-token/revoke'), {}, cookie);
      expect([inert.status, errorOf(inert).code]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    });
  });

  // ------------------------------------------------------------------------------- R348

  describe('R348: the punch route has no session and takes no tenant from input', () => {
    it('every bad token is the same 401: missing, malformed, unknown, rotated out, with a cookie, with an Origin, a terminated school', async () => {
      const f = await fresh();
      const body = { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] };
      const terminated = await createSchool({ status: 'terminated' });
      const terminatedToken = randomBytes(32).toString('base64url');
      await db.school.update({
        where: { id: terminated.id },
        data: { deviceTokenHash: createHash('sha256').update(terminatedToken).digest('hex'), deviceTokenRotatedAt: new Date() },
      });
      const rotated = await rotate(f.principal);
      // No Authorization header at all is refused earlier, by the Origin check every school non-GET
      // without Authorization or X-App-Version meets (R65): still nothing about any token.
      const bare = await post(null, body);
      expect(bare.status).toBe(403);
      expect(errorOf(bare).code).toBe(ErrorCode.ORIGIN_REJECTED);
      const answers = [
        await post(null, body, nextIp(), { Authorization: 'Basic dXNlcjpwYXNz' }), // pragma: allowlist secret
        await post('not-a-token', body),
        await post(randomBytes(32).toString('base64url'), body),
        await post(f.token, body), // rotated out above
        await post((rotated.body as { token: string }).token, body, nextIp(), { Cookie: f.principal.cookie }),
        await post((rotated.body as { token: string }).token, body, nextIp(), { Origin: 'http://localhost:3460' }),
        await post(terminatedToken, body),
      ];
      for (const res of answers) {
        expect(res.status).toBe(401);
        // Identical but for the request id: nothing tells an unknown token from a rotated one.
        expect(errorOf(res)).toEqual({
          code: ErrorCode.DEVICE_TOKEN_INVALID,
          message: 'The device token is not valid.',
          details: null,
          requestId: expect.any(String),
        });
      }
      // Nothing was stored for any of them.
      expect(await db.devicePunch.count({ where: { schoolId: f.school.id } })).toBe(0);
    });

    it('a school id in the body or the query is refused; the token alone names the school', async () => {
      const a = await fresh();
      const b = await fresh();
      // B's teacher holds T-9 in B; A's device sending T-9 reaches nobody in B.
      await map(b.school, b.teacher.staffId, 'T-9');
      const withSchool = await post(a.token, { schoolId: b.school.id.toString(), punches: [{ deviceUserId: 'T-9', punchedAt: at(D1, '08:00') }] });
      expect(withSchool.status).toBe(422);
      const inQuery = await request(h.app.getHttpServer())
        .post(api(`/device-punches?schoolId=${b.school.id}`))
        .set('Authorization', `Bearer ${a.token}`)
        .set('X-Forwarded-For', nextIp())
        .send({ punches: [{ deviceUserId: 'T-9', punchedAt: at(D1, '08:00') }] });
      expect(inQuery.status).toBe(422);
      const results = await punches(a.token, [{ deviceUserId: 'T-9', punchedAt: at(D1, '08:00') }]);
      expect(results[0]?.outcome).toBe('unmapped');
      expect(await db.devicePunch.count({ where: { schoolId: b.school.id } })).toBe(0);
      expect(await db.devicePunch.count({ where: { schoolId: a.school.id, staffId: null } })).toBe(1);
    });

    it('per school: 600 requests an hour after the token resolves, then 429 with Retry-After', async () => {
      const f = await fresh();
      const storage = h.app.get(ThrottlerStorageRedisService);
      for (let i = 0; i < 600; i++) {
        await storage.increment(`asms:device-punches-hour:${f.school.id}`, 3_600_000, 600, 3_600_000, 'device-punches-hour');
      }
      const res = await post(f.token, { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] });
      expect(res.status).toBe(429);
      expect(errorOf(res).code).toBe(ErrorCode.RATE_LIMITED);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // Another school's device is unaffected.
      const other = await fresh();
      expect((await post(other.token, { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] })).status).toBe(200);
    });

    it('per IP: 10 refused tokens within a minute lock the address out, even with a good token; another address works', async () => {
      const f = await fresh();
      const ip = nextIp();
      const body = { punches: [{ deviceUserId: 'T-1', punchedAt: at(D1, '08:00') }] };
      try {
        for (let i = 0; i < 10; i++) expect((await post(randomBytes(32).toString('base64url'), body, ip)).status).toBe(401);
        const locked = await post(f.token, body, ip);
        expect(locked.status).toBe(429);
        expect(errorOf(locked).code).toBe(ErrorCode.RATE_LIMITED);
        expect(Number(locked.headers['retry-after'])).toBe(900);
        expect((await post(f.token, body, nextIp())).status).toBe(200);
      } finally {
        await h.app.get(DeviceTokenLockout).clear(ip);
      }
    });
  });

  // ------------------------------------------------------------------------------- R345

  describe('R345: what a punch does', () => {
    it('the first punch of a working day marks present, or late after staff_late_after; later punches are stored; a replay is a duplicate', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      // Request order is not time order: the 08:10 punch is the day's first and marks.
      const results = await punches(f.token, [
        { deviceUserId: 'T-1', punchedAt: at(D1, '13:05'), direction: 'out' },
        { deviceUserId: 'T-1', punchedAt: at(D1, '08:10'), direction: 'in' },
        { deviceUserId: 'T-1', punchedAt: at(D2, '08:45') },
        { deviceUserId: 'T-1', punchedAt: at(D1, '08:10') },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(['stored', 'marked', 'marked', 'duplicate']);
      expect(results[0]).toEqual({ deviceUserId: 'T-1', punchedAt: at(D1, '13:05'), outcome: 'stored', staffAttendanceId: null });
      const marks = await marksOf(f.school, f.teacher.staffId);
      expect(marks.map((m) => [m.date.toISOString().slice(0, 10), m.status, m.source, m.markedBy])).toEqual([
        [D2, 'late', 'device', null],
        [D1, 'present', 'device', null],
      ]);
      expect(results[1]?.staffAttendanceId).toBe(marks[1]?.id.toString());
      const stored = await db.devicePunch.findMany({ where: { schoolId: f.school.id }, orderBy: { punchedAt: 'asc' } });
      // D2 is the earlier day: its 08:45, then D1's 08:10 and 13:05.
      expect(stored.map((p) => p.outcome)).toEqual(['marked', 'marked', 'stored']);
      expect(stored.every((p) => p.staffId === f.teacher.staffId)).toBe(true);
      expect(marks.map((m) => m.devicePunchId)).toEqual([stored[0]?.id, stored[1]?.id]);
      // A replay of the whole batch later: every punch is a duplicate, nothing changes.
      const replay = await punches(f.token, [
        { deviceUserId: 'T-1', punchedAt: at(D1, '13:05') },
        { deviceUserId: 'T-1', punchedAt: at(D1, '08:10') },
      ]);
      expect(replay.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
      expect(await db.devicePunch.count({ where: { schoolId: f.school.id } })).toBe(3);
      // The batch answer carries no name and no staff id.
      expect(h.bodies.join('\n')).not.toContain('Tariq');
      expect(h.bodies.join('\n')).not.toContain(`"staffId"`);
    });

    it('a school without staff_late_after never marks late', async () => {
      const f = await fresh(null);
      await map(f.school, f.teacher.staffId, 'T-1');
      expect((await punches(f.token, [{ deviceUserId: 'T-1', punchedAt: at(D1, '11:59') }]))[0]?.outcome).toBe('marked');
      expect((await marksOf(f.school, f.teacher.staffId))[0]?.status).toBe('present');
    });

    it('a weekly-off day, a day already marked, an unmapped id and an inactive holder are stored and never marked', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      const suspended = await h.caller(f.school, 'teacher', 'Sana Suspended');
      await map(f.school, suspended.staffId, 'S-1');
      await db.staff.update({ where: { schoolId_id: { schoolId: f.school.id, id: suspended.staffId } }, data: { status: 'suspended' } });
      // The office marked D4 absent before the punch arrived.
      await db.staffAttendance.create({
        data: { schoolId: f.school.id, staffId: f.teacher.staffId, date: day(D4), status: 'absent', markedBy: f.office.userId },
      });
      const results = await punches(f.token, [
        { deviceUserId: 'T-1', punchedAt: at(OFF, '08:00') },
        { deviceUserId: 'T-1', punchedAt: at(D4, '08:00') },
        { deviceUserId: 'NOBODY', punchedAt: at(D1, '08:00') },
        { deviceUserId: 'S-1', punchedAt: at(D1, '08:00') },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(['stored', 'stored', 'unmapped', 'inactive']);
      const marks = await marksOf(f.school, f.teacher.staffId);
      expect(marks.map((m) => [m.date.toISOString().slice(0, 10), m.status, m.source])).toEqual([[D4, 'absent', 'manual']]);
      expect(await db.staffAttendance.count({ where: { schoolId: f.school.id, staffId: suspended.staffId } })).toBe(0);
      const rows = await db.devicePunch.findMany({ where: { schoolId: f.school.id }, orderBy: { id: 'asc' } });
      expect(rows.map((r) => [r.deviceUserId, r.outcome, r.staffId])).toEqual(
        expect.arrayContaining([
          ['NOBODY', 'unmapped', null],
          ['S-1', 'inactive', suspended.staffId],
        ]),
      );
      // A11: mapping the id later does not repair the stored punch.
      const late = await h.caller(f.school, 'teacher', 'Late Mapping');
      await map(f.school, late.staffId, 'NOBODY');
      expect((await db.devicePunch.findFirstOrThrow({ where: { schoolId: f.school.id, deviceUserId: 'NOBODY' } })).staffId).toBeNull();
    });

    it('outside −7 days … +5 minutes, or an identity-shaped id, is rejected: never stored, counted once in the audit log', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const future = new Date(Date.now() + 10 * 60_000).toISOString();
      const results = await punches(f.token, [
        { deviceUserId: 'T-1', punchedAt: old },
        { deviceUserId: 'T-1', punchedAt: future },
        { deviceUserId: '4210112345671', punchedAt: at(D1, '08:00') },
        { deviceUserId: 'T-1', punchedAt: at(D1, '08:00') },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(['rejected', 'rejected', 'rejected', 'marked']);
      expect(await db.devicePunch.count({ where: { schoolId: f.school.id } })).toBe(1);
      const audit = await auditOf(f.school, 'device_punch.rejected');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: null, subjectType: 'school', subjectId: f.school.id });
      expect(audit[0]?.metadata).toEqual({ job: 'device', count: 3, received: 4 });
    });

    it('§7.2: a batch of 200 punches for 200 staff is answered within budget (500 ms; 1.5 s allowed on a shared test database)', async () => {
      const f = await fresh();
      await db.staff.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          schoolId: f.school.id,
          fullName: `Device Staff ${i}`,
          phone: '+923001234567',
          deviceUserId: `P-${i}`,
        })),
      });
      const batch = Array.from({ length: 200 }, (_, i) => ({ deviceUserId: `P-${i}`, punchedAt: at(D1, '07:55') }));
      const started = performance.now();
      const results = await punches(f.token, batch);
      const elapsed = performance.now() - started;
      expect(results.every((r) => r.outcome === 'marked')).toBe(true);
      expect(await db.staffAttendance.count({ where: { schoolId: f.school.id, source: 'device' } })).toBe(200);
      expect(elapsed).toBeLessThan(1_500);
    });

    it('a malformed batch is 422: over 500 punches, an id with a space, a time without an offset', async () => {
      const f = await fresh();
      const many = Array.from({ length: 501 }, (_, i) => ({ deviceUserId: `U${i}`, punchedAt: at(D1, '08:00') }));
      expect((await post(f.token, { punches: many })).status).toBe(422);
      expect((await post(f.token, { punches: [{ deviceUserId: 'has space', punchedAt: at(D1, '08:00') }] })).status).toBe(422);
      expect((await post(f.token, { punches: [{ deviceUserId: 'T-1', punchedAt: `${D1}T08:00:00` }] })).status).toBe(422);
      expect(await db.devicePunch.count({ where: { schoolId: f.school.id } })).toBe(0);
    });

    it('a punch never amends a mark: the office marking the day first wins, and the punch is shown beside it as a conflict', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      const submitted = await h.send('post', api('/staff-attendance/submit'), {
        date: D2,
        marks: [{ staffId: f.teacher.staffId.toString(), status: 'absent' }],
      }, f.office.cookie);
      expect(submitted.status).toBe(200);
      expect((await punches(f.token, [{ deviceUserId: 'T-1', punchedAt: at(D2, '08:05') }]))[0]?.outcome).toBe('stored');
      const sheet = await h.get(api(`/staff-attendance?date=${D2}`), f.office.cookie);
      expect(sheet.status).toBe(200);
      const row = (sheet.body as { data: { staffId: string; mark: { status: string; source: string } | null; punch: unknown; punchConflict: boolean }[] }).data.find(
        (r) => r.staffId === f.teacher.staffId.toString(),
      );
      expect(row).toMatchObject({
        mark: { status: 'absent', source: 'manual' },
        punch: { firstPunchAt: new Date(at(D2, '08:05')).toISOString(), count: 1 },
        punchConflict: true,
      });
    });
  });

  // ------------------------------------------------------------------------------- A11 and the day view

  describe('the device mapping and the punches day view', () => {
    it('PATCH /staff/:id/device-user sets, refuses one held by another, refuses one\'s own record, clears, and audits', async () => {
      const f = await fresh();
      const set = await h.send('patch', api(`/staff/${f.teacher.staffId}/device-user`), { deviceUserId: 'T-7' }, f.office.cookie);
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ staffId: f.teacher.staffId.toString(), deviceUserId: 'T-7' });
      const staff = await h.get(api(`/staff/${f.teacher.staffId}`), f.principal.cookie);
      expect((staff.body as { deviceUserId: string }).deviceUserId).toBe('T-7');
      const taken = await h.send('patch', api(`/staff/${f.principal.staffId}/device-user`), { deviceUserId: 'T-7' }, f.office.cookie);
      expect(taken.status).toBe(422);
      const own = await h.send('patch', api(`/staff/${f.office.staffId}/device-user`), { deviceUserId: 'O-1' }, f.office.cookie);
      expect(own.status).toBe(409);
      expect(errorOf(own)).toMatchObject({ code: ErrorCode.SELF_ACTION_FORBIDDEN, details: { reason: 'own_attendance' } });
      const identity = await h.send('patch', api(`/staff/${f.teacher.staffId}/device-user`), { deviceUserId: '4210112345671' }, f.office.cookie);
      expect(identity.status).toBe(422);
      const cleared = await h.send('patch', api(`/staff/${f.teacher.staffId}/device-user`), { deviceUserId: null }, f.office.cookie);
      expect(cleared.body).toEqual({ staffId: f.teacher.staffId.toString(), deviceUserId: null });
      // Unchanged: no audit row.
      await h.send('patch', api(`/staff/${f.teacher.staffId}/device-user`), { deviceUserId: null }, f.office.cookie);
      expect((await auditOf(f.school, 'staff.device_user_set')).map((a) => a.metadata)).toEqual([
        { from: null, to: 'T-7' },
        { from: 'T-7', to: null },
      ]);
      // A teacher holds no attendance.staff.manage.
      expect((await h.send('patch', api(`/staff/${f.principal.staffId}/device-user`), { deviceUserId: 'X' }, f.teacher.cookie)).status).toBe(403);
    });

    it('GET /device-punches lists one school day in school time, filters unmapped and staff, and stays inside the school', async () => {
      const f = await fresh();
      await map(f.school, f.teacher.staffId, 'T-1');
      await punches(f.token, [
        { deviceUserId: 'T-1', punchedAt: at(D1, '08:00') },
        // 23:30 local on D1 is still D1 in school time (18:30 UTC).
        { deviceUserId: 'T-1', punchedAt: at(D1, '23:30') },
        { deviceUserId: 'X-1', punchedAt: at(D1, '09:00') },
        { deviceUserId: 'T-1', punchedAt: at(D2, '08:00') },
      ]);
      const list = await h.get(api(`/device-punches?date=${D1}`), f.office.cookie);
      expect(list.status).toBe(200);
      const page = list.body as { total: number; data: { deviceUserId: string; outcome: string; staffName: string | null; staffAttendanceId: string | null }[] };
      expect(page.total).toBe(3);
      expect(page.data.map((p) => [p.deviceUserId, p.outcome, p.staffName])).toEqual([
        ['T-1', 'marked', 'Tariq Teacher'],
        ['X-1', 'unmapped', null],
        ['T-1', 'stored', 'Tariq Teacher'],
      ]);
      expect(page.data[0]?.staffAttendanceId).not.toBeNull();
      const unmapped = await h.get(api(`/device-punches?date=${D1}&unmapped=true`), f.office.cookie);
      expect((unmapped.body as { total: number }).total).toBe(1);
      const byStaff = await h.get(api(`/device-punches?date=${D1}&staffId=${f.teacher.staffId}`), f.office.cookie);
      expect((byStaff.body as { total: number }).total).toBe(2);
      expect((await h.get(api(`/device-punches?date=${schoolDay(1)}`), f.office.cookie)).status).toBe(422);
      expect((await h.get(api(`/device-punches?date=${D1}`), f.teacher.cookie)).status).toBe(403);
      // Another school's manager sees none of it, and cannot map A's staff.
      const other = await fresh();
      expect((await h.get(api(`/device-punches?date=${D1}`), other.principal.cookie)).body).toMatchObject({ total: 0 });
      expect((await h.send('patch', api(`/staff/${f.teacher.staffId}/device-user`), { deviceUserId: 'Z' }, other.principal.cookie)).status).toBe(404);
    });
  });
});
