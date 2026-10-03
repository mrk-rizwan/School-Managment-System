// Grants, revokes and the permissions view end to end (contracts/slice-7.md §4, §5): R45-R51,
// R55, R57-R59, R69, R75, R79. Custom roles are in custom-roles.e2e-spec.ts.
import { CapabilityGrantRepository } from '../../src/repositories/capability-grant.repository';
import { createGuardianUser } from '../school-auth/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import { errorOf, ID, StaffHarness, type Caller } from '../staff/support';

interface Grant {
  id: string;
  userId: string;
  capability: string;
  effect: string;
  reason: string;
  grantedBy: string;
  grantedByName: string | null;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedByName: string | null;
  endReason: string | null;
}

interface Permissions {
  userId: string;
  staffCapacity: boolean;
  roles: { systemRole: string | null; customRoleId: string | null; capabilities: string[] }[];
  deltas: Grant[];
  effective: { capability: string; group: string; scope: string; sources: { kind: string; grantId: string | null }[] }[];
}

describe('grants, revokes and the permissions view (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let office: Caller;

  const grantsOf = (userId: bigint | string) => `/api/v1/users/${userId}/grants`;
  const viewOf = (userId: bigint | string) => `/api/v1/users/${userId}/permissions`;
  const give = (
    userId: bigint | string,
    capability: string,
    effect: 'grant' | 'revoke' = 'grant',
    cookie = principal.cookie,
  ) => h.send('post', grantsOf(userId), { capability, effect, reason: 'Covering the accounts desk' }, cookie);
  const end = (id: string, cookie = principal.cookie) =>
    h.send('post', `/api/v1/grants/${id}/end`, { reason: 'Cover finished' }, cookie);
  const me = async (cookie: string) => (await h.get('/api/v1/me', cookie)).body as { capabilities: string[] };
  const auditFor = (userId: bigint) =>
    db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'user', subjectId: userId, action: { startsWith: 'capability_grant.' } },
      orderBy: { id: 'asc' },
    });
  /** A revoke row written straight to the database (no API path can revoke from a principal's own row). */
  const revokeRow = (userId: bigint, capabilityKey: string, grantedBy: bigint) =>
    db.userCapabilityGrant.create({
      data: { schoolId: school.id, userId, capabilityKey, effect: 'revoke', grantedBy, reason: 'Test setup' },
    });

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    principal = await h.caller(school, 'principal', 'Head Teacher');
    office = await h.caller(school, 'office_staff');
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  describe('POST /users/:id/grants', () => {
    it('R50, R69, R57: principal grants payment.verify to an office user; /me shows it next request; ending removes it', async () => {
      const clerk = await h.caller(school, 'office_staff');
      expect((await me(clerk.cookie)).capabilities).not.toContain('payment.verify');
      const res = await give(clerk.userId, 'payment.verify');
      expect(res.status).toBe(201);
      const grant = res.body as Grant;
      expect(grant).toEqual({
        id: expect.stringMatching(ID),
        userId: String(clerk.userId),
        capability: 'payment.verify',
        effect: 'grant',
        reason: 'Covering the accounts desk',
        grantedBy: String(principal.userId),
        grantedByName: 'Head Teacher',
        grantedAt: expect.any(String),
        revokedAt: null,
        revokedBy: null,
        revokedByName: null,
        endReason: null,
      });
      expect((await me(clerk.cookie)).capabilities).toContain('payment.verify');

      const ended = await end(grant.id);
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ revokedBy: String(principal.userId), revokedByName: 'Head Teacher', endReason: 'Cover finished' });
      expect((await me(clerk.cookie)).capabilities).not.toContain('payment.verify');
      // R50: ending twice is a no-op: same row, one audit row.
      const again = await end(grant.id);
      expect(again.status).toBe(200);
      expect((again.body as Grant).revokedAt).toBe((ended.body as Grant).revokedAt);
      expect((await auditFor(clerk.userId)).map((a) => [a.action, a.reason, a.metadata, a.actorUserId])).toEqual([
        ['capability_grant.created', 'Covering the accounts desk', { grantId: grant.id, capability: 'payment.verify', effect: 'grant' }, principal.userId],
        ['capability_grant.ended', 'Cover finished', { grantId: grant.id, capability: 'payment.verify', effect: 'grant' }, principal.userId],
      ]);
      // Append-only: the row is still there, ended.
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: clerk.userId } })).toBe(1);
    });

    it('R50: a revoke removes a default; a grant of the same key wins; ending the grant leaves the revoke', async () => {
      const clerk = await h.caller(school, 'office_staff');
      const revoke = (await give(clerk.userId, 'payment.record', 'revoke')).body as Grant;
      expect((await me(clerk.cookie)).capabilities).not.toContain('payment.record');
      const grant = (await give(clerk.userId, 'payment.record', 'grant')).body as Grant;
      expect((await me(clerk.cookie)).capabilities).toContain('payment.record');
      await end(grant.id);
      expect((await me(clerk.cookie)).capabilities).not.toContain('payment.record');
      await end(revoke.id);
      expect((await me(clerk.cookie)).capabilities).toContain('payment.record');
    });

    it('R45, R75: role.manage cannot be granted or revoked (422), nor stored (CHECK)', async () => {
      const t = await h.caller(school, 'teacher');
      for (const effect of ['grant', 'revoke'] as const) {
        const res = await give(t.userId, 'role.manage', effect);
        expect(res.status).toBe(422);
      }
      expect((await give(t.userId, 'payment.teleport')).status).toBe(422);
      await expect(
        db.userCapabilityGrant.create({
          data: { schoolId: school.id, userId: t.userId, capabilityKey: 'role.manage', effect: 'revoke', grantedBy: principal.userId, reason: 'x' },
        }),
      ).rejects.toThrow(/user_capability_grants_no_role_manage_check/);
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: t.userId } })).toBe(0);
    });

    it('R46: nobody grants, revokes or ends what they do not hold', async () => {
      const s = await createSchool();
      const boss = await h.caller(s, 'principal');
      const other = await createSchoolUser(db, s, { systemRole: 'principal' });
      // Another principal revoked payroll.run from boss (a revoke row; R48 allows it to a role.manage holder).
      await db.userCapabilityGrant.create({
        data: { schoolId: s.id, userId: boss.userId, capabilityKey: 'payroll.run', effect: 'revoke', grantedBy: other.userId, reason: 'Test setup' },
      });
      const t = await createSchoolUser(db, s, { systemRole: 'teacher' });
      for (const effect of ['grant', 'revoke'] as const) {
        const res = await give(t.userId, 'payroll.run', effect, boss.cookie);
        expect(res.status).toBe(403);
        expect(errorOf(res)).toMatchObject({
          code: 'PERMISSION_DENIED',
          details: { reason: 'capability_not_held', capabilities: ['payroll.run'] },
        });
      }
      // Ending a row of that key, made by someone who held it, is refused too.
      const made = await db.userCapabilityGrant.create({
        data: { schoolId: s.id, userId: t.userId, capabilityKey: 'payroll.run', effect: 'grant', grantedBy: other.userId, reason: 'Test setup' },
      });
      expect((await end(String(made.id), boss.cookie)).status).toBe(403);
      expect((await db.userCapabilityGrant.findFirst({ where: { schoolId: s.id, id: made.id } }))?.revokedAt).toBeNull();
    });

    it('R47: nobody grants, revokes or ends on themselves (also a CHECK)', async () => {
      const res = await give(principal.userId, 'payment.verify', 'revoke');
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SELF_ACTION_FORBIDDEN');
      const other = await createSchoolUser(db, school, { systemRole: 'principal' });
      const mine = await revokeRow(principal.userId, 'payroll.view', other.userId);
      const ending = await end(String(mine.id));
      expect(ending.status).toBe(409);
      expect(errorOf(ending).code).toBe('SELF_ACTION_FORBIDDEN');
      await expect(
        db.userCapabilityGrant.create({
          data: { schoolId: school.id, userId: principal.userId, capabilityKey: 'payroll.view', effect: 'grant', grantedBy: principal.userId, reason: 'x' },
        }),
      ).rejects.toThrow(/user_capability_grants_not_self_check/);
    });

    it('R48, R55: office staff (no role.manage) get 403 on every permissions write and on the view', async () => {
      const t = await h.caller(school, 'teacher');
      const theirs = (await give(t.userId, 'student.create')).body as Grant;
      const responses = [
        await give(t.userId, 'student.view', 'grant', office.cookie),
        await give(principal.userId, 'student.view', 'revoke', office.cookie),
        await end(theirs.id, office.cookie),
        await h.get(viewOf(t.userId), office.cookie),
        await h.send('post', '/api/v1/custom-roles', { key: 'clerk', name: 'Clerk', capabilities: [] }, office.cookie),
        await h.send('post', `/api/v1/users/${t.userId}/roles`, { customRoleId: '1', reason: 'Testing' }, office.cookie),
      ];
      expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: t.userId, revokedAt: null } })).toBe(1);
    });

    it('R49: refused for a suspended or left staff member, a staff login with no role, and a parent-only login', async () => {
      const suspended = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
      const left = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'left' });
      const roleless = await createSchoolUser(db, school, { systemRole: 'teacher' });
      await db.userRole.updateMany({
        where: { schoolId: school.id, id: roleless.userRoleId },
        data: { endedAt: new Date(), endedBy: principal.userId },
      });
      const parent = await createGuardianUser(db, school);
      const reasons = [];
      for (const user of [suspended, left, roleless, parent]) {
        const res = await give(user.userId, 'student.view');
        expect(res.status).toBe(409);
        reasons.push(errorOf(res));
      }
      expect(reasons.map((e) => [e.code, e.details?.reason])).toEqual([
        ['STAFF_NOT_ACTIVE', 'staff_not_active'],
        ['STAFF_NOT_ACTIVE', 'staff_not_active'],
        ['STAFF_NOT_ACTIVE', 'no_staff_role'],
        ['STAFF_NOT_ACTIVE', 'staff_not_active'],
      ]);
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: { in: [suspended.userId, left.userId, roleless.userId, parent.userId] } } })).toBe(0);
    });

    it('R51: a grantor later losing the capability does not cascade to grants they made', async () => {
      const s = await createSchool();
      const grantor = await h.caller(s, 'principal');
      const other = await createSchoolUser(db, s, { systemRole: 'principal' });
      const t = await h.caller(s, 'teacher');
      expect((await give(t.userId, 'payment.verify', 'grant', grantor.cookie)).status).toBe(201);
      await db.userCapabilityGrant.create({
        data: { schoolId: s.id, userId: grantor.userId, capabilityKey: 'payment.verify', effect: 'revoke', grantedBy: other.userId, reason: 'Test setup' },
      });
      expect((await me(grantor.cookie)).capabilities).not.toContain('payment.verify');
      expect((await me(t.cookie)).capabilities).toContain('payment.verify');
    });

    it('GRANT_EXISTS on a live duplicate; racing grants make one row, losers get GRANT_EXISTS', async () => {
      const t = await h.caller(school, 'teacher');
      const first = (await give(t.userId, 'staff.view')).body as Grant;
      const dup = await give(t.userId, 'staff.view');
      expect(dup.status).toBe(409);
      expect(errorOf(dup)).toMatchObject({ code: 'GRANT_EXISTS', details: { grantId: first.id } });
      const racer = await h.caller(school, 'teacher');
      const results = await Promise.all([1, 2, 3].map(() => give(racer.userId, 'guardian.manage')));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(errorOf(r).code).toBe('GRANT_EXISTS');
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: racer.userId } })).toBe(1);
    });

    it('racing ends of one row: both 200, one end, one audit row', async () => {
      const t = await h.caller(school, 'teacher');
      const grant = (await give(t.userId, 'staff.view')).body as Grant;
      const results = await Promise.all([end(grant.id), end(grant.id)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect((await auditFor(t.userId)).filter((a) => a.action === 'capability_grant.ended')).toHaveLength(1);
    });

    it('404 for another school’s user or grant; a malformed id is 404; unknown fields are 422', async () => {
      const other = await createSchool();
      const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
      const theirBoss = await createSchoolUser(db, other, { systemRole: 'principal' });
      expect((await give(theirs.userId, 'staff.view')).status).toBe(404);
      const theirGrant = await db.userCapabilityGrant.create({
        data: { schoolId: other.id, userId: theirs.userId, capabilityKey: 'staff.view', effect: 'grant', grantedBy: theirBoss.userId, reason: 'Theirs' },
      });
      expect((await end(String(theirGrant.id))).status).toBe(404);
      expect((await h.get(viewOf(theirs.userId), principal.cookie)).status).toBe(404);
      expect((await end('abc')).status).toBe(404);
      expect((await db.userCapabilityGrant.findFirst({ where: { schoolId: other.id, id: theirGrant.id } }))?.revokedAt).toBeNull();
      const t = await h.caller(school, 'teacher');
      const extra = await h.send('post', grantsOf(t.userId), { capability: 'staff.view', effect: 'grant', reason: 'Fine reason', schoolId: '1' }, principal.cookie);
      expect(extra.status).toBe(422);
      expect((await h.send('post', grantsOf(t.userId), { capability: 'staff.view', effect: 'grant' }, principal.cookie)).status).toBe(422);
      expect((await h.send('post', grantsOf(t.userId), { capability: 'staff.view', effect: 'maybe', reason: 'Fine reason' }, principal.cookie)).status).toBe(422);
    });

    it('the grant rows are append-only except ending (trigger)', async () => {
      const t = await h.caller(school, 'teacher');
      const grant = (await give(t.userId, 'staff.view')).body as Grant;
      const id = BigInt(grant.id);
      await expect(
        db.userCapabilityGrant.updateMany({ where: { schoolId: school.id, id }, data: { capabilityKey: 'payroll.run' } }),
      ).rejects.toThrow();
      await end(grant.id);
      await expect(
        db.userCapabilityGrant.updateMany({ where: { schoolId: school.id, id }, data: { endReason: 'Rewritten' } }),
      ).rejects.toThrow();
      expect((await db.userCapabilityGrant.findFirst({ where: { schoolId: school.id, id } }))?.endReason).toBe('Cover finished');
    });
  });

  describe('GET /users/:id/permissions', () => {
    it('R58: three columns; effective equals what the target’s own /me lists, with sources and scope (R79)', async () => {
      const t = await h.caller(school, 'teacher');
      const grant = (await give(t.userId, 'student.view')).body as Grant;
      const revoke = (await give(t.userId, 'diary.write', 'revoke')).body as Grant;
      const res = await h.get(viewOf(t.userId), principal.cookie);
      expect(res.status).toBe(200);
      const view = res.body as Permissions;
      expect(view).toMatchObject({ userId: String(t.userId), staffCapacity: true, staffStatus: 'active' });
      expect(view.roles).toEqual([
        expect.objectContaining({
          systemRole: 'teacher',
          customRoleId: null,
          capabilities: ['student.view', 'attendance.student.mark', 'marks.enter', 'diary.write', 'remark.write', 'announcement.send.scope'],
        }),
      ]);
      expect(view.deltas.map((d) => d.id).sort()).toEqual([grant.id, revoke.id].sort());
      expect(view.effective.map((l) => l.capability)).toEqual((await me(t.cookie)).capabilities);
      expect(view.effective.map((l) => l.capability)).not.toContain('diary.write');
      const studentView = view.effective.find((l) => l.capability === 'student.view');
      expect(studentView).toMatchObject({ group: 'students', scope: 'all' });
      expect(studentView?.sources.map((s) => [s.kind, s.grantId])).toEqual([['system_role', null], ['grant', grant.id]]);
      expect(view.effective.find((l) => l.capability === 'marks.enter')?.scope).toBe('assigned_sections');

      // R79: the guard binds the school-wide scope a grant gives.
      const scope = await h.get('/api/v1/test-scope', t.cookie);
      expect(scope.body).toEqual({ kind: 'all' });

      // History only with includeEnded.
      await end(grant.id);
      expect(((await h.get(viewOf(t.userId), principal.cookie)).body as Permissions).deltas.map((d) => d.id)).toEqual([revoke.id]);
      const all = (await h.get(`${viewOf(t.userId)}?includeEnded=true`, principal.cookie)).body as Permissions;
      expect(all.deltas.map((d) => d.id).sort()).toEqual([grant.id, revoke.id].sort());
      expect((await h.get(`${viewOf(t.userId)}?other=1`, principal.cookie)).status).toBe(422);
    });

    it('R59: a suspended staff member shows no effective capability whatever rows are stored', async () => {
      const t = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
      await db.userCapabilityGrant.create({
        data: { schoolId: school.id, userId: t.userId, capabilityKey: 'payroll.view', effect: 'grant', grantedBy: principal.userId, reason: 'Test setup' },
      });
      const view = (await h.get(viewOf(t.userId), principal.cookie)).body as Permissions;
      expect(view).toMatchObject({ staffCapacity: false, staffStatus: 'suspended', effective: [] });
      expect(view.roles).toHaveLength(1);
      expect(view.deltas).toHaveLength(1);
      const parent = await createGuardianUser(db, school);
      expect((await h.get(viewOf(parent.userId), principal.cookie)).body).toMatchObject({
        staffId: null,
        staffCapacity: false,
        roles: [],
        effective: [],
      });
    });

    it('R16: no identity number in any response or log line of this suite', async () => {
      const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
      const session = await createSchoolSession(db, school, t);
      await h.get('/api/v1/me', session.cookie);
      for (const text of [...h.bodies, ...h.logs]) {
        expect(text).not.toMatch(/\d{13}|\d{5}-\d{7}-\d/);
      }
    });
  });

  describe('principals are unrestricted peers; review edges', () => {
    it('a grant or revoke aimed at a principal is 409 TARGET_IS_PRINCIPAL; nothing is stored', async () => {
      const peer = await createSchoolUser(db, school, { systemRole: 'principal' });
      for (const effect of ['grant', 'revoke'] as const) {
        const res = await give(peer.userId, 'payroll.run', effect);
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('TARGET_IS_PRINCIPAL');
      }
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: peer.userId } })).toBe(0);
    });

    it('becoming principal ends every live grant and revoke row ("became principal"), audited', async () => {
      const clerk = await h.caller(school, 'office_staff');
      const grant = (await give(clerk.userId, 'payment.verify')).body as Grant;
      const revoke = (await give(clerk.userId, 'payment.record', 'revoke')).body as Grant;
      const res = await h.send('post', `/api/v1/users/${clerk.userId}/roles`, { systemRole: 'principal', reason: 'Promoted to head' }, principal.cookie);
      expect(res.status).toBe(201);
      const rows = await db.userCapabilityGrant.findMany({ where: { schoolId: school.id, userId: clerk.userId }, orderBy: { id: 'asc' } });
      expect(rows.map((r) => [String(r.id), r.revokedBy, r.endReason])).toEqual([
        [grant.id, principal.userId, 'became principal'],
        [revoke.id, principal.userId, 'became principal'],
      ]);
      const audit = await db.auditLog.findFirst({
        where: { schoolId: school.id, subjectType: 'user', subjectId: clerk.userId, action: 'user_role.assigned' },
      });
      expect(audit?.metadata).toMatchObject({ systemRole: 'principal', grantsEnded: 2 });
      expect((await me(clerk.cookie)).capabilities).toContain('payment.record');
    });

    it('A7: ending a row whose stored key is not a delegable registry key is 404', async () => {
      const t = await h.caller(school, 'teacher');
      const odd = await db.userCapabilityGrant.create({
        data: { schoolId: school.id, userId: t.userId, capabilityKey: 'payment.teleport', effect: 'grant', grantedBy: principal.userId, reason: 'Test setup' },
      });
      expect((await end(String(odd.id))).status).toBe(404);
      expect((await db.userCapabilityGrant.findFirst({ where: { schoolId: school.id, id: odd.id } }))?.revokedAt).toBeNull();
    });

    it('a duplicate that slips past the in-transaction check gets GRANT_EXISTS from the live-row index', async () => {
      const t = await h.caller(school, 'teacher');
      const first = (await give(t.userId, 'certificate.issue')).body as Grant;
      const spy = jest.spyOn(CapabilityGrantRepository.prototype, 'findLive').mockResolvedValueOnce(null);
      try {
        const dup = await give(t.userId, 'certificate.issue');
        expect(dup.status).toBe(409);
        expect(errorOf(dup)).toMatchObject({ code: 'GRANT_EXISTS', details: { grantId: first.id } });
      } finally {
        spy.mockRestore();
      }
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: t.userId } })).toBe(1);
    });

    it('B8: the permissions view lists system and custom role rows in assignment order', async () => {
      const t = await h.caller(school, 'teacher');
      const role = (
        await h.send('post', '/api/v1/custom-roles', { key: `view_${Date.now().toString(36)}`, name: 'Library desk', capabilities: ['staff.view'] }, principal.cookie)
      ).body as { id: string };
      await h.send('post', `/api/v1/users/${t.userId}/roles`, { customRoleId: role.id, reason: 'Runs the library' }, principal.cookie);
      const view = (await h.get(viewOf(t.userId), principal.cookie)).body as Permissions & {
        roles: { userRoleId: string; customRoleName: string | null; customRoleStatus: string | null }[];
      };
      expect(view.roles).toEqual([
        expect.objectContaining({ userRoleId: String(t.userRoleId), systemRole: 'teacher', customRoleId: null, customRoleStatus: null }),
        expect.objectContaining({ systemRole: null, customRoleId: role.id, customRoleName: 'Library desk', customRoleStatus: 'active', capabilities: ['staff.view'] }),
      ]);
    });
  });
});
