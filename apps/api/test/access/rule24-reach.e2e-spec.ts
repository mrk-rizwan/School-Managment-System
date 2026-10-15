// Rule 24's reach (phase-5-extended.md rule 40, §1.1 "Rule 24 reach", R355, R356;
// contracts/slice-46.md): every route DEFAULT_PASSWORD_INERT_ACTIONS names is refused 403
// DEFAULT_PASSWORD_BLOCKS_ACTION for a holder still on the default password and passes the guard
// once the password is changed (read per request); `/me` lists the blocked actions; the
// staff-status and self-assignment overrides read effective holdings, so a default-password
// principal cannot suspend another principal or assign themselves.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  DEFAULT_PASSWORD_INERT_ACTION_NAMES,
  DEFAULT_PASSWORD_INERT_ACTIONS,
  ErrorCode,
  type DefaultPasswordInertAction,
  type SystemRole,
} from '@asms/shared';
import { DEFAULT_PASSWORD_BLOCKED_ACTION } from '../../src/modules/access/permissions.service';
import { createTestApp } from '../core/app';
import { ORIGIN } from '../school-auth/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection } from '../support/students';

const db = () => testDb();

/** Routes a later slice has not built yet (none since slice 43; the R68 suite holds the same list). */
const NOT_YET_BUILT: readonly DefaultPasswordInertAction[] = [];

interface ErrorBody {
  error: { code: string; details: { reason?: string } | null };
}

