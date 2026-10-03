// School session resolution and the access guard (contract slice-2 §1): R9 (via disabled), R56,
// R59, R64, R69, R70-style revocation, R71, R78, R80.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { createSchoolSession, createSchoolUser, TEST_APP_VERSION } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { AccessProbeModule, createGuardianUser, ORIGIN } from './support';

describe('school session resolution and the access guard', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ imports: [AccessProbeModule] });
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const codeOf = (res: { body: unknown }) => (res.body as { error: { code: string } }).error.code;

  it('a cookie session establishes the tenant, user and session in the request context', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const session = await createSchoolSession(db(), school, user);
    const res = await http().get('/api/v1/test-access/staff').set('Cookie', session.cookie).expect(200);
    expect(res.body).toEqual({
      schoolId: school.id.toString(),
      userId: user.userId.toString(),
      sessionId: session.sessionId.toString(),
      sessionSchoolId: school.id.toString(),
    });
  });

  it('a bearer session is accepted on the bearer channel', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const session = await createSchoolSession(db(), school, user, { channel: 'bearer' });
    await http().get('/api/v1/test-access/staff').set(session.bearer).expect(200);
  });

  describe('R64: refused sessions are 401 AUTH_REQUIRED', () => {
    it('no credential', async () => {
      const res = await http().get('/api/v1/test-access/authenticated').expect(401);
      expect(codeOf(res)).toBe('AUTH_REQUIRED');
    });

    it('an unknown token', async () => {
      await http()
        .get('/api/v1/test-access/authenticated')
        .set('Cookie', `__Host-asms_session=${'x'.repeat(43)}`)
        .expect(401);
    });

    it('a revoked session', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user, { revokedAt: new Date() });
      await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
    });

    it('an expired session', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user, { expiresAt: new Date(Date.now() - 1000) });
      await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
    });

    it('an idle session (last seen 24 hours ago)', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user, {
        lastSeenAt: new Date(Date.now() - 24 * 60 * 60_000),
      });
      await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
    });

    it('a cookie token sent as a bearer, and a bearer token sent as a cookie', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const cookie = await createSchoolSession(db(), school, user);
      const bearer = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await http().get('/api/v1/test-access/authenticated').set(cookie.bearer).expect(401);
      await http().get('/api/v1/test-access/authenticated').set('Cookie', bearer.cookie).expect(401);
    });

    it('both a cookie and a bearer on one request, even when both are valid', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const cookie = await createSchoolSession(db(), school, user);
      const bearer = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await http()
        .get('/api/v1/test-access/authenticated')
        .set('Cookie', cookie.cookie)
        .set(bearer.bearer)
        .expect(401);
    });

    it('a malformed bearer value', async () => {
      await http().get('/api/v1/test-access/authenticated').set({ Authorization: 'Bearer short', 'X-App-Version': TEST_APP_VERSION }).expect(401);
      await http().get('/api/v1/test-access/authenticated').set('Authorization', 'Basic abc').expect(401);
    });

    it('a terminated school', async () => {
      const gone = await createSchool();
      const user = await createSchoolUser(db(), gone, { systemRole: 'principal' });
      const s = await createSchoolSession(db(), gone, user);
      await db().school.update({ where: { id: gone.id }, data: { status: 'terminated' } });
      await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
    });
  });

  it('R56: a platform session is refused on a school route', async () => {
    const admin = await signedInPlatformAdmin();
    await http().get('/api/v1/test-access/authenticated').set('Cookie', admin.cookie).expect(401);
  });

  it('R9 / R71: a disabled user has no live session', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'office_staff', userStatus: 'disabled' });
    const s = await createSchoolSession(db(), school, user);
    await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
  });

  it('R71: a user with no active capacity (staff left, no guardian link) is refused 401', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'office_staff', staffStatus: 'left' });
    const s = await createSchoolSession(db(), school, user);
    await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
  });

  it('R71: a staff user whose only role row has ended has no capacity', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const s = await createSchoolSession(db(), school, user);
    await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(200);
    await db().userRole.update({
      where: { schoolId_id: { schoolId: school.id, id: user.userRoleId } },
      data: { endedAt: new Date(), endedBy: user.userId },
    });
    await http().get('/api/v1/test-access/authenticated').set('Cookie', s.cookie).expect(401);
  });

  it('R59: a staff record that is not active gives no staff capability, whatever rows exist', async () => {
    // One person who is a guardian and (suspended) staff: the guardian capacity keeps the session.
    const parent = await createGuardianUser(db(), school);
    const staff = await db().staff.create({
      data: { schoolId: school.id, fullName: 'Suspended Principal', phone: '+923001112233', status: 'suspended' },
    });
    await db().user.update({
      where: { schoolId_id: { schoolId: school.id, id: parent.userId } },
      data: { staffId: staff.id },
    });
    await db().userRole.create({ data: { schoolId: school.id, userId: parent.userId, systemRole: 'principal' } });
    const { cookie } = await createSchoolSession(db(), school, parent);
    await http().get('/api/v1/test-access/authenticated').set('Cookie', cookie).expect(200);
    await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(403);
    await http().get('/api/v1/test-access/staff').set('Cookie', cookie).expect(403);
    await db().staff.update({
      where: { schoolId_id: { schoolId: school.id, id: staff.id } },
      data: { status: 'active' },
    });
    await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(200);
  });

  describe('R78: a parent-only session', () => {
    let cookie: string;
    beforeAll(async () => {
      const parent = await createGuardianUser(db(), school);
      cookie = (await createSchoolSession(db(), school, parent)).cookie;
    });

    it('is a live session on @AuthenticatedOnly routes', async () => {
      await http().get('/api/v1/test-access/authenticated').set('Cookie', cookie).expect(200);
    });

    it('is 403 PERMISSION_DENIED on @RequireStaff and @RequireCapability routes', async () => {
      for (const path of ['staff', 'settings', 'either']) {
        const res = await http().get(`/api/v1/test-access/${path}`).set('Cookie', cookie).expect(403);
        expect(codeOf(res)).toBe('PERMISSION_DENIED');
      }
    });
  });

  describe('@RequireCapability is any-of', () => {
    it('office staff lacks school.settings.manage but holds student.view', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const { cookie } = await createSchoolSession(db(), school, user);
      const denied = await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(403);
      expect(codeOf(denied)).toBe('PERMISSION_DENIED');
      await http().get('/api/v1/test-access/either').set('Cookie', cookie).expect(200);
    });

    it('a principal holds both', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const { cookie } = await createSchoolSession(db(), school, user);
      await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(200);
    });
  });

  it('R69: ending a role takes effect on the same session’s next request', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
    await db().userRole.create({
      data: { schoolId: school.id, userId: user.userId, systemRole: 'office_staff', assignedBy: user.userId },
    });
    const { cookie } = await createSchoolSession(db(), school, user);
    await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(200);
    await db().userRole.update({
      where: { schoolId_id: { schoolId: school.id, id: user.userRoleId } },
      data: { endedAt: new Date(), endedBy: user.userId },
    });
    await http().get('/api/v1/test-access/settings').set('Cookie', cookie).expect(403);
    await http().get('/api/v1/test-access/either').set('Cookie', cookie).expect(200);
  });

  // Phase 1 R80 lifted by contracts/slice-9.md §10: a suspended school works like an active one.
  describe('R80 lifted: a suspended school is not read-only', () => {
    let cookie: string;
    beforeAll(async () => {
      const suspended = await createSchool({ status: 'suspended' });
      const user = await createSchoolUser(db(), suspended, { systemRole: 'principal' });
      cookie = (await createSchoolSession(db(), suspended, user)).cookie;
    });

    it('GET still works', async () => {
      await http().get('/api/v1/test-access/staff').set('Cookie', cookie).expect(200);
    });

    it('R80 lifted (§10 a): a non-GET works', async () => {
      await http().post('/api/v1/test-access/staff').set('Cookie', cookie).set('Origin', ORIGIN).expect(201);
    });

    it('R80 lifted (§10 e): a terminated school is unchanged, every session 401', async () => {
      const terminated = await createSchool({ status: 'terminated' });
      const user = await createSchoolUser(db(), terminated, { systemRole: 'principal' });
      const s = await createSchoolSession(db(), terminated, user);
      await http().get('/api/v1/test-access/staff').set('Cookie', s.cookie).expect(401);
      await http().post('/api/v1/test-access/staff').set('Cookie', s.cookie).set('Origin', ORIGIN).expect(401);
    });
  });

  it('last_seen_at is refreshed when older than 5 minutes, not on every request', async () => {
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const old = new Date(Date.now() - 10 * 60_000);
    const s = await createSchoolSession(db(), school, user, { lastSeenAt: old });
    await http().get('/api/v1/test-access/staff').set('Cookie', s.cookie).expect(200);
    const after = await db().session.findFirst({ where: { schoolId: school.id, id: s.sessionId } });
    expect(after?.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    const recent = new Date(Date.now() - 60_000);
    const s2 = await createSchoolSession(db(), school, user, { lastSeenAt: recent });
    await http().get('/api/v1/test-access/staff').set('Cookie', s2.cookie).expect(200);
    const after2 = await db().session.findFirst({ where: { schoolId: school.id, id: s2.sessionId } });
    expect(after2?.lastSeenAt.getTime()).toBe(recent.getTime());
  });
});
