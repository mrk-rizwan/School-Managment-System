// Tenant isolation of the slice-7 tables (CLAUDE.md control 4, R62): a row written as school A is
// invisible to, and unwritable by, school B. HTTP-level 404s are in the e2e suites.
import { NestExpressApplication } from '@nestjs/platform-express';
import { summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { CapabilityGrantRepository } from '../../src/repositories/capability-grant.repository';
import { CustomRoleRepository } from '../../src/repositories/custom-role.repository';
import { UserRoleRepository } from '../../src/repositories/user-role.repository';
import { createTestApp } from '../core/app';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';

describe('slice-7 repositories are tenant-isolated', () => {
  let app: NestExpressApplication;
  let schools: TwoSchools;
  let bossA: TestSchoolUser;
  let bossB: TestSchoolUser;
  const db = testDb();
  let seq = 0;

  const newRole = async (capabilityKeys: string[] = ['staff.view']) =>
    app.get(CustomRoleRepository).create(schools.a.id, {
      key: `iso_${Date.now().toString(36)}_${seq++}`,
      name: 'Isolated role',
      capabilityKeys,
      addedBy: bossA.userId,
      now: new Date(),
    });

  beforeAll(async () => {
    app = await createTestApp();
    schools = await createTwoSchools();
    bossA = await createSchoolUser(db, schools.a, { systemRole: 'principal' });
    bossB = await createSchoolUser(db, schools.b, { systemRole: 'principal' });
  });

  /** The constraint a write was refused by; fails the test if the write succeeded. */
  const constraintOf = async (write: Promise<unknown>): Promise<string | null | undefined> => {
    const error: unknown = await write.then(
      () => {
        throw new Error('expected the write to be refused');
      },
      (refused: unknown) => refused,
    );
    return summariseDatabaseError(error)?.constraint;
  };

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('custom_roles: read, list, lock and every write', async () => {
    const repo = app.get(CustomRoleRepository);
    const { a, b } = schools;
    await expectIsolated(schools, {
      create: () => newRole(),
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) => (await repo.list(schoolId, { sort: 'name', skip: 0, take: 50 })).rows,
      write: async (schoolId, id) => {
        await repo.markEdited(schoolId, id, { name: 'Hijacked', now: new Date() });
        await repo.archive(schoolId, id);
        return 0;
      },
      snapshot: (row) => [(row as { name: string }).name, (row as { status: string }).status],
    });
    const id = await newRole();
    expect(await repo.lock(b.id, id)).toBeNull();
    const key = (await repo.findById(a.id, id))?.key ?? '';
    expect(await repo.findActiveIdByKey(b.id, key)).toBeNull();
  });

  it('custom_role_capabilities: invisible to and unchangeable by another school', async () => {
    const repo = app.get(CustomRoleRepository);
    const { a, b } = schools;
    await expectIsolated(schools, {
      create: () => newRole(['staff.view', 'payroll.view']),
      read: async (schoolId, id) => {
        const rows = await db.customRoleCapability.findMany({ where: { schoolId, customRoleId: id } });
        return rows.length === 0 ? null : rows;
      },
      write: async (schoolId, id) => {
        await repo.removeCapabilities(schoolId, id, ['staff.view'], bossA.userId, new Date());
        return 0;
      },
      snapshot: (rows) => (rows as { removedAt: Date | null }[]).map((r) => r.removedAt),
    });
    // Adding keys to A's role as B, by B's own principal, is rejected by the composite FK to the role.
    const id = await newRole([]);
    expect(await constraintOf(repo.addCapabilities(b.id, id, ['staff.view'], bossB.userId, new Date()))).toBe(
      'custom_role_capabilities_custom_role_id_fkey',
    );
    expect((await repo.findById(a.id, id))?.capabilityKeys).toEqual([]);
  });

  it('user_capability_grants: read, list, live lookup and every write', async () => {
    const repo = app.get(CapabilityGrantRepository);
    const { a, b } = schools;
    const holder = await createSchoolUser(db, a, { systemRole: 'teacher' });
    await expectIsolated(schools, {
      create: () =>
        repo.create(a.id, {
          userId: holder.userId,
          capabilityKey: `staff.view`,
          effect: seq++ % 2 === 0 ? 'grant' : 'revoke',
          grantedBy: bossA.userId,
          reason: 'Isolation',
          now: new Date(),
        }),
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: (schoolId) => repo.listForUser(schoolId, holder.userId, true),
      write: (schoolId, id) => repo.end(schoolId, id, { revokedBy: bossA.userId, endReason: 'Hijack', now: new Date() }),
      snapshot: (row) => (row as { revokedAt: Date | null }).revokedAt,
    });
    expect(await repo.activeForUser(b.id, holder.userId)).toEqual([]);
    expect(await repo.findLive(b.id, holder.userId, 'staff.view', 'grant')).toBeNull();
    expect(await repo.endAllForUser(b.id, holder.userId, { revokedBy: bossA.userId, endReason: 'Hijack', now: new Date() })).toBe(0);
    expect((await repo.activeForUser(a.id, holder.userId)).length).toBeGreaterThan(0);
    // A grant written as B, by B's own principal, naming A's user is rejected by the composite FK.
    expect(
      await constraintOf(
        repo.create(b.id, {
          userId: holder.userId,
          capabilityKey: 'payroll.view',
          effect: 'grant',
          grantedBy: bossB.userId,
          reason: 'Cross-tenant',
          now: new Date(),
        }),
      ),
    ).toBe('user_capability_grants_user_id_fkey');
  });

  it('user_roles custom-role paths: assignment and live lookups stay in the school', async () => {
    const roles = app.get(UserRoleRepository);
    const customRoles = app.get(CustomRoleRepository);
    const { a, b } = schools;
    const holder = await createSchoolUser(db, a, { systemRole: 'teacher' });
    const roleId = await newRole();
    const role = { kind: 'custom', customRoleId: roleId } as const;
    await roles.assign(a.id, { userId: holder.userId, role, assignedBy: bossA.userId, now: new Date() });
    expect(await roles.findLive(b.id, holder.userId, role)).toBeNull();
    expect(await roles.liveForUser(b.id, holder.userId)).toEqual([]);
    expect(await customRoles.liveForUser(b.id, holder.userId)).toEqual([]);
    expect((await customRoles.liveForUser(a.id, holder.userId)).map((r) => r.customRoleId)).toEqual([roleId]);
    // B cannot attach A's role to anyone, its own users included (B's principal assigning).
    const bUser = await createSchoolUser(db, b, { systemRole: 'teacher' });
    expect(
      await constraintOf(roles.assign(b.id, { userId: bUser.userId, role, assignedBy: bossB.userId, now: new Date() })),
    ).toBe('user_roles_custom_role_id_fkey');
  });
});
