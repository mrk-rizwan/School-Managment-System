// The history guards of the role tables (migration 20261003150000_slice7_history_guards; review
// findings L3, L4, A8), each driven with raw SQL. Every statement runs inside one transaction that
// is rolled back, each behind its own savepoint, so nothing here changes or removes a row even if
// a guard were missing (this file is the one exemption in guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

describe('role-table history guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let school: TestSchool;
  let boss: TestSchoolUser;
  let teacher: TestSchoolUser;
  let activeRole: bigint;
  let archivedRole: bigint;
  let removedKey: bigint;
  let customRow: bigint;
  let endedRow: bigint;
  let grant: bigint;
  let seq = 0;

  /** The constraint a statement is refused by (null when it succeeds), then undone either way. */
  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `guard_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      return (error as DatabaseError).constraint ?? (error as Error).message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  beforeAll(async () => {
    school = await createSchool();
    boss = await createSchoolUser(db, school, { systemRole: 'principal' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const role = (key: string, status: 'active' | 'archived') =>
      db.customRole.create({ data: { schoolId: school.id, key, name: 'Guarded role', status }, select: { id: true } });
    activeRole = (await role(`guard_${Date.now().toString(36)}`, 'active')).id;
    archivedRole = (await role(`guard_old_${Date.now().toString(36)}`, 'archived')).id;
    const now = new Date();
    removedKey = (
      await db.customRoleCapability.create({
        data: {
          schoolId: school.id,
          customRoleId: activeRole,
          capabilityKey: 'staff.view',
          addedBy: boss.userId,
          addedAt: now,
          removedAt: now,
          removedBy: boss.userId,
        },
        select: { id: true },
      })
    ).id;
    customRow = (
      await db.userRole.create({
        data: { schoolId: school.id, userId: teacher.userId, customRoleId: activeRole, assignedBy: boss.userId },
        select: { id: true },
      })
    ).id;
    endedRow = (
      await db.userRole.create({
        data: {
          schoolId: school.id,
          userId: teacher.userId,
          systemRole: 'office_staff',
          assignedBy: boss.userId,
          assignedAt: now,
          endedAt: now,
          endedBy: boss.userId,
        },
        select: { id: true },
      })
    ).id;
    grant = (
      await db.userCapabilityGrant.create({
        data: {
          schoolId: school.id,
          userId: teacher.userId,
          capabilityKey: 'payroll.view',
          effect: 'grant',
          grantedBy: boss.userId,
          reason: 'Guard test',
        },
        select: { id: true },
      })
    ).id;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    // A guard that waited on a lock would hang the suite; fail fast instead.
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
  });

  afterAll(async () => {
    await pg?.query('ROLLBACK');
    await pg?.end();
    await closeTestDb();
  });

  it('custom_roles: no DELETE, no TRUNCATE, archive is final', async () => {
    const s = school.id;
    expect(await refusedBy('DELETE FROM custom_roles WHERE school_id = $1 AND id = $2', [s, activeRole])).toBe(
      'custom_roles_no_delete',
    );
    expect(await refusedBy('TRUNCATE custom_roles CASCADE')).toBe('custom_roles_no_delete');
    expect(
      await refusedBy(`UPDATE custom_roles SET status = 'active' WHERE school_id = $1 AND id = $2`, [s, archivedRole]),
    ).toBe('custom_roles_archive_final');
    // Control: an active role may still be archived and renamed.
    expect(
      await refusedBy(`UPDATE custom_roles SET status = 'archived', name = 'Renamed' WHERE school_id = $1 AND id = $2`, [
        s,
        activeRole,
      ]),
    ).toBeNull();
  });

  it('custom_role_capabilities: no DELETE, no TRUNCATE, removed_at and removed_by frozen once set', async () => {
    const s = school.id;
    expect(
      await refusedBy('DELETE FROM custom_role_capabilities WHERE school_id = $1 AND id = $2', [s, removedKey]),
    ).toBe('custom_role_capabilities_no_delete');
    expect(await refusedBy('TRUNCATE custom_role_capabilities')).toBe('custom_role_capabilities_no_delete');
    expect(
      await refusedBy(
        'UPDATE custom_role_capabilities SET removed_at = NULL, removed_by = NULL WHERE school_id = $1 AND id = $2',
        [s, removedKey],
      ),
    ).toBe('custom_role_capabilities_removed_at_frozen');
    expect(
      await refusedBy('UPDATE custom_role_capabilities SET removed_by = $3 WHERE school_id = $1 AND id = $2', [
        s,
        removedKey,
        teacher.userId,
      ]),
    ).toBe('custom_role_capabilities_removed_by_frozen');
  });

  it('user_roles: user and role frozen, an ended row stays ended, no row on an archived role, assigner required', async () => {
    const s = school.id;
    const update = (set: string, id: bigint, value: unknown) =>
      refusedBy(`UPDATE user_roles SET ${set} = $3 WHERE school_id = $1 AND id = $2`, [s, id, value]);
    expect(await update('user_id', customRow, boss.userId)).toBe('user_roles_user_id_immutable');
    expect(await update('custom_role_id', customRow, archivedRole)).toBe('user_roles_custom_role_id_immutable');
    expect(await update('system_role', teacher.userRoleId, 'principal')).toBe('user_roles_system_role_immutable');
    expect(await update('ended_at', endedRow, null)).toBe('user_roles_ended_at_frozen');
    expect(await update('ended_by', endedRow, teacher.userId)).toBe('user_roles_ended_by_frozen');
    expect(
      await refusedBy(
        'INSERT INTO user_roles (school_id, user_id, custom_role_id, assigned_by) VALUES ($1, $2, $3, $4)',
        [s, boss.userId, archivedRole, boss.userId],
      ),
    ).toBe('user_roles_custom_role_active');
    expect(
      await refusedBy('INSERT INTO user_roles (school_id, user_id, custom_role_id) VALUES ($1, $2, $3)', [
        s,
        boss.userId,
        activeRole,
      ]),
    ).toBe('user_roles_assigned_by_check');
    // Controls: a live row may still be ended once; the platform's principal row has no assigner.
    expect(
      await refusedBy('UPDATE user_roles SET ended_at = now(), ended_by = $3 WHERE school_id = $1 AND id = $2', [
        s,
        customRow,
        boss.userId,
      ]),
    ).toBeNull();
    expect(
      await refusedBy(`INSERT INTO user_roles (school_id, user_id, system_role) VALUES ($1, $2, 'principal')`, [
        s,
        teacher.userId,
      ]),
    ).toBeNull();
  });

  it('user_capability_grants: nobody ends their own row; only "became principal" may end with no ender', async () => {
    const s = school.id;
    const end = (by: bigint | null, reason: string) =>
      refusedBy(
        'UPDATE user_capability_grants SET revoked_at = now(), revoked_by = $3, end_reason = $4 WHERE school_id = $1 AND id = $2',
        [s, grant, by, reason],
      );
    expect(await end(teacher.userId, 'Ending my own')).toBe('user_capability_grants_not_self_end_check');
    expect(await end(null, 'Cover finished')).toBe('user_capability_grants_revoked_check');
    expect(await end(null, 'became principal')).toBeNull();
    expect(await end(boss.userId, 'Cover finished')).toBeNull();
  });
});
