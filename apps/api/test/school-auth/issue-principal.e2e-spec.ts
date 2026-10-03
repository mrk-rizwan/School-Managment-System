// POST /platform/schools/:id/issue-principal-login (contract slice-2 §7): R12 (platform side),
// R21, R22, R56, R57, R77, R103, and the default-password login it enables.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { createSchoolSession, createSchoolUser, randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createStudent, linkGuardian } from '../support/students';
import { createGuardianUser, FakeMailer, nextIp, ORIGIN, sessionCookieOf, setCookies, tokenFrom, uniqueEmail } from './support';

type Issued = { userId: string; staffId: string; fullName: string; linkedExistingUser: boolean };
type ErrorBody = { error: { code: string } };

describe('issue principal login', () => {
  let app: NestExpressApplication;
  let admin: { id: bigint; cookie: string };
  const mailer = new FakeMailer();
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: mailer }] });
    admin = await signedInPlatformAdmin();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const issue = (school: { id: bigint }, body: object, cookie = admin.cookie) =>
    http()
      .post(`/api/v1/platform/schools/${school.id}/issue-principal-login`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(body);
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;
  const person = () => ({ fullName: 'Nadia Principal', cnic: randomIdentityDigits(), phone: '0300 1234567' });

  it('creates staff, user and principal role; the principal logs in with the default password', async () => {
    const school = await createSchool({ status: 'trial' });
    const who = person();
    const dashed = `${who.cnic.slice(0, 5)}-${who.cnic.slice(5, 12)}-${who.cnic.slice(12)}`;
    const res = await issue(school, { ...who, cnic: dashed }).expect(201);
    const body = res.body as Issued;
    expect(body).toMatchObject({ fullName: 'Nadia Principal', linkedExistingUser: false });
    expect(JSON.stringify(body)).not.toMatch(/[0-9]{13}/);
    const staff = await db().staff.findFirst({ where: { schoolId: school.id, id: BigInt(body.staffId) } });
    expect(staff).toMatchObject({ designation: 'Principal', phone: '+923001234567', status: 'active', cnicHash: testIdentityHash(who.cnic) });
    expect(staff?.cnic).toMatch(/^v1:/);
    const role = await db().userRole.findFirst({ where: { schoolId: school.id, userId: BigInt(body.userId) } });
    expect(role).toMatchObject({ systemRole: 'principal', assignedBy: null, endedAt: null });
    // Both logs (R103, R57).
    const schoolAudit = (await db().auditLog.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } })).map((r) => [r.action, r.actorPlatformUserId]);
    expect(schoolAudit).toEqual([
      ['staff.created', admin.id],
      ['user.principal_login_issued', admin.id],
    ]);
    const platformAudit = await db().platformAuditLog.findFirst({ where: { schoolId: school.id, action: 'school.principal_login_issued' } });
    expect(platformAudit?.actorPlatformUserId).toBe(admin.id);
    // The default password is the digits; first login shows the banner flag.
    const login = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
      .send({ schoolCode: school.shortCode, username: who.cnic, password: who.cnic }).expect(200);
    expect((login.body as { passwordIsDefault: boolean; roles: string[] })).toMatchObject({ passwordIsDefault: true, roles: ['principal'] });
  });

  it('R103: refused while an active principal exists unless a reason is given; existing principals are told', async () => {
    const school = await createSchool();
    const email = uniqueEmail();
    await createSchoolUser(db(), school, { systemRole: 'principal', email, emailVerified: true });
    const refused = await issue(school, person()).expect(409);
    expect(codeOf(refused)).toBe('ACTIVE_PRINCIPAL_EXISTS');
    const res = await issue(school, { ...person(), reason: 'Second principal for the senior wing' }).expect(201);
    expect((res.body as Issued).linkedExistingUser).toBe(false);
    const notice = await mailer.next(email);
    expect(notice.text).toContain('Second principal for the senior wing');
    const audit = await db().auditLog.findFirst({ where: { schoolId: school.id, action: 'user.principal_login_issued' } });
    expect(audit?.reason).toBe('Second principal for the senior wing');
  });

  it('R22: links an existing login with the same CNIC (a parent) instead of creating a second user', async () => {
    const school = await createSchool();
    const parent = await createGuardianUser(db(), school);
    const res = await issue(school, { ...person(), cnic: parent.cnic, confirmLinkExisting: true }).expect(201);
    const body = res.body as Issued;
    expect(body).toMatchObject({ userId: parent.userId.toString(), linkedExistingUser: true });
    const user = await db().user.findFirst({ where: { schoolId: school.id, id: parent.userId } });
    expect(user?.staffId?.toString()).toBe(body.staffId);
    expect(user?.guardianId).toBe(parent.guardianId);
    expect(await db().user.count({ where: { schoolId: school.id } })).toBe(1);
  });

  it('linking an existing login needs confirmLinkExisting: true; without it nothing changes', async () => {
    const school = await createSchool();
    const parent = await createGuardianUser(db(), school);
    for (const extra of [{}, { confirmLinkExisting: false }]) {
      const res = await issue(school, { ...person(), cnic: parent.cnic, ...extra }).expect(409);
      expect(codeOf(res)).toBe('LINK_EXISTING_LOGIN_UNCONFIRMED');
    }
    expect(await db().staff.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await db().userRole.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await db().auditLog.count({ where: { schoolId: school.id } })).toBe(0);
    await issue(school, { ...person(), confirmLinkExisting: 'yes' }).expect(422);
  });

  it('wave-A fix 1: a login pre-positioned by the office is reset when it becomes principal', async () => {
    // The exploit: office staff creates a guardian with the future principal's CNIC, issues its
    // login, signs in as it, plants a verified email, a chosen password and a pending reset token.
    const school = await createSchool();
    const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const officeCookie = (await createSchoolSession(db(), school, office)).cookie;
    const asOffice = (path: string, body: object) =>
      http().post(`/api/v1${path}`).set('Cookie', officeCookie).set('Origin', ORIGIN).send(body);
    const anon = (path: string, body: object) =>
      http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp()).send(body);
    const asUser = (path: string, cookie: string, body: object) =>
      http().post(`/api/v1${path}`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

    const who = person();
    const guardian = await asOffice('/guardians', { fullName: 'Planted Parent', cnic: who.cnic, contactCapability: 'whatsapp' }).expect(201);
    // Guardian issue-login needs a live link with can_login (contracts/slice-6.md §9).
    const child = await createStudent(db(), school);
    await linkGuardian(db(), school, child, { id: BigInt((guardian.body as { id: string }).id) }, { canLogin: true });
    await asOffice(`/guardians/${(guardian.body as { id: string }).id}/issue-login`, {}).expect(201);
    const login = await anon('/auth/login', { schoolCode: school.shortCode, username: who.cnic, password: who.cnic }).expect(200);
    const firstCookie = sessionCookieOf(login);
    const email = uniqueEmail();
    await asUser('/me/change-email', firstCookie, { currentPassword: who.cnic, email }).expect(200);
    await anon('/auth/verify-email', { schoolCode: school.shortCode, token: tokenFrom(await mailer.next(email)) }).expect(204);
    const changed = await asUser('/me/change-password', firstCookie, { currentPassword: who.cnic, newPassword: 'planted-pass-1' }).expect(200); // pragma: allowlist secret
    const planted = (setCookies(changed)[0] ?? '').split(';')[0] ?? '';
    await http().get('/api/v1/me').set('Cookie', planted).expect(200);
    const sent = mailer.to(email).length;
    await anon('/auth/forgot-password', { schoolCode: school.shortCode, username: who.cnic }).expect(202);
    const pendingReset = tokenFrom(await mailer.next(email, sent));

    const res = await issue(school, { ...who, confirmLinkExisting: true }).expect(201);
    const body = res.body as Issued;
    expect(body.linkedExistingUser).toBe(true);
    const userId = BigInt(body.userId);

    // The planted session, password, email and token are all gone.
    await http().get('/api/v1/me').set('Cookie', planted).expect(401);
    expect(await db().session.count({ where: { schoolId: school.id, userId, revokedAt: null } })).toBe(0);
    const user = await db().user.findFirst({ where: { schoolId: school.id, id: userId } });
    expect(user).toMatchObject({ email: null, emailVerifiedAt: null, passwordIsDefault: true });
    await anon('/auth/reset-password', { schoolCode: school.shortCode, token: pendingReset, newPassword: 'hijack-pass-1' }).expect(409); // pragma: allowlist secret
    await anon('/auth/login', { schoolCode: school.shortCode, username: who.cnic, password: 'planted-pass-1' }).expect(401); // pragma: allowlist secret
    const fresh = await anon('/auth/login', { schoolCode: school.shortCode, username: who.cnic, password: who.cnic }).expect(200);
    expect(fresh.body as { passwordIsDefault: boolean; roles: string[] }).toMatchObject({
      passwordIsDefault: true,
      roles: ['principal', 'parent'],
    });
    const audit = await db().auditLog.findFirst({ where: { schoolId: school.id, subjectId: userId, action: 'user.reset_on_staff_link' } });
    expect(audit).toMatchObject({ actorPlatformUserId: admin.id, actorUserId: null });
  });

  it('reuses an existing active staff row by CNIC; refuses a suspended one (R21)', async () => {
    const school = await createSchool();
    const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher', fullName: 'Existing Teacher' });
    const res = await issue(school, { ...person(), cnic: teacher.cnic, confirmLinkExisting: true }).expect(201);
    expect(res.body as Issued).toMatchObject({
      userId: teacher.userId.toString(),
      staffId: teacher.staffId.toString(),
      fullName: 'Existing Teacher',
      linkedExistingUser: true,
    });
    const other = await createSchool();
    const suspended = await createSchoolUser(db(), other, { systemRole: 'teacher', staffStatus: 'suspended' });
    expect(codeOf(await issue(other, { ...person(), cnic: suspended.cnic }).expect(409))).toBe('STAFF_NOT_ACTIVE');
  });

  it('refuses a disabled login (USER_DISABLED) and a current principal (ALREADY_PRINCIPAL)', async () => {
    const school = await createSchool();
    const existing = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const again = await issue(school, { ...person(), cnic: existing.cnic, reason: 'Retry after timeout' }).expect(409);
    expect(codeOf(again)).toBe('ALREADY_PRINCIPAL');
    const disabledParent = await createGuardianUser(db(), school, { userStatus: 'disabled' });
    const res = await issue(school, { ...person(), cnic: disabledParent.cnic, reason: 'Disabled one' }).expect(409);
    expect(codeOf(res)).toBe('USER_DISABLED');
  });

  it('refuses to link a student login (USERNAME_IN_USE); nothing is written', async () => {
    const school = await createSchool();
    const digits = randomIdentityDigits();
    const student = await createStudent(db(), school, { bForm: digits });
    await db().user.create({
      data: {
        schoolId: school.id,
        usernameHash: testIdentityHash(digits),
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g', // pragma: allowlist secret
        studentId: student.id,
      },
    });
    const res = await issue(school, { ...person(), cnic: digits, confirmLinkExisting: true }).expect(409);
    expect(codeOf(res)).toBe('USERNAME_IN_USE');
    expect(await db().staff.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await db().userRole.count({ where: { schoolId: school.id } })).toBe(0);
  });

  it('R77: two racing issues for one person create one user; the loser gets a refusal, not 500', async () => {
    const school = await createSchool();
    const who = person();
    const [a, b] = await Promise.all([issue(school, who), issue(school, who)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db().user.count({ where: { schoolId: school.id } })).toBe(1);
    expect(await db().staff.count({ where: { schoolId: school.id } })).toBe(1);
  });

  it('404 for an absent school, 409 SCHOOL_TERMINATED for a terminated one', async () => {
    await issue({ id: 999_999_999_999n }, person()).expect(404);
    const school = await createSchool({ status: 'terminated' });
    expect(codeOf(await issue(school, person()).expect(409))).toBe('SCHOOL_TERMINATED');
  });

  it('422 on bad input, never echoing the CNIC', async () => {
    const school = await createSchool();
    for (const body of [
      { ...person(), cnic: '12345' },
      { ...person(), phone: '12' },
      { ...person(), fullName: 'x' },
      { ...person(), reason: 'id 35202-1234567-1' },
      { ...person(), schoolId: '1' },
    ]) {
      const res = await issue(school, body).expect(422);
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9]{13}/);
    }
  });

  it('R56: a school session cannot call it; a missing platform session is 401', async () => {
    const school = await createSchool();
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const s = await createSchoolSession(db(), school, principal);
    await issue(school, person(), s.cookie).expect(401);
    await http().post(`/api/v1/platform/schools/${school.id}/issue-principal-login`).set('Origin', ORIGIN).send(person()).expect(401);
  });
});

