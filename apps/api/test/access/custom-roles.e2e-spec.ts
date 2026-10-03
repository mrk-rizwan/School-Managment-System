// Custom roles end to end (contracts/slice-7.md §3): R13, R45, R52, R57, R69, R79, R94-R96.
import { Client } from 'pg';
import { UserRoleRepository } from '../../src/repositories/user-role.repository';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import { errorOf, ID, StaffHarness, type Caller } from '../staff/support';

interface CustomRole {
  id: string;
  key: string;
  name: string;
  status: string;
  capabilities: string[];
  holderCount: number;
}

interface UserRole {
  id: string;
  systemRole: string | null;
  customRoleId: string | null;
  customRoleName: string | null;
}

let seq = 0;
const uniqueKey = () => `role_${Date.now().toString(36)}_${seq++}`;

describe('custom roles (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let office: Caller;

  const create = (capabilities: string[], cookie = principal.cookie, key = uniqueKey()) =>
    h.send('post', '/api/v1/custom-roles', { key, name: 'Accounts clerk', capabilities }, cookie);
  const patch = (id: string, body: object, cookie = principal.cookie) =>
    h.send('patch', `/api/v1/custom-roles/${id}`, body, cookie);
  const archive = (id: string, cookie = principal.cookie) =>
    h.send('post', `/api/v1/custom-roles/${id}/archive`, { reason: 'No longer used' }, cookie);
  const assign = (userId: bigint | string, customRoleId: string, cookie = principal.cookie) =>
    h.send('post', `/api/v1/users/${userId}/roles`, { customRoleId, reason: 'Runs the accounts desk' }, cookie);
  const me = async (cookie: string) => (await h.get('/api/v1/me', cookie)).body as { capabilities: string[] };
  /**
   * Waits until `count` sessions wait on a lock (requests queued on the lock `pg` holds; the second
   * waiter on a row waits on the first one's tuple lock, so "blocked by pg" would count one).
   * pg_stat_activity is a per-transaction snapshot, and `pg` is inside one: cleared on each poll,
   * or connections the app opens after the first poll are never seen.
   */
  const waitForBlocked = async (pg: Client, count: number) => {
    let last = 0;
    for (let i = 0; i < 200; i++) {
      await pg.query('SELECT pg_stat_clear_snapshot()');
      const { rows } = await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      last = rows[0]?.n ?? 0;
      if (last >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} blocked sessions, saw ${last}`);
  };
  const auditFor = (id: string) =>
    db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'custom_role', subjectId: BigInt(id) },
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

  describe('create, read, list', () => {
    it('creates an active role, audited; readable with user.account.manage; keys in registry order', async () => {
      const key = uniqueKey();
      const res = await create(['finance.report.view', 'payment.verify'], principal.cookie, key);
      expect(res.status).toBe(201);
      const role = res.body as CustomRole;
      expect(role).toEqual({
        id: expect.stringMatching(ID),
        key,
        name: 'Accounts clerk',
        status: 'active',
        capabilities: ['payment.verify', 'finance.report.view'],
        holderCount: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect((await h.get(`/api/v1/custom-roles/${role.id}`, office.cookie)).body).toMatchObject({ id: role.id });
      const list = await h.get(`/api/v1/custom-roles?q=${key}`, office.cookie);
      expect(list.body).toMatchObject({ total: 1, data: [{ id: role.id }] });
      expect((await auditFor(role.id)).map((a) => [a.action, a.metadata])).toEqual([
        ['custom_role.created', { key, capabilities: 'payment.verify,finance.report.view' }],
      ]);
      const teacher = await h.caller(school, 'teacher');
      expect((await h.get('/api/v1/custom-roles', teacher.cookie)).status).toBe(403);
    });

    it('R45, R52: role.manage, unknown keys, bad keys and reserved names are 422; nothing stored', async () => {
      const before = await db.customRole.count({ where: { schoolId: school.id } });
      expect((await create(['role.manage'])).status).toBe(422);
      expect((await create(['payment.teleport'])).status).toBe(422);
      expect((await create(['staff.view', 'staff.view'])).status).toBe(422);
      expect((await create([], principal.cookie, 'Bad Key')).status).toBe(422);
      expect((await create([], principal.cookie, 'teacher')).status).toBe(422);
      expect(await db.customRole.count({ where: { schoolId: school.id } })).toBe(before);
      const role = (await create([])).body as CustomRole;
      await expect(
        db.customRoleCapability.create({
          data: { schoolId: school.id, customRoleId: BigInt(role.id), capabilityKey: 'role.manage', addedBy: principal.userId },
        }),
      ).rejects.toThrow(/custom_role_capabilities_no_role_manage_check/);
    });

    it('CUSTOM_ROLE_KEY_TAKEN among active roles; an archived key is free again; racing creates make one', async () => {
      const key = uniqueKey();
      const first = (await create([], principal.cookie, key)).body as CustomRole;
      const dup = await create([], principal.cookie, key);
      expect(dup.status).toBe(409);
      expect(errorOf(dup)).toMatchObject({ code: 'CUSTOM_ROLE_KEY_TAKEN', details: { customRoleId: first.id } });
      expect((await archive(first.id)).status).toBe(200);
      expect((await create([], principal.cookie, key)).status).toBe(201);
      const raced = uniqueKey();
      const results = await Promise.all([1, 2, 3].map(() => create([], principal.cookie, raced)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });
  });

  describe('R94: editors tick only capabilities they hold', () => {
    it('create and add need the key now; keys already in the role are not re-checked; no cascade', async () => {
      const s = await createSchool();
      const editor = await h.caller(s, 'principal');
      const other = await createSchoolUser(db, s, { systemRole: 'principal' });
      const role = (await create(['payroll.run', 'staff.view'], editor.cookie)).body as CustomRole;
      // Editor later loses payroll.run (another principal's revoke).
      await db.userCapabilityGrant.create({
        data: { schoolId: s.id, userId: editor.userId, capabilityKey: 'payroll.run', effect: 'revoke', grantedBy: other.userId, reason: 'Test setup' },
      });
      const denied = await create(['payroll.run'], editor.cookie);
      expect(denied.status).toBe(403);
      expect(errorOf(denied)).toMatchObject({ details: { reason: 'capability_not_held', capabilities: ['payroll.run'] } });
      const adding = await patch(role.id, { capabilities: ['payroll.run', 'staff.view', 'payroll.view'] }, editor.cookie);
      expect(adding.status).toBe(200);
      expect((adding.body as CustomRole).capabilities).toEqual(['staff.view', 'payroll.view', 'payroll.run']);
      // A creator losing the key does not cascade: the role still carries it.
      const holder = await h.caller(s, 'teacher');
      expect((await assign(holder.userId, role.id, editor.cookie)).status).toBe(201);
      expect((await me(holder.cookie)).capabilities).toContain('payroll.run');
      // Adding a key the editor does not hold is refused.
      await db.userCapabilityGrant.create({
        data: { schoolId: s.id, userId: editor.userId, capabilityKey: 'expense.approve', effect: 'revoke', grantedBy: other.userId, reason: 'Test setup' },
      });
      const adding2 = await patch(
        role.id,
        { capabilities: ['payroll.run', 'staff.view', 'payroll.view', 'expense.approve'], reason: 'Approvals move here' },
        editor.cookie,
      );
      expect(adding2.status).toBe(403);
      expect(errorOf(adding2)).toMatchObject({ details: { reason: 'capability_not_held', capabilities: ['expense.approve'] } });
    });
  });

  describe('R95: removing keys from a held role', () => {
    it('needs a reason; applies to every holder on the next request; one audit row with keys and holder count', async () => {
      const role = (await create(['payment.verify', 'payroll.view'])).body as CustomRole;
      const a = await h.caller(school, 'teacher');
      const b = await h.caller(school, 'teacher');
      await assign(a.userId, role.id);
      await assign(b.userId, role.id);
      expect((await me(a.cookie)).capabilities).toContain('payment.verify');
      const noReason = await patch(role.id, { capabilities: ['payroll.view'] });
      expect(noReason.status).toBe(422);
      const res = await patch(role.id, { capabilities: ['payroll.view'], reason: 'Verification moves to the principal' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ capabilities: ['payroll.view'], holderCount: 2 });
      for (const holder of [a, b]) {
        expect((await me(holder.cookie)).capabilities).not.toContain('payment.verify');
        expect((await me(holder.cookie)).capabilities).toContain('payroll.view');
      }
      const audits = (await auditFor(role.id)).filter((x) => x.action === 'custom_role.updated');
      expect(audits.map((x) => [x.reason, x.metadata])).toEqual([
        ['Verification moves to the principal', { added: '', removed: 'payment.verify', nameChanged: false, holderCount: 2 }],
      ]);
      // The membership row is ended, not deleted.
      expect(
        await db.customRoleCapability.count({ where: { schoolId: school.id, customRoleId: BigInt(role.id), removedAt: { not: null } } }),
      ).toBe(1);
      // No change at all: 200, no audit.
      expect((await patch(role.id, { capabilities: ['payroll.view'] })).status).toBe(200);
      expect((await auditFor(role.id)).filter((x) => x.action === 'custom_role.updated')).toHaveLength(1);
    });
  });

  describe('assignment (R13, R69, R79) and archive (R52, R96)', () => {
    it('R13, R57: assigning a custom role gives its keys school-wide on the next request; removal takes them away', async () => {
      const role = (await create(['student.view', 'payment.record'])).body as CustomRole;
      const t = await h.caller(school, 'teacher');
      expect((await assign(t.userId, role.id, office.cookie)).status).toBe(403);
      const res = await assign(t.userId, role.id);
      expect(res.status).toBe(201);
      const row = res.body as UserRole;
      expect(row).toMatchObject({ systemRole: null, customRoleId: role.id, customRoleName: 'Accounts clerk' });
      expect((await me(t.cookie)).capabilities).toEqual(expect.arrayContaining(['student.view', 'payment.record']));
      // R79: student.view via a custom role is school-wide even for a teacher with no assignments.
      expect((await h.get('/api/v1/test-scope', t.cookie)).body).toEqual({ kind: 'all' });
      const audit = await db.auditLog.findMany({
        where: { schoolId: school.id, subjectType: 'user', subjectId: t.userId, action: 'user_role.assigned' },
      });
      expect(audit.map((a) => a.metadata)).toEqual([{ customRoleId: role.id, userRoleId: row.id }]);
      const dup = await assign(t.userId, role.id);
      expect(errorOf(dup)).toMatchObject({ code: 'ROLE_ALREADY_ASSIGNED', details: { userRoleId: row.id } });

      expect((await h.send('post', `/api/v1/user-roles/${row.id}/remove`, { reason: 'Desk closed' }, principal.cookie)).status).toBe(200);
      expect((await me(t.cookie)).capabilities).not.toContain('payment.record');
      expect((await h.get('/api/v1/test-scope', t.cookie)).body).toEqual({ kind: 'sections', ids: [] });
    });

    it('a staff member with only a custom role has staff capacity', async () => {
      const role = (await create(['staff.view'])).body as CustomRole;
      const t = await h.caller(school, 'teacher', 'Only Custom Clerk');
      await assign(t.userId, role.id);
      await db.userRole.updateMany({
        where: { schoolId: school.id, id: t.userRoleId },
        data: { endedAt: new Date(), endedBy: principal.userId },
      });
      expect((await me(t.cookie)).capabilities).toEqual(['staff.view']);
      // A4: the staff and users screens name the custom role rather than showing no role.
      expect((await h.get(`/api/v1/staff/${t.staffId}`, principal.cookie)).body).toMatchObject({
        systemRoles: [],
        customRoleNames: ['Accounts clerk'],
      });
      expect((await h.get(`/api/v1/users/${t.userId}`, principal.cookie)).body).toMatchObject({
        systemRoles: [],
        customRoleNames: ['Accounts clerk'],
      });
      const list = (await h.get(`/api/v1/staff?limit=50&q=${encodeURIComponent('Only Custom Clerk')}`, principal.cookie)).body as {
        data: { id: string; customRoleNames: string[] }[];
      };
      expect(list.data.find((row) => row.id === String(t.staffId))?.customRoleNames).toEqual(['Accounts clerk']);
    });

    it('assign refusals: unknown or foreign id 422, archived 409, exactly one of systemRole/customRoleId', async () => {
      const t = await h.caller(school, 'teacher');
      const other = await createSchool();
      const otherBoss = await h.caller(other, 'principal');
      const theirs = (await create([], otherBoss.cookie)).body as CustomRole;
      for (const id of ['999999999', theirs.id]) {
        const res = await assign(t.userId, id);
        expect(res.status).toBe(422);
        expect(errorOf(res).details).toMatchObject({ fields: [{ path: 'customRoleId', code: 'REFERENCE_NOT_FOUND' }] });
      }
      const archived = (await create([])).body as CustomRole;
      await archive(archived.id);
      expect(errorOf(await assign(t.userId, archived.id)).code).toBe('CUSTOM_ROLE_ARCHIVED');
      expect((await h.send('post', `/api/v1/users/${t.userId}/roles`, { reason: 'Neither one' }, principal.cookie)).status).toBe(422);
    });

    it('R52: a role held by anyone, a suspended holder included, cannot be archived; archive is idempotent', async () => {
      const role = (await create(['staff.view'])).body as CustomRole;
      const t = await h.caller(school, 'teacher');
      await assign(t.userId, role.id);
      await db.staff.updateMany({ where: { schoolId: school.id, id: t.staffId }, data: { status: 'suspended' } });
      const res = await archive(role.id);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'CUSTOM_ROLE_IN_USE', details: { holderCount: 1 } });
      const free = (await create([])).body as CustomRole;
      expect((await archive(free.id)).body).toMatchObject({ status: 'archived' });
      expect((await archive(free.id)).status).toBe(200);
      expect((await auditFor(free.id)).filter((a) => a.action === 'custom_role.archived')).toHaveLength(1);
      expect(errorOf(await patch(free.id, { name: 'Renamed role' })).code).toBe('CUSTOM_ROLE_ARCHIVED');
    });

    it('R52: an archived role contributes nothing even if a row still names it', async () => {
      const role = (await create(['payroll.view'])).body as CustomRole;
      const t = await h.caller(school, 'teacher');
      await assign(t.userId, role.id);
      // Only reachable by bypassing R96; the computation must still ignore it.
      await db.customRole.updateMany({ where: { schoolId: school.id, id: BigInt(role.id) }, data: { status: 'archived' } });
      expect((await me(t.cookie)).capabilities).not.toContain('payroll.view');
    });

    it('R96: assign and archive queued on one held role lock never leave an archived role with a holder', async () => {
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        for (let i = 0; i < 2; i++) {
          const role = (await create(['staff.view'])).body as CustomRole;
          const t = await createSchoolUser(db, school, { systemRole: 'teacher' });
          // Hold the role row lock, fire both requests into it, and release it only once both wait.
          await pg.query('BEGIN');
          await pg.query('SELECT id FROM custom_roles WHERE school_id = $1 AND id = $2 FOR UPDATE', [school.id, role.id]);
          const racing = Promise.all([assign(t.userId, role.id), archive(role.id)]);
          await waitForBlocked(pg, 2);
          await pg.query('COMMIT');
          const [assigned, archived] = await racing;
          const after = await db.customRole.findFirst({ where: { schoolId: school.id, id: BigInt(role.id) } });
          const holders = await db.userRole.count({ where: { schoolId: school.id, customRoleId: BigInt(role.id), endedAt: null } });
          expect(after?.status === 'archived' && holders > 0).toBe(false);
          if (holders > 0) {
            expect([assigned.status, archived.status]).toEqual([201, 409]);
            expect(errorOf(archived)).toMatchObject({ code: 'CUSTOM_ROLE_IN_USE', details: { holderCount: 1 } });
          } else {
            expect([assigned.status, archived.status]).toEqual([409, 200]);
            expect(errorOf(assigned).code).toBe('CUSTOM_ROLE_ARCHIVED');
          }
        }
      } finally {
        await pg.end();
      }
    });

    it('a duplicate assignment that slips past the in-transaction check gets ROLE_ALREADY_ASSIGNED from the index', async () => {
      const role = (await create(['staff.view'])).body as CustomRole;
      const t = await h.caller(school, 'teacher');
      const first = (await assign(t.userId, role.id)).body as UserRole;
      // The check under the locks misses once, as if the first row were not yet visible.
      const spy = jest.spyOn(UserRoleRepository.prototype, 'findLive').mockResolvedValueOnce(null);
      try {
        const dup = await assign(t.userId, role.id);
        expect(dup.status).toBe(409);
        expect(errorOf(dup)).toMatchObject({ code: 'ROLE_ALREADY_ASSIGNED', details: { userRoleId: first.id } });
      } finally {
        spy.mockRestore();
      }
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: t.userId, customRoleId: BigInt(role.id) } })).toBe(1);
    });

    it('404 for another school’s role on every route; PATCH of key is refused (unknown field)', async () => {
      const other = await createSchool();
      const otherBoss = await h.caller(other, 'principal');
      const theirs = (await create(['staff.view'], otherBoss.cookie)).body as CustomRole;
      expect((await h.get(`/api/v1/custom-roles/${theirs.id}`, principal.cookie)).status).toBe(404);
      expect((await patch(theirs.id, { name: 'Hijacked role' })).status).toBe(404);
      expect((await archive(theirs.id)).status).toBe(404);
      expect((await h.get(`/api/v1/custom-roles?q=${theirs.key}`, principal.cookie)).body).toMatchObject({ total: 0 });
      expect((await db.customRole.findFirst({ where: { schoolId: other.id, id: BigInt(theirs.id) } }))?.name).toBe('Accounts clerk');
      const mine = (await create([])).body as CustomRole;
      expect((await patch(mine.id, { key: 'renamed_key' })).status).toBe(422);
    });
  });

  describe('input and history edges', () => {
    it('A1: null for name, capabilities or reason is 422, never read as absent; nothing changes', async () => {
      const role = (await create(['payment.verify', 'payroll.view'])).body as CustomRole;
      for (const body of [
        { name: null },
        { capabilities: null },
        { capabilities: ['payroll.view'], reason: null },
      ]) {
        const res = await patch(role.id, body);
        expect(res.status).toBe(422);
      }
      expect((await h.get(`/api/v1/custom-roles/${role.id}`, principal.cookie)).body).toMatchObject({
        name: 'Accounts clerk',
        capabilities: ['payroll.view', 'payment.verify'],
      });
    });

    it('A3: a key carrying 13 consecutive digits is 422, not a 500 from the audit CHECK', async () => {
      const res = await create([], principal.cookie, `k${'1234567890123'}`);
      expect(res.status).toBe(422);
      expect(errorOf(res).details).toMatchObject({ fields: [{ path: 'key' }] });
    });

    it('L2: adding keys to a held role needs a reason (it grants them to every holder); an unheld role does not', async () => {
      const role = (await create(['staff.view'])).body as CustomRole;
      expect((await patch(role.id, { capabilities: ['staff.view', 'payroll.view'] })).status).toBe(200);
      const t = await h.caller(school, 'teacher');
      await assign(t.userId, role.id);
      const noReason = await patch(role.id, { capabilities: ['staff.view', 'payroll.view', 'payment.verify'] });
      expect(noReason.status).toBe(422);
      expect(errorOf(noReason).details).toMatchObject({ fields: [{ path: 'reason' }] });
      expect((await me(t.cookie)).capabilities).not.toContain('payment.verify');
      const withReason = await patch(role.id, {
        capabilities: ['staff.view', 'payroll.view', 'payment.verify'],
        reason: 'Holders now verify payments',
      });
      expect(withReason.status).toBe(200);
      expect((await me(t.cookie)).capabilities).toContain('payment.verify');
      // A rename alone needs no reason.
      expect((await patch(role.id, { name: 'Payments desk' })).status).toBe(200);
    });

    it('A6: taking the role lock writes nothing: no-op edit, repeat archive and assignment keep updatedAt', async () => {
      const role = (await create(['staff.view'])).body as CustomRole;
      const updatedAt = async () =>
        ((await h.get(`/api/v1/custom-roles/${role.id}`, principal.cookie)).body as { updatedAt: string }).updatedAt;
      const created = await updatedAt();
      expect((await patch(role.id, { name: 'Accounts clerk', capabilities: ['staff.view'] })).status).toBe(200);
      expect(await updatedAt()).toBe(created);
      const t = await h.caller(school, 'teacher');
      const assigned = (await assign(t.userId, role.id)).body as UserRole;
      expect(await updatedAt()).toBe(created);
      // A real edit moves it.
      expect((await patch(role.id, { name: 'Renamed clerk' })).status).toBe(200);
      const renamed = await updatedAt();
      expect(renamed > created).toBe(true);
      expect(
        (await h.send('post', `/api/v1/user-roles/${assigned.id}/remove`, { reason: 'Desk closed' }, principal.cookie)).status,
      ).toBe(200);
      expect((await archive(role.id)).status).toBe(200);
      const archivedAt = await updatedAt();
      expect((await archive(role.id)).status).toBe(200);
      expect(await updatedAt()).toBe(archivedAt);
    });
  });
});
