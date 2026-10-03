// R57: every grant, revoke, role change, office reset, disable, enable, issue-login and status
// change writes an audit row naming the actor, the target and the reason. One table-driven case
// per action, each over the real API, each asserting exactly one new row for that target. The
// route-level guard that every mutating route is classified for audit is in
// test/core/routes.e2e-spec.ts.
import request from 'supertest';
import { LOGIN_ISSUED_REASONS } from '@asms/shared';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { signedInPlatformAdmin } from '../support/platform';
import { randomIdentityDigits } from '../support/school-session';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import { setStudentLogin } from '../students/support';
import { ORIGIN, StaffHarness, type Caller } from '../staff/support';

interface Expected {
  status: number;
  action: string;
  subjectType: string;
  subjectId: bigint;
  /** The reason as stored (trimmed). */
  reason: string;
}

describe('R57: audit rows for account, permission and status changes (e2e)', () => {
  const h = new StaffHarness();
  const db = testDb();
  let school: TestSchool;
  let principal: Caller;

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    principal = await h.caller(school, 'principal', 'Head Teacher');
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const post = (path: string, body: object) =>
    h.send('post', `/api/v1${path}`, body, principal.cookie);
  const idOf = (res: { body: unknown }) => BigInt((res.body as { id: string }).id);
  const auditRows = (e: Pick<Expected, 'action' | 'subjectType' | 'subjectId'>) =>
    db.auditLog.findMany({
      where: {
        schoolId: school.id,
        action: e.action,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
      },
    });

  const cases: [string, () => Promise<[request.Response, Expected]>][] = [
    [
      'a grant',
      async () => {
        const target = await h.caller(school, 'office_staff');
        const res = await post(`/users/${target.userId}/grants`, {
          capability: 'payment.verify',
          effect: 'grant',
          reason: 'Covering the desk',
        });
        return [res, { status: 201, action: 'capability_grant.created', subjectType: 'user', subjectId: target.userId, reason: 'Covering the desk' }];
      },
    ],
    [
      'a revoke',
      async () => {
        const target = await h.caller(school, 'office_staff');
        const res = await post(`/users/${target.userId}/grants`, {
          capability: 'payment.record',
          effect: 'revoke',
          reason: 'Not on the cash desk',
        });
        return [res, { status: 201, action: 'capability_grant.created', subjectType: 'user', subjectId: target.userId, reason: 'Not on the cash desk' }];
      },
    ],
    [
      'ending a grant',
      async () => {
        const target = await h.caller(school, 'office_staff');
        const grant = await post(`/users/${target.userId}/grants`, {
          capability: 'payment.verify',
          effect: 'grant',
          reason: 'Covering the desk',
        });
        const res = await post(`/grants/${idOf(grant)}/end`, { reason: 'Cover finished' });
        return [res, { status: 200, action: 'capability_grant.ended', subjectType: 'user', subjectId: target.userId, reason: 'Cover finished' }];
      },
    ],
    [
      'assigning a role',
      async () => {
        const target = await h.caller(school, 'teacher');
        const res = await post(`/users/${target.userId}/roles`, {
          systemRole: 'office_staff',
          reason: '  Helps at the front desk  ',
        });
        return [res, { status: 201, action: 'user_role.assigned', subjectType: 'user', subjectId: target.userId, reason: 'Helps at the front desk' }];
      },
    ],
    [
      'removing a role',
      async () => {
        const target = await h.caller(school, 'teacher');
        const role = await post(`/users/${target.userId}/roles`, {
          systemRole: 'office_staff',
          reason: 'Helps at the front desk',
        });
        const res = await post(`/user-roles/${idOf(role)}/remove`, { reason: 'Desk duty ended' });
        return [res, { status: 200, action: 'user_role.removed', subjectType: 'user', subjectId: target.userId, reason: 'Desk duty ended' }];
      },
    ],
    [
      'an office reset',
      async () => {
        const target = await h.caller(school, 'teacher');
        const res = await post(`/users/${target.userId}/reset-password`, {
          reason: 'Forgot it',
          clearEmail: false,
        });
        return [res, { status: 200, action: 'user.office_reset', subjectType: 'user', subjectId: target.userId, reason: 'Forgot it' }];
      },
    ],
    [
      'a disable',
      async () => {
        const target = await h.caller(school, 'teacher');
        const res = await post(`/users/${target.userId}/disable`, { reason: 'On long leave' });
        return [res, { status: 200, action: 'user.disabled', subjectType: 'user', subjectId: target.userId, reason: 'On long leave' }];
      },
    ],
    [
      'an enable',
      async () => {
        const target = await h.caller(school, 'teacher');
        await post(`/users/${target.userId}/disable`, { reason: 'On long leave' });
        const res = await post(`/users/${target.userId}/enable`, { reason: 'Back from leave' });
        return [res, { status: 200, action: 'user.enabled', subjectType: 'user', subjectId: target.userId, reason: 'Back from leave' }];
      },
    ],
    [
      'a staff status change',
      async () => {
        const target = await h.caller(school, 'teacher');
        const res = await post(`/staff/${target.staffId}/change-status`, {
          status: 'suspended',
          reason: 'Inquiry pending',
        });
        return [res, { status: 200, action: 'staff.status_changed', subjectType: 'staff', subjectId: target.staffId, reason: 'Inquiry pending' }];
      },
    ],
    [
      'a student status change',
      async () => {
        const { section } = await createClassWithSection(db, school);
        const student = await createStudent(db, school);
        await enrol(db, school, student, section);
        const res = await post(`/students/${student.id}/change-status`, {
          status: 'suspended',
          reason: 'Fee dispute',
          effectiveOn: isoDay(),
        });
        return [res, { status: 200, action: 'student.status_changed', subjectType: 'student', subjectId: student.id, reason: 'Fee dispute' }];
      },
    ],
  ];

  it.each(cases)('R57: %s writes one audit row with actor, target and reason', async (_name, act) => {
    const [res, expected] = await act();
    expect(res.status).toBe(expected.status);
    const rows = await auditRows(expected);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: principal.userId,
      actorPlatformUserId: null,
      subjectType: expected.subjectType,
      subjectId: expected.subjectId,
      reason: expected.reason,
    });
  });

  /**
   * The three school issue-login endpoints; each answers 201 with the new user. `extra` is merged
   * into the body (an optional reason); the third element is the reason recorded without one.
   */
  const issueLogins: [string, (extra: object) => Promise<request.Response>, string][] = [
    [
      'staff',
      async (extra) => {
        const staff = await post('/staff', {
          fullName: 'Rabia Khan',
          phone: '03001234567',
          cnic: randomIdentityDigits(),
        });
        return post(`/staff/${idOf(staff)}/issue-login`, { systemRole: 'teacher', ...extra });
      },
      LOGIN_ISSUED_REASONS.staff,
    ],
    [
      'guardian',
      async (extra) => {
        // A login is offered only through a live link that allows one.
        const guardian = await createGuardian(db, school);
        await linkGuardian(db, school, await createStudent(db, school), guardian, { canLogin: true });
        return post(`/guardians/${guardian.id}/issue-login`, extra);
      },
      LOGIN_ISSUED_REASONS.guardian,
    ],
    [
      'student',
      async (extra) => {
        await setStudentLogin(school, true);
        const { section } = await createClassWithSection(db, school);
        const student = await createStudent(db, school);
        await enrol(db, school, student, section);
        await linkGuardian(db, school, student, await createGuardian(db, school));
        return post(`/students/${student.id}/issue-login`, extra);
      },
      LOGIN_ISSUED_REASONS.student,
    ],
  ];

  const loginIssuedRows = (res: request.Response) =>
    auditRows({ action: 'user.login_issued', subjectType: 'user', subjectId: idOf(res) });

  it.each(issueLogins)('R57: a %s issue-login writes one audit row with actor and target', async (_kind, act) => {
    const res = await act({});
    expect(res.status).toBe(201);
    const rows = await loginIssuedRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(principal.userId);
  });

  // The reason is optional in the body; without one the row records where the login was issued.
  it.each(issueLogins)('R57: a %s issue-login audit row carries a reason', async (_kind, act, fallback) => {
    const res = await act({});
    expect(res.status).toBe(201);
    const rows = await loginIssuedRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toEqual(expect.any(String));
    expect(rows[0]?.reason).toBe(fallback);
  });

  it.each(issueLogins)('R57: a %s issue-login stores a supplied reason verbatim', async (_kind, act) => {
    const reason = 'Requested by the family at the front desk';
    const res = await act({ reason });
    expect(res.status).toBe(201);
    const rows = await loginIssuedRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe(reason);
  });

  it.each(issueLogins)('R57: a %s issue-login refuses a reason holding an identity number', async (_kind, act) => {
    const res = await act({ reason: `Asked by ${randomIdentityDigits()}` });
    expect(res.status).toBe(422);
  });

  it('R57: a platform school status change writes one platform audit row with actor, target and reason', async () => {
    const admin = await signedInPlatformAdmin();
    const target = await createSchool();
    const res = await request(h.app.getHttpServer())
      .post(`/api/v1/platform/schools/${target.id}/change-status`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .send({ status: 'suspended', reason: 'Invoice unpaid' });
    expect(res.status).toBe(200);
    const rows = await db.platformAuditLog.findMany({
      where: { schoolId: target.id, action: 'school.status_changed' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorPlatformUserId: admin.id,
      subjectId: target.id,
      reason: 'Invoice unpaid',
    });
  });
});
