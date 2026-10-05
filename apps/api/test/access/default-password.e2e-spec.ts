// R225, rule 24 (phase-3-financial.md slice 18): role.manage and user.account.manage are inert while
// the holder signs in with the default password, read per request; /me lists them as blocked;
// everything else works; the refusal is audited once per user per day.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, type SystemRole } from '@asms/shared';
import {
  DEFAULT_PASSWORD_BLOCKED_ACTION,
  PermissionsService,
} from '../../src/modules/access/permissions.service';
import { createTestApp } from '../core/app';
import { asSchool, tx } from '../messaging/support';
import { ORIGIN } from '../school-auth/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection } from '../support/students';

const db = () => testDb();

interface Me {
  capabilities: string[];
  blockedCapabilities: string[];
  capabilityScopes: { capability: string }[];
}

describe('rule 24: privileged capabilities on a default password (R225)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const signIn = async (school: TestSchool, systemRole: SystemRole, defaultPassword: boolean) => {
    const user = await createSchoolUser(db(), school, { systemRole, ...(defaultPassword ? { defaultPassword } : {}) });
    return { user, session: await createSchoolSession(db(), school, user) };
  };
  const get = (path: string, cookie: string) => http().get(`/api/v1${path}`).set('Cookie', cookie);
  const code = (res: request.Response) => (res.body as { error: { code: string } }).error.code;
  const refusals = (schoolId: bigint, userId: bigint) =>
    db().auditLog.findMany({ where: { schoolId, actorUserId: userId, action: DEFAULT_PASSWORD_BLOCKED_ACTION } });

  it('R225: a principal on the default password is refused the two capabilities, keeps the rest, and is audited once a day', async () => {
    const school = await createSchool();
    const { user, session } = await signIn(school, 'principal', true);

    const users = await get('/users', session.cookie);
    expect([users.status, code(users)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    const roles = await http()
      .post('/api/v1/custom-roles')
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .send({ key: 'bursar', name: 'Bursar', capabilities: [] });
    expect([roles.status, code(roles)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    // Everything else works.
    await get('/students', session.cookie).expect(200);
    await get('/fee-heads', session.cookie).expect(200);

    const me = (await get('/me', session.cookie).expect(200)).body as Me;
    expect(me.blockedCapabilities).toEqual([Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE]);
    expect(me.capabilities).not.toContain(Capability.USER_ACCOUNT_MANAGE);
    expect(me.capabilities).not.toContain(Capability.ROLE_MANAGE);
    expect(me.capabilityScopes.map((s) => s.capability)).toEqual(me.capabilities);

    // Two refusals today, one audit row naming the user and the blocked keys.
    const rows = await refusals(school.id, user.userId);
    expect(rows.map((r) => [r.subjectType, r.subjectId, r.metadata])).toEqual([
      ['user', user.userId, { capabilities: 'user.account.manage' }],
    ]);

    // Read per request: once the password is changed the capabilities work at once.
    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    await get('/users', session.cookie).expect(200);
    const after = (await get('/me', session.cookie).expect(200)).body as Me;
    expect(after.blockedCapabilities).toEqual([]);
    expect(after.capabilities).toEqual(expect.arrayContaining([Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE]));
  });

  it('R225: office staff on the default password lose user.account.manage; a teacher, who never held it, gets the plain refusal', async () => {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff', true);
    const blocked = await get('/users', office.session.cookie);
    expect([blocked.status, code(blocked)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    // An any-of route the caller holds only through a blocked key is refused the same way.
    const anyOf = await get('/custom-roles', office.session.cookie);
    expect([anyOf.status, code(anyOf)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    await get('/students', office.session.cookie).expect(200);
    expect((await refusals(school.id, office.user.userId)).length).toBe(1);

    const teacher = await signIn(school, 'teacher', true);
    const plain = await get('/users', teacher.session.cookie);
    expect([plain.status, code(plain)]).toEqual([403, ErrorCode.PERMISSION_DENIED]);
    expect(((await get('/me', teacher.session.cookie).expect(200)).body as Me).blockedCapabilities).toEqual([]);
    expect(await refusals(school.id, teacher.user.userId)).toEqual([]);
  });

  it('R225: everything else works: a default-password principal marks a clerk left, assigns themselves class teacher, sets up a fee head', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const { user, session } = await signIn(school, 'principal', true);
    const send = (path: string, body: object) =>
      http().post(`/api/v1${path}`).set('Cookie', session.cookie).set('Origin', ORIGIN).send(body);

    // staff-status overrides through role.manage and the R14 subset rule (both read nominally).
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const left = await send(`/staff/${clerk.staffId}/change-status`, { status: 'left', reason: 'Moved to another city' });
    expect(left.status).toBe(200);

    // R74's self-assignment override: only a role.manage holder may assign themselves.
    const { klass: cls, section } = await createClassWithSection(db(), school);
    const assigned = await send(`/staff/${user.staffId}/teacher-assignments`, {
      role: 'class_teacher',
      classId: cls.id.toString(),
      sectionId: section.id.toString(),
    });
    expect(assigned.status).toBe(201);

    // A slice-18 write.
    await send('/fee-heads', { name: 'Transport', category: 'other', frequency: 'monthly' }).expect(201);
    // And none of these wrote a refusal row.
    expect(await refusals(school.id, user.userId)).toEqual([]);
  });

  it('R253: assigning a second principal waits behind the sole-principal read under the settings lock', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const { user, session } = await signIn(school, 'principal', false);
    const target = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const permissions = app.get(PermissionsService);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (_sole: boolean): void => undefined;
    const lockTaken = new Promise<boolean>((resolve) => {
      locked = resolve;
    });
    // A decision taken as the sole principal: the settings lock is held until the gate opens.
    const decision = asSchool(app, school.id, () =>
      tx.run(async () => {
        locked(await permissions.isSolePrincipal(school.id, user.userId));
        await gate;
      }),
    );
    expect(await lockTaken).toBe(true);

    let settled = false;
    const assign = http()
      .post(`/api/v1/users/${target.userId}/roles`)
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .send({ systemRole: 'principal', reason: 'A second principal' })
      .then((res) => {
        settled = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(settled).toBe(false);
    expect(await db().userRole.count({ where: { schoolId: school.id, userId: target.userId, systemRole: 'principal' } })).toBe(0);

    release();
    await decision;
    expect((await assign).status).toBe(201);
    expect(await asSchool(app, school.id, () => tx.run(() => permissions.isSolePrincipal(school.id, user.userId)))).toBe(false);
  });

  it('R225: a changed password blocks nothing', async () => {
    const school = await createSchool();
    const { session } = await signIn(school, 'principal', false);
    await get('/users', session.cookie).expect(200);
    expect(((await get('/me', session.cookie).expect(200)).body as Me).blockedCapabilities).toEqual([]);
  });
});
