// System-role assignment end to end (contracts/slice-4.md §5): R13, R57, R69, R71-R74.
import { Capability } from '@asms/shared';
import { UserRolesService } from '../../src/modules/people/staff/user-roles.service';
import { createGuardianUser } from '../school-auth/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import { errorOf, ID, StaffHarness, type Caller } from './support';

interface UserRole {
  id: string;
  userId: string;
  systemRole: string | null;
  customRoleId: string | null;
  assignedBy: string | null;
  endedAt: string | null;
  endedBy: string | null;
}

describe('system roles (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let office: Caller;

  const rolesOf = (userId: bigint | string) => `/api/v1/users/${userId}/roles`;
  const assign = (userId: bigint | string, systemRole: string, cookie = principal.cookie) =>
    h.send('post', rolesOf(userId), { systemRole, reason: 'Timetable needs it' }, cookie);
  const remove = (id: bigint | string, cookie = principal.cookie) =>
    h.send('post', `/api/v1/user-roles/${id}/remove`, { reason: 'No longer needed' }, cookie);
  const auditFor = (userId: bigint, action: string) =>
    db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'user', subjectId: userId, action },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    principal = await h.caller(school, 'principal');
    office = await h.caller(school, 'office_staff');
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('GET lists live rows (history with includeEnded) for user.account.manage or role.manage', async () => {
    const t = await h.caller(school, 'teacher');
    const added = (await assign(t.userId, 'office_staff')).body as UserRole;
    expect((await remove(added.id)).status).toBe(200);
    const live = await h.get(rolesOf(t.userId), office.cookie);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ total: 1, data: [{ id: String(t.userRoleId), systemRole: 'teacher', endedAt: null }] });
    const all = await h.get(`${rolesOf(t.userId)}?includeEnded=true`, principal.cookie);
    expect((all.body as { data: UserRole[] }).data.map((r) => [r.systemRole, r.endedAt === null])).toEqual([
      ['office_staff', false],
      ['teacher', true],
    ]);
    expect((await h.get(rolesOf(t.userId), t.cookie)).status).toBe(403);
    const other = await createSchool();
    const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
    expect((await h.get(rolesOf(theirs.userId), principal.cookie)).status).toBe(404);
  });

  describe('POST /users/:id/roles', () => {
    it('assigns a role, audited; it counts on the target’s next request (R69)', async () => {
      const t = await h.caller(school, 'teacher');
      expect((await h.get('/api/v1/staff', t.cookie)).status).toBe(403);
      const res = await assign(t.userId, 'office_staff');
      expect(res.status).toBe(201);
      const row = res.body as UserRole;
      expect(row).toEqual({
        id: expect.stringMatching(ID),
        userId: String(t.userId),
        systemRole: 'office_staff',
        customRoleId: null,
        assignedBy: String(principal.userId),
        assignedAt: expect.any(String),
        endedAt: null,
        endedBy: null,
      });
      expect((await auditFor(t.userId, 'user_role.assigned')).map((a) => [a.reason, a.metadata, a.actorUserId])).toEqual([
        ['Timetable needs it', { systemRole: 'office_staff', userRoleId: row.id }, principal.userId],
      ]);
      expect((await h.get('/api/v1/staff', t.cookie)).status).toBe(200);
    });

    it('R13: only role.manage assigns roles; office staff are refused', async () => {
      const t = await h.caller(school, 'teacher');
      const res = await assign(t.userId, 'office_staff', office.cookie);
      expect(res.status).toBe(403);
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: t.userId } })).toBe(1);
    });

    it('R74, STAFF_NOT_ACTIVE, ROLE_ALREADY_ASSIGNED, 422 and 404', async () => {
      expect(errorOf(await assign(principal.userId, 'teacher')).code).toBe('SELF_ACTION_FORBIDDEN');
      const suspended = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
      expect(errorOf(await assign(suspended.userId, 'office_staff')).code).toBe('STAFF_NOT_ACTIVE');
      const parent = await createGuardianUser(db, school);
      expect(errorOf(await assign(parent.userId, 'teacher')).code).toBe('STAFF_NOT_ACTIVE');
      const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
      const dup = await assign(t.userId, 'teacher');
      expect(dup.status).toBe(409);
      expect(errorOf(dup)).toMatchObject({ code: 'ROLE_ALREADY_ASSIGNED', details: { userRoleId: String(t.userRoleId) } });
      expect((await assign(t.userId, 'parent')).status).toBe(422);
      expect((await h.send('post', rolesOf(t.userId), { systemRole: 'office_staff' }, principal.cookie)).status).toBe(422);
      expect((await h.send('post', rolesOf(t.userId), { systemRole: 'office_staff', reason: 'ok go', customRoleId: '1' }, principal.cookie)).status).toBe(422);
      const other = await createSchool();
      const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
      expect((await assign(theirs.userId, 'office_staff')).status).toBe(404);
      expect(await db.userRole.count({ where: { schoolId: other.id, userId: theirs.userId } })).toBe(1);
    });

    it('racing assigns of one role: one row, the losers get ROLE_ALREADY_ASSIGNED', async () => {
      const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
      const results = await Promise.all([1, 2, 3].map(() => assign(t.userId, 'office_staff')));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      const winner = results.find((r) => r.status === 201)?.body as UserRole;
      for (const r of results.filter((x) => x.status === 409)) {
        expect(errorOf(r).details).toEqual({ userRoleId: winner.id });
      }
    });
  });

  describe('POST /user-roles/:id/remove', () => {
    it('ends the row, audited; R71: a login left with no role is refused on its next request', async () => {
      const t = await h.caller(school, 'teacher');
      expect((await h.get('/api/v1/me', t.cookie)).status).toBe(200);
      const res = await remove(t.userRoleId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: String(t.userRoleId), endedAt: expect.any(String), endedBy: String(principal.userId) });
      expect((await auditFor(t.userId, 'user_role.removed')).map((a) => [a.reason, a.metadata])).toEqual([
        ['No longer needed', { systemRole: 'teacher', userRoleId: String(t.userRoleId) }],
      ]);
      // Sessions are not revoked; resolution refuses them (R69, R71).
      expect(await db.session.count({ where: { schoolId: school.id, userId: t.userId, revokedAt: null } })).toBe(1);
      expect((await h.get('/api/v1/me', t.cookie)).status).toBe(401);
      // Already ended: 200, unchanged, no second audit row.
      expect((await remove(t.userRoleId)).status).toBe(200);
      expect(await auditFor(t.userId, 'user_role.removed')).toHaveLength(1);
    });

    it('R74: not your own role; office staff refused; 404 for another school', async () => {
      expect(errorOf(await remove(principal.userRoleId)).code).toBe('SELF_ACTION_FORBIDDEN');
      const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
      expect((await remove(t.userRoleId, office.cookie)).status).toBe(403);
      const other = await createSchool();
      const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
      expect((await remove(theirs.userRoleId)).status).toBe(404);
      expect((await db.userRole.findFirst({ where: { schoolId: other.id, id: theirs.userRoleId } }))?.endedAt).toBeNull();
      expect((await remove('abc')).status).toBe(404);
    });

    it('R72: the only active principal’s role cannot be removed', async () => {
      const s = await createSchool();
      await db.schoolSettings.create({ data: { schoolId: s.id, feeDueDay: 10 } });
      const boss = await createSchoolUser(db, s, { systemRole: 'principal' });
      const clerk = await createSchoolUser(db, s, { systemRole: 'office_staff' });
      // A clerk holding role.manage, as no system role but principal can yet (slice 7 grants).
      const session = await h.widenedSession(s, clerk.userId, [Capability.ROLE_MANAGE]);
      const service = h.app.get(UserRolesService);
      const dto = { reason: 'Testing R72' };
      await expect(service.remove(session, boss.userRoleId, dto)).rejects.toMatchObject({ status: 409, code: 'LAST_PRINCIPAL' });
      const second = await createSchoolUser(db, s, { systemRole: 'principal' });
      await expect(service.remove(session, boss.userRoleId, dto)).resolves.toMatchObject({ endedAt: expect.any(Date) });
      await expect(service.remove(session, second.userRoleId, dto)).rejects.toMatchObject({ code: 'LAST_PRINCIPAL' });
    });

    it('R73: a principal removing another while that one sets the first left: exactly one succeeds', async () => {
      const s = await createSchool();
      await db.schoolSettings.create({ data: { schoolId: s.id, feeDueDay: 10 } });
      const a = await h.caller(s, 'principal');
      const b = await h.caller(s, 'principal');
      const [removal, leaving] = await Promise.all([
        remove(b.userRoleId, a.cookie),
        h.send('post', `/api/v1/staff/${a.staffId}/change-status`, { status: 'left', reason: 'Racing R73' }, b.cookie),
      ]);
      expect([removal.status, leaving.status].filter((st) => st === 200)).toHaveLength(1);
      const remaining = await db.userRole.count({
        where: { schoolId: s.id, systemRole: 'principal', endedAt: null, user: { staff: { status: 'active' } } },
      });
      expect(remaining).toBe(1);
    });
  });

  it('a fresh session for a user given a role back after re-hire works (R19 with §5)', async () => {
    const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
    await h.send('post', `/api/v1/staff/${t.staffId}/change-status`, { status: 'left', reason: 'Left the school' }, principal.cookie);
    await h.send('post', `/api/v1/staff/${t.staffId}/change-status`, { status: 'active', reason: 'Re-hired again' }, principal.cookie);
    const { cookie } = await createSchoolSession(db, school, t);
    expect((await h.get('/api/v1/me', cookie)).status).toBe(401);
    expect((await assign(t.userId, 'teacher')).status).toBe(201);
    expect((await h.get('/api/v1/me', cookie)).status).toBe(200);
  });
});