describe('rule 24 reach: money-out verbs and the audit screen on a default password (R355, R356)', () => {
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
  const call = (method: 'GET' | 'POST' | 'PATCH', path: string, cookie: string) => {
    const url = `/api/v1${path.replace(/:id/g, '999999')}`;
    const req =
      method === 'GET'
        ? http().get(url)
        : (method === 'POST' ? http().post(url) : http().patch(url)).set('Origin', ORIGIN).send({});
    return req.set('Cookie', cookie);
  };
  const codeOf = (res: request.Response) => (res.body as ErrorBody).error?.code;
  /** The rule-24 refusal rows of a user (R225: at most one per school day). */
  const refusalRows = (school: TestSchool, userId: bigint) =>
    db().auditLog.findMany({
      where: { schoolId: school.id, actorUserId: userId, action: DEFAULT_PASSWORD_BLOCKED_ACTION },
      select: { subjectType: true, subjectId: true, metadata: true },
    });

  const routes = Object.entries(DEFAULT_PASSWORD_INERT_ACTIONS).filter(
    ([action]) => !NOT_YET_BUILT.includes(action as DefaultPasswordInertAction),
  );

  it('R355: every inert route refuses a default-password principal, audits once a day, and passes once the password changes', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const { user, session } = await signIn(school, 'principal', true);

    const refused: string[] = [];
    for (const [action, route] of routes) {
      const res = await call(route.method, route.path, session.cookie);
      refused.push(`${action}: ${res.status} ${codeOf(res)}`);
    }
    expect(refused).toEqual(routes.map(([action]) => `${action}: 403 ${ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION}`));
    // One refusal row today, naming the first action refused.
    const rows = await db().auditLog.findMany({
      where: { schoolId: school.id, actorUserId: user.userId, action: DEFAULT_PASSWORD_BLOCKED_ACTION },
      select: { subjectType: true, metadata: true },
    });
    expect(rows).toEqual([{ subjectType: 'user', metadata: { action: routes[0]?.[0] } }]);

    // Read per request: the same session passes the guard at once (each route then answers for
    // itself: the id does not exist, the body is empty, the idempotency key is missing).
    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    const after: string[] = [];
    for (const [action, route] of routes) {
      const res = await call(route.method, route.path, session.cookie);
      if (res.status === 403) after.push(`${action}: ${codeOf(res)}`);
    }
    expect(after).toEqual([]);
  });

  it('R355: the key stays held: an office clerk on the default password still records, but cannot void a charge', async () => {
    const school = await createSchool();
    const { session } = await signIn(school, 'office_staff', true);
    const voided = await call('POST', DEFAULT_PASSWORD_INERT_ACTIONS['charge.void'].path, session.cookie);
    expect([voided.status, codeOf(voided)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    // An unmarked verb of a key the clerk holds still reaches its handler (here a 422 on the empty body).
    const recorded = await call('POST', '/expenses', session.cookie);
    expect(recorded.status).not.toBe(403);
    // A verb whose key the clerk does not hold is PERMISSION_DENIED, never a password hint.
    const approve = await call('POST', DEFAULT_PASSWORD_INERT_ACTIONS['expense.approve'].path, session.cookie);
    expect([approve.status, codeOf(approve)]).toEqual([403, ErrorCode.PERMISSION_DENIED]);
  });

  it('R355: /me lists every blocked action on the default password and none once it is changed', async () => {
    const school = await createSchool();
    const { user, session } = await signIn(school, 'office_staff', true);
    const me = (await http().get('/api/v1/me').set('Cookie', session.cookie).expect(200)).body as { blockedActions: string[] };
    expect(me.blockedActions).toEqual(DEFAULT_PASSWORD_INERT_ACTION_NAMES);
    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    const after = (await http().get('/api/v1/me').set('Cookie', session.cookie).expect(200)).body as { blockedActions: string[] };
    expect(after.blockedActions).toEqual([]);
  });

  it('R356: a default-password principal cannot suspend another principal; after a password change they can', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const { user, session } = await signIn(school, 'principal', true);
    const other = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const suspend = () =>
      http()
        .post(`/api/v1/staff/${other.staffId}/change-status`)
        .set('Cookie', session.cookie)
        .set('Origin', ORIGIN)
        .send({ status: 'suspended', reason: 'Under inquiry' });

    const refused = await suspend();
    expect([refused.status, codeOf(refused)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    // The refusal rolls the status transaction back but is still audited, once a day (R356, R225).
    const again = await suspend();
    expect([again.status, codeOf(again)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    expect(await refusalRows(school, user.userId)).toEqual([
      { subjectType: 'user', subjectId: user.userId, metadata: { capabilities: 'role.manage' } },
    ]);
    expect(await db().staff.findFirst({ where: { schoolId: school.id, id: other.staffId }, select: { status: true } })).toEqual({
      status: 'active',
    });

    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    expect((await suspend()).status).toBe(200);
  });

  it('R356: a default-password principal cannot assign themselves; a clerk can still be marked left (R14 stays nominal)', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const { user, session } = await signIn(school, 'principal', true);
    const send = (path: string, body: object) =>
      http().post(`/api/v1${path}`).set('Cookie', session.cookie).set('Origin', ORIGIN).send(body);

    const { klass, section } = await createClassWithSection(db(), school);
    const self = await send(`/staff/${user.staffId}/teacher-assignments`, {
      role: 'class_teacher',
      classId: klass.id.toString(),
      sectionId: section.id.toString(),
    });
    expect([self.status, codeOf(self)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    // Audited after the rollback, once a day (R356, R225).
    const selfAgain = await send(`/staff/${user.staffId}/teacher-assignments`, {
      role: 'class_teacher',
      classId: klass.id.toString(),
      sectionId: section.id.toString(),
    });
    expect([selfAgain.status, codeOf(selfAgain)]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    expect(await refusalRows(school, user.userId)).toEqual([
      { subjectType: 'user', subjectId: user.userId, metadata: { capabilities: 'role.manage' } },
    ]);

    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    expect((await send(`/staff/${clerk.staffId}/change-status`, { status: 'left', reason: 'Moved to another city' })).status).toBe(200);

    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    const again = await send(`/staff/${user.staffId}/teacher-assignments`, {
      role: 'class_teacher',
      classId: klass.id.toString(),
      sectionId: section.id.toString(),
    });
    expect(again.status).toBe(201);
  });
});
