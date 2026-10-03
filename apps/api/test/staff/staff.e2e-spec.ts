// /api/v1/staff end to end (contracts/slice-4.md §3) over the real AppModule, the real access
// guard and the real database: create, read, list, edit, status change and issue-login.
// Rules: R12-R14, R16-R22, R24, R57, R59, R70, R72-R74, R77.
import request from 'supertest';
import { Capability } from '@asms/shared';
import { PasswordHasher } from '../../src/common/crypto/password';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { StaffStatusService } from '../../src/modules/people/staff/staff-status.service';
import { StaffRepository } from '../../src/repositories/staff.repository';
import { UserRepository } from '../../src/repositories/user.repository';
import { createGuardianUser, nextIp } from '../school-auth/support';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
  testIdentityHash,
} from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createStudent,
  createSubject,
  createTeacherAssignment,
  day,
} from '../support/students';
import {
  dashed,
  errorOf,
  ID,
  masked,
  ORIGIN,
  schoolDay,
  StaffHarness,
  type Caller,
} from './support';

const BASE = '/api/v1/staff';

interface Staff {
  id: string;
  fullName: string;
  cnicMasked: string | null;
  hasCnic: boolean;
  phone: string;
  designation: string | null;
  joinedOn: string | null;
  status: string;
  userId: string | null;
  systemRoles: string[];
}
interface User {
  id: string;
  staffId: string | null;
  guardianId: string | null;
  systemRoles: string[];
  passwordIsDefault: boolean;
  hasEmail: boolean;
  status: string;
}

describe('staff (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let office: Caller;
  /** Every CNIC sent in this suite: none may appear in a response or a log line (R16). */
  const sentDigits: string[] = [];

  const digits = (): string => {
    const d = randomIdentityDigits();
    sentDigits.push(d);
    return d;
  };
  const post = (path: string, body: object, cookie = principal.cookie) =>
    h.send('post', path, body, cookie);
  const patch = (path: string, body: object, cookie = principal.cookie) =>
    h.send('patch', path, body, cookie);
  const get = (path: string, cookie = principal.cookie) => h.get(path, cookie);

  async function createStaff(body: Record<string, unknown> = {}, cookie = principal.cookie) {
    const res = await post(
      BASE,
      { fullName: 'Ayesha Malik', phone: '03001234567', cnic: digits(), ...body },
      cookie,
    );
    expect(res.status).toBe(201);
    return res.body as Staff;
  }
  const issueLogin = (id: string, body: object = { systemRole: 'teacher' }, cookie = principal.cookie) =>
    post(`${BASE}/${id}/issue-login`, body, cookie);
  const changeStatus = (id: string, status: string, cookie = principal.cookie) =>
    post(`${BASE}/${id}/change-status`, { status, reason: 'Recorded by the office' }, cookie);
  const auditFor = (schoolId: bigint, subjectType: string, subjectId: string | bigint) =>
    db.auditLog.findMany({
      where: { schoolId, subjectType, subjectId: BigInt(subjectId) },
      orderBy: { id: 'asc' },
    });
  const liveSessions = (schoolId: bigint, userId: bigint) =>
    db.session.count({ where: { schoolId, userId, revokedAt: null } });

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    principal = await h.caller(school, 'principal');
    office = await h.caller(school, 'office_staff');
  });

  // A fresh principal per test: CNIC writes spend the per-user identity-probe budget.
  beforeEach(async () => {
    principal = await h.caller(school, 'principal');
  });

  it('create and patch with a CNIC spend the identity-probe budget; a patch without one does not', async () => {
    const target = await createStaff();
    for (let i = 0; i < 14; i++) await createStaff();
    for (let i = 0; i < 15; i++) {
      expect((await patch(`${BASE}/${target.id}`, { cnic: digits() })).status).toBe(200);
    }
    const created = await post(BASE, { fullName: 'Ayesha Malik', phone: '03001234567', cnic: digits() });
    expect(created.status).toBe(429);
    expect((created.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect((await patch(`${BASE}/${target.id}`, { cnic: digits() })).status).toBe(429);
    expect((await patch(`${BASE}/${target.id}`, { fullName: 'Ayesha Noor' })).status).toBe(200);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  describe('access (contract §1)', () => {
    it('401 without a session; 403 for a teacher; office may read but not write', async () => {
      expect((await request(h.app.getHttpServer()).get(BASE)).status).toBe(401);
      const teacher = await h.caller(school, 'teacher');
      expect(errorOf(await get(BASE, teacher.cookie)).code).toBe('PERMISSION_DENIED');
      expect((await get(BASE, office.cookie)).status).toBe(200);
      const staff = await createStaff();
      expect((await get(`${BASE}/${staff.id}`, office.cookie)).status).toBe(200);
      for (const res of [
        await post(BASE, { fullName: 'X Y', phone: '03001234567' }, office.cookie),
        await patch(`${BASE}/${staff.id}`, { fullName: 'Changed' }, office.cookie),
        await changeStatus(staff.id, 'suspended', office.cookie),
        await issueLogin(staff.id, { systemRole: 'teacher' }, teacher.cookie),
      ]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('PERMISSION_DENIED');
      }
    });

    it('404s an absent, malformed or other school id on every staff route', async () => {
      const other = await createSchool();
      const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
      for (const id of [String(theirs.staffId), '999999999999', 'abc', '0']) {
        expect((await get(`${BASE}/${id}`)).status).toBe(404);
        expect((await patch(`${BASE}/${id}`, { fullName: 'Hijack' })).status).toBe(404);
        expect((await changeStatus(id, 'suspended')).status).toBe(404);
        expect((await issueLogin(id)).status).toBe(404);
      }
      const row = await db.staff.findFirst({ where: { schoolId: other.id, id: theirs.staffId } });
      expect(row?.status).toBe('active');
      expect(row?.fullName).not.toBe('Hijack');
    });
  });

  describe('POST /staff', () => {
    it('normalises input, stores the CNIC encrypted and returns it masked', async () => {
      const d = digits();
      const res = await post(BASE, {
        fullName: '  Ayesha   Malik ',
        cnic: dashed(d),
        phone: '0300-123 4567',
        designation: ' Senior  Teacher ',
        joinedOn: schoolDay(-30),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(ID),
        fullName: 'Ayesha Malik',
        cnicMasked: masked(d),
        hasCnic: true,
        phone: '+923001234567',
        designation: 'Senior Teacher',
        joinedOn: schoolDay(-30),
        status: 'active',
        userId: null,
        systemRoles: [],
        customRoleNames: [],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const stored = await db.staff.findFirst({
        where: { schoolId: school.id, id: BigInt((res.body as Staff).id) },
      });
      expect(stored?.cnic).toMatch(/^v1:/);
      expect(stored?.cnic).not.toContain(d);
      expect(stored?.cnicHash).toBe(testIdentityHash(d));
      const audit = await auditFor(school.id, 'staff', (res.body as Staff).id);
      expect(audit.map((a) => [a.action, a.metadata, a.actorUserId])).toEqual([
        ['staff.created', { hasCnic: true }, principal.userId],
      ]);
    });

    it('accepts no CNIC (null or absent)', async () => {
      const a = await createStaff({ cnic: null });
      const b = (await post(BASE, { fullName: 'No Cnic', phone: '03001112222' })).body as Staff;
      for (const s of [a, b]) expect(s).toMatchObject({ cnicMasked: null, hasCnic: false });
      expect((await auditFor(school.id, 'staff', a.id))[0]?.metadata).toEqual({ hasCnic: false });
    });

    it('R20: a CNIC already on a staff row of any status is refused with a pointer to it', async () => {
      const d = digits();
      const first = await createStaff({ cnic: d });
      const again = await post(BASE, { fullName: 'Someone Else', phone: '03001234567', cnic: dashed(d) });
      expect(again.status).toBe(409);
      expect(errorOf(again)).toMatchObject({ code: 'STAFF_CNIC_EXISTS', details: { staffId: first.id } });
      await db.staff.updateMany({
        where: { schoolId: school.id, id: BigInt(first.id) },
        data: { status: 'left', leftOn: day(schoolDay()) },
      });
      const afterLeft = await post(BASE, { fullName: 'Someone Else', phone: '03001234567', cnic: d });
      expect(errorOf(afterLeft)).toMatchObject({ code: 'STAFF_CNIC_EXISTS', details: { staffId: first.id } });
      // Another school is another tenant: the same digits are free there.
      const other = await createSchool();
      const theirs = await h.caller(other, 'principal');
      expect((await post(BASE, { fullName: 'Other', phone: '03001234567', cnic: d }, theirs.cookie)).status).toBe(201);
    });

    it('R20: of two racing creates with one CNIC, the loser gets the same pointer, never a 500', async () => {
      const d = digits();
      const body = { fullName: 'Racing Twin', phone: '03001234567', cnic: d };
      const results = await Promise.all([post(BASE, body), post(BASE, body), post(BASE, body)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      const winner = results.find((r) => r.status === 201)?.body as Staff;
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(errorOf(loser)).toMatchObject({ code: 'STAFF_CNIC_EXISTS', details: { staffId: winner.id } });
      }
      expect(await db.staff.count({ where: { schoolId: school.id, cnicHash: testIdentityHash(d) } })).toBe(1);
    });

    it('422 on shape: joinedOn more than 366 days ahead, a bad phone or date, unknown fields', async () => {
      expect((await createStaff({ joinedOn: schoolDay(366) })).joinedOn).toBe(schoolDay(366));
      const cases: [object, string][] = [
        [{ joinedOn: schoolDay(367) }, 'joinedOn'],
        [{ joinedOn: '2026-02-30' }, 'joinedOn'],
        [{ phone: '12' }, 'phone'],
        [{ fullName: 'A' }, 'fullName'],
        [{ cnic: '12345' }, 'cnic'],
        [{ designation: '' }, 'designation'],
        [{ schoolId: '1' }, 'schoolId'],
      ];
      for (const [body, path] of cases) {
        const res = await post(BASE, { fullName: 'Valid Name', phone: '03001234567', ...body });
        expect(res.status).toBe(422);
        expect(errorOf(res).details).toMatchObject({ fields: [expect.objectContaining({ path })] });
      }
    });
  });

  describe('GET /staff', () => {
    it('filters by status, role, login, CNIC and search; sorts; masks', async () => {
      const s = await createSchool();
      const boss = await h.caller(s, 'principal', 'Principal Person');
      const make = async (body: Record<string, unknown>) => {
        const res = await post(BASE, { phone: '03001234567', cnic: digits(), ...body }, boss.cookie);
        expect(res.status).toBe(201);
        return res.body as Staff;
      };
      const zara = await make({ fullName: 'Zara Khan', designation: 'Science Teacher' });
      await make({ fullName: 'Adam Shah', cnic: null, phone: '03215550123' });
      const bilal = await make({ fullName: 'Bilal Ahmed', joinedOn: schoolDay(-400) });
      expect((await issueLogin(zara.id, { systemRole: 'teacher' }, boss.cookie)).status).toBe(201);
      expect((await changeStatus(bilal.id, 'left', boss.cookie)).status).toBe(200);
      const names = async (query: string) => {
        const res = await get(`${BASE}?${query}`, boss.cookie);
        expect(res.status).toBe(200);
        return (res.body as { data: Staff[] }).data.map((r) => r.fullName);
      };
      expect(await names('')).toEqual(['Adam Shah', 'Bilal Ahmed', 'Principal Person', 'Zara Khan']);
      expect(await names('sort=-fullName')).toEqual(['Zara Khan', 'Principal Person', 'Bilal Ahmed', 'Adam Shah']);
      expect(await names('status=active')).toEqual(['Adam Shah', 'Principal Person', 'Zara Khan']);
      expect(await names('status=left')).toEqual(['Bilal Ahmed']);
      expect(await names('role=teacher')).toEqual(['Zara Khan']);
      expect(await names('role=principal')).toEqual(['Principal Person']);
      expect(await names('hasLogin=true')).toEqual(['Principal Person', 'Zara Khan']);
      expect(await names('hasLogin=false')).toEqual(['Adam Shah', 'Bilal Ahmed']);
      expect(await names('hasCnic=false')).toEqual(['Adam Shah']);
      expect(await names('q=khan')).toEqual(['Zara Khan']);
      expect(await names('q=science')).toEqual(['Zara Khan']);
      expect(await names('q=0321-555')).toEqual(['Adam Shah']);
      expect(await names('q=%25%25')).toEqual([]);
      expect(await names('sort=joinedOn&status=left')).toEqual(['Bilal Ahmed']);
      const page = await get(`${BASE}?limit=2&page=2`, boss.cookie);
      expect(page.body).toMatchObject({ page: 2, limit: 2, total: 4 });

      const row = (await get(`${BASE}?role=teacher`, boss.cookie)).body as { data: Staff[] };
      expect(row.data[0]).toMatchObject({ systemRoles: ['teacher'], userId: expect.stringMatching(ID) });
      expect(row.data[0]?.cnicMasked).toMatch(/^\d{5}-\*{5}-\d$/);
      expect((await get(`${BASE}?status=left`, boss.cookie)).body).toMatchObject({
        data: [{ systemRoles: [], status: 'left' }],
      });

      for (const query of [`q=${randomIdentityDigits()}`, 'q=35201-1234567-1', 'q=35201%201234567%201', 'role=parent', 'status=gone', 'hasLogin=yes', 'sort=phone']) {
        const res = await get(`${BASE}?${query}`, boss.cookie);
        expect(res.status).toBe(422);
      }
    });
  });

  describe('PATCH /staff/:id', () => {
    it('absent is unchanged, null clears; fullName and phone cannot be cleared; audits changes', async () => {
      const staff = await createStaff({ designation: 'Clerk', joinedOn: schoolDay(-10) });
      for (const body of [{ fullName: null }, { phone: null }, { joinedOn: 'soon' }]) {
        expect((await patch(`${BASE}/${staff.id}`, body)).status).toBe(422);
      }
      const res = await patch(`${BASE}/${staff.id}`, {
        designation: null,
        joinedOn: null,
        phone: '+923331234567',
        fullName: 'Ayesha  Khan',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        fullName: 'Ayesha Khan',
        designation: null,
        joinedOn: null,
        phone: '+923331234567',
        cnicMasked: staff.cnicMasked,
      });
      // Nothing changing is no write and no audit row.
      expect((await patch(`${BASE}/${staff.id}`, { fullName: 'Ayesha Khan' })).status).toBe(200);
      const audit = await auditFor(school.id, 'staff', staff.id);
      expect(audit.map((a) => a.action)).toEqual(['staff.created', 'staff.updated']);
      expect(audit[1]?.metadata).toEqual({
        changes: {
          fullName: { from: 'Ayesha Malik', to: 'Ayesha Khan' },
          phone: { changed: true },
          designation: { from: 'Clerk', to: null },
          joinedOn: { from: schoolDay(-10), to: null },
        },
      });
    });

    it('sets, changes and clears the CNIC while there is no login; never onto another staff row', async () => {
      const staff = await createStaff({ cnic: null });
      const d = digits();
      const set = await patch(`${BASE}/${staff.id}`, { cnic: dashed(d) });
      expect(set.body).toMatchObject({ cnicMasked: masked(d), hasCnic: true });
      const taken = await createStaff();
      const clash = await patch(`${BASE}/${taken.id}`, { cnic: d });
      expect(errorOf(clash)).toMatchObject({ code: 'STAFF_CNIC_EXISTS', details: { staffId: staff.id } });
      expect((await patch(`${BASE}/${staff.id}`, { cnic: null })).body).toMatchObject({
        cnicMasked: null,
        hasCnic: false,
      });
      const audit = await auditFor(school.id, 'staff', staff.id);
      expect(audit.slice(1).map((a) => a.metadata)).toEqual([
        { changes: { cnic: { changed: true } } },
        { changes: { cnic: { changed: true } } },
      ]);
      expect(JSON.stringify(audit.map((a) => [a.metadata, a.reason]))).not.toContain(d);
    });

    it('R24: any CNIC in the body is refused once a login exists; other fields stay editable', async () => {
      const d = digits();
      const staff = await createStaff({ cnic: d });
      expect((await issueLogin(staff.id)).status).toBe(201);
      for (const cnic of [d, digits(), null]) {
        const res = await patch(`${BASE}/${staff.id}`, { cnic, fullName: 'Not Applied' });
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('STAFF_CNIC_LOCKED');
      }
      const ok = await patch(`${BASE}/${staff.id}`, { fullName: 'Renamed Teacher' });
      expect(ok.body).toMatchObject({ fullName: 'Renamed Teacher', cnicMasked: masked(d) });
    });
  });

  describe('POST /staff/:id/change-status', () => {
    /** A teacher with a login, a cookie and a bearer session, and three assignments. */
    async function teacherWithEverything(s: TestSchool) {
      const user = await createSchoolUser(db, s, { systemRole: 'teacher' });
      await createSchoolSession(db, s, user, { channel: 'cookie' });
      await createSchoolSession(db, s, user, { channel: 'bearer' });
      const { year, klass, section } = await createClassWithSection(db, s);
      const subject = await createSubject(db, s);
      const begun = await createTeacherAssignment(db, s, user, {
        role: 'class_teacher',
        section,
        startsOn: schoolDay(-20),
      });
      const today = await createTeacherAssignment(db, s, user, {
        role: 'subject_teacher',
        subjectId: subject.id,
        klass,
        startsOn: schoolDay(0),
      });
      const future = await createTeacherAssignment(db, s, user, {
        role: 'subject_teacher',
        subjectId: subject.id,
        section,
        startsOn: schoolDay(5),
      });
      return { user, year, assignments: { begun, today, future } };
    }

    it('R74: nobody changes their own staff status', async () => {
      const res = await changeStatus(String(principal.staffId), 'suspended');
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SELF_ACTION_FORBIDDEN');
    });

    it('R17, R70: left ends roles and assignments and revokes every session, not users.status', async () => {
      const { user, assignments } = await teacherWithEverything(school);
      // A guardian capacity remains, and the sessions still go (R70).
      const guardian = await db.guardian.create({
        data: { schoolId: school.id, fullName: 'Also A Parent', contactCapability: 'whatsapp' },
      });
      await db.user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { guardianId: guardian.id } });
      expect(await liveSessions(school.id, user.userId)).toBe(2);

      const res = await changeStatus(String(user.staffId), 'left');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'left', systemRoles: [], userId: String(user.userId) });
      expect(await liveSessions(school.id, user.userId)).toBe(0);
      const login = await db.user.findFirst({ where: { schoolId: school.id, id: user.userId } });
      expect(login?.status).toBe('active');
      const roles = await db.userRole.findMany({ where: { schoolId: school.id, userId: user.userId } });
      expect(roles.map((r) => [r.endedAt !== null, r.endedBy])).toEqual([[true, principal.userId]]);
      const rows = await db.teacherAssignment.findMany({
        where: { schoolId: school.id, staffId: user.staffId },
        orderBy: { id: 'asc' },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Begun before today: last day yesterday. Begun today or not yet: voided (never counted).
      expect(byId.get(assignments.begun.id)).toMatchObject({ endsOn: day(schoolDay(-1)), voidedAt: null });
      expect(byId.get(assignments.today.id)).toMatchObject({ endsOn: null, voidedBy: principal.userId });
      expect(byId.get(assignments.future.id)).toMatchObject({ endsOn: null, voidedBy: principal.userId });
      const staff = await db.staff.findFirst({ where: { schoolId: school.id, id: user.staffId } });
      expect(staff?.leftOn).toEqual(day(schoolDay()));
      const audit = await auditFor(school.id, 'staff', user.staffId);
      expect(audit.map((a) => [a.action, a.reason, a.metadata])).toEqual([
        [
          'staff.status_changed',
          'Recorded by the office',
          { from: 'active', to: 'left', rolesEnded: 1, assignmentsEnded: 3, sessionsRevoked: 2, grantsEnded: 0 },
        ],
      ]);
    });

    it('R17, R19: leaving ends active grants and revokes with reason "staff left"; re-hire restores none', async () => {
      const { user } = await teacherWithEverything(school);
      const permissions = h.app.get(PermissionsService);
      const row = (capabilityKey: string, effect: 'grant' | 'revoke') => ({
        schoolId: school.id,
        userId: user.userId,
        capabilityKey,
        effect,
        grantedBy: principal.userId,
        reason: 'Covering the office',
      });
      const grant = await db.userCapabilityGrant.create({ data: row('payment.record', 'grant') });
      const revoke = await db.userCapabilityGrant.create({ data: row('diary.write', 'revoke') });
      const ended = await db.userCapabilityGrant.create({
        data: { ...row('staff.view', 'grant'), createdAt: new Date(Date.now() - 60_000), revokedAt: new Date(), revokedBy: principal.userId, endReason: 'Done' },
      });
      expect((await changeStatus(String(user.staffId), 'left')).status).toBe(200);
      const rows = await db.userCapabilityGrant.findMany({ where: { schoolId: school.id, userId: user.userId } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of [grant.id, revoke.id]) {
        expect(byId.get(id)).toMatchObject({ revokedBy: principal.userId, endReason: 'staff left', revokedAt: expect.any(Date) });
      }
      // An already-ended row keeps its own end.
      expect(byId.get(ended.id)).toMatchObject({ endReason: 'Done' });
      const [audit] = await auditFor(school.id, 'staff', user.staffId);
      expect(audit?.metadata).toMatchObject({ to: 'left', grantsEnded: 2 });

      // R19: re-hire restores nothing, grants included.
      expect((await changeStatus(String(user.staffId), 'active')).status).toBe(200);
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: user.userId, revokedAt: null } })).toBe(0);
      expect((await permissions.load(school.id, user.userId))?.capabilities.size).toBe(0);
    });

    it('R18: suspended keeps grants inert; they count again on reactivation', async () => {
      const { user } = await teacherWithEverything(school);
      const permissions = h.app.get(PermissionsService);
      await db.userCapabilityGrant.create({
        data: {
          schoolId: school.id,
          userId: user.userId,
          capabilityKey: 'payment.record',
          effect: 'grant',
          grantedBy: principal.userId,
          reason: 'Covering the office',
        },
      });
      const held = async () => (await permissions.load(school.id, user.userId))?.capabilities.has(Capability.PAYMENT_RECORD);
      expect(await held()).toBe(true);
      expect((await changeStatus(String(user.staffId), 'suspended')).status).toBe(200);
      expect(await held()).toBe(false);
      expect(await db.userCapabilityGrant.count({ where: { schoolId: school.id, userId: user.userId, revokedAt: null } })).toBe(1);
      expect((await changeStatus(String(user.staffId), 'active')).status).toBe(200);
      expect(await held()).toBe(true);
    });

    it('R18, R59: suspended revokes sessions and empties capabilities; roles and assignments wait', async () => {
      const { user, assignments } = await teacherWithEverything(school);
      const permissions = h.app.get(PermissionsService);
      expect((await changeStatus(String(user.staffId), 'suspended')).status).toBe(200);
      expect(await liveSessions(school.id, user.userId)).toBe(0);
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: user.userId, endedAt: null } })).toBe(1);
      expect(
        await db.teacherAssignment.count({
          where: { schoolId: school.id, staffId: user.staffId, voidedAt: null, endsOn: null },
        }),
      ).toBe(3);
      const suspended = await permissions.load(school.id, user.userId);
      expect(suspended?.capacities.staff).toBe(false);
      expect(suspended?.capabilities.size).toBe(0);
      expect(await permissions.can(school.id, suspended!, Capability.STUDENT_VIEW)).toBeNull();
      // A session made afterwards is refused: no capacity remains (R71).
      const late = await createSchoolSession(db, school, user);
      expect((await get('/api/v1/me', late.cookie)).status).toBe(401);

      expect((await changeStatus(String(user.staffId), 'active')).status).toBe(200);
      const back = await permissions.load(school.id, user.userId);
      expect(back?.capacities.staff).toBe(true);
      expect(back?.capabilities.has(Capability.STUDENT_VIEW)).toBe(true);
      const row = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id: assignments.begun.id } });
      expect(row).toMatchObject({ endsOn: null, voidedAt: null });
    });

    it('R19: re-hire restores nothing; left -> suspended is illegal; the same status is a no-op', async () => {
      const { user } = await teacherWithEverything(school);
      const id = String(user.staffId);
      expect((await changeStatus(id, 'left')).status).toBe(200);
      const illegal = await changeStatus(id, 'suspended');
      expect(illegal.status).toBe(409);
      expect(errorOf(illegal)).toMatchObject({
        code: 'ILLEGAL_STATUS_TRANSITION',
        details: { from: 'left', to: 'suspended' },
      });
      const again = await changeStatus(id, 'left');
      expect(again.status).toBe(200);
      expect((await auditFor(school.id, 'staff', user.staffId)).length).toBe(1);

      const rehired = await changeStatus(id, 'active');
      expect(rehired.body).toMatchObject({ status: 'active', systemRoles: [] });
      const staff = await db.staff.findFirst({ where: { schoolId: school.id, id: user.staffId } });
      expect(staff?.leftOn).toBeNull();
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: user.userId, endedAt: null } })).toBe(0);
      expect(
        await db.teacherAssignment.count({
          where: { schoolId: school.id, staffId: user.staffId, voidedAt: null, endsOn: null },
        }),
      ).toBe(0);
      // Back to a login with no capacity until a role is assigned (contract §3.5, §5).
      expect((await permissions().load(school.id, user.userId))?.capacities.staff).toBe(false);
      expect((await auditFor(school.id, 'staff', user.staffId)).map((a) => a.metadata)).toEqual([
        { from: 'active', to: 'left', rolesEnded: 1, assignmentsEnded: 3, sessionsRevoked: 2, grantsEnded: 0 },
        { from: 'left', to: 'active', rolesEnded: 0, assignmentsEnded: 0, sessionsRevoked: 0, grantsEnded: 0 },
      ]);
    });

    it('A10: a login issued between the read and the staff lock restarts the change (user before staff)', async () => {
      const t = await h.caller(school, 'teacher');
      const repo = h.app.get(StaffRepository, { strict: false });
      const row = await repo.findById(school.id, t.staffId);
      // The first read sees the staff row as it was before its login existed.
      const stale = jest
        .spyOn(StaffRepository.prototype, 'findById')
        .mockResolvedValueOnce(row && { ...row, userId: null });
      const userLock = jest.spyOn(UserRepository.prototype, 'lock');
      const staffLock = jest.spyOn(StaffRepository.prototype, 'lockIfUnchanged');
      try {
        const res = await changeStatus(String(t.staffId), 'suspended');
        expect(res.status).toBe(200);
        // The attempt that committed locked the login before the staff row.
        const lastUserLock = userLock.mock.invocationCallOrder.at(-1) ?? 0;
        const lastStaffLock = staffLock.mock.invocationCallOrder.at(-1) ?? 0;
        expect(staffLock.mock.calls.length).toBe(2);
        expect(lastUserLock).toBeLessThan(lastStaffLock);
        expect(userLock.mock.calls.at(-1)?.[1]).toBe(t.userId);
      } finally {
        stale.mockRestore();
        userLock.mockRestore();
        staffLock.mockRestore();
      }
      // The restart locked and acted on the login: its sessions were revoked (R70).
      expect(await liveSessions(school.id, t.userId)).toBe(0);
      expect((await db.staff.findFirst({ where: { schoolId: school.id, id: t.staffId } }))?.status).toBe('suspended');
    });

    it('a staff member without a login changes status with nothing else to end', async () => {
      const staff = await createStaff();
      const res = await changeStatus(staff.id, 'suspended');
      expect(res.body).toMatchObject({ status: 'suspended', userId: null });
      for (const reason of [undefined, 'no', `id ${randomIdentityDigits()}`]) {
        const bad = await post(`${BASE}/${staff.id}/change-status`, { status: 'active', ...(reason === undefined ? {} : { reason }) });
        expect(bad.status).toBe(422);
      }
    });

    it('R73: two principals setting each other left at once: exactly one succeeds', async () => {
      const s = await createSchool();
      // The settings row every real school has: the R73 lock (users.service, staff status, roles).
      await db.schoolSettings.create({ data: { schoolId: s.id, feeDueDay: 10 } });
      const a = await h.caller(s, 'principal');
      const b = await h.caller(s, 'principal');
      const [ra, rb] = await Promise.all([
        changeStatus(String(b.staffId), 'left', a.cookie),
        changeStatus(String(a.staffId), 'left', b.cookie),
      ]);
      expect([ra.status, rb.status].filter((st) => st === 200)).toHaveLength(1);
      const loser = ra.status === 200 ? rb : ra;
      // The loser either waited and met R72, or its own session was already revoked.
      expect([401, 409]).toContain(loser.status);
      if (loser.status === 409) expect(errorOf(loser).code).toBe('LAST_PRINCIPAL');
      const active = await db.staff.count({ where: { schoolId: s.id, status: 'active' } });
      expect(active).toBe(1);
    });

    const permissions = () => h.app.get(PermissionsService);

    const widened = (s: TestSchool, user: { userId: bigint }, extra: Capability[]) =>
      h.widenedSession(s, user.userId, extra);

    it('R12, R14: without role.manage, a principal or a wider target is refused', async () => {
      const s = await createSchool();
      const clerk = await createSchoolUser(db, s, { systemRole: 'office_staff' });
      const session = await widened(s, clerk, [Capability.STAFF_STATUS_CHANGE]);
      const service = h.app.get(StaffStatusService);
      const boss = await createSchoolUser(db, s, { systemRole: 'principal' });
      const teacher = await createSchoolUser(db, s, { systemRole: 'teacher' });
      const peer = await createSchoolUser(db, s, { systemRole: 'office_staff' });
      const dto = { status: 'suspended' as const, reason: 'Granted clerk' };
      await expect(service.changeStatus(session, boss.staffId, dto)).rejects.toMatchObject({
        status: 403,
        details: { reason: 'target_is_principal' },
      });
      await expect(service.changeStatus(session, teacher.staffId, dto)).rejects.toMatchObject({
        status: 403,
        details: { reason: 'target_exceeds_actor' },
      });
      // A suspended teacher still holds dormant defaults the clerk lacks (R14).
      await db.staff.updateMany({ where: { schoolId: s.id, id: teacher.staffId }, data: { status: 'suspended' } });
      await expect(
        service.changeStatus(session, teacher.staffId, { status: 'active', reason: 'Granted clerk' }),
      ).rejects.toMatchObject({ details: { reason: 'target_exceeds_actor' } });
      // Within the clerk's own set: allowed.
      await expect(service.changeStatus(session, peer.staffId, dto)).resolves.toMatchObject({ status: 'suspended' });
    });

    it('R72: suspending or removing the only active principal is refused LAST_PRINCIPAL', async () => {
      const s = await createSchool();
      const boss = await createSchoolUser(db, s, { systemRole: 'principal' });
      const clerk = await createSchoolUser(db, s, { systemRole: 'office_staff' });
      const session = await widened(s, clerk, [Capability.STAFF_STATUS_CHANGE, Capability.ROLE_MANAGE]);
      const service = h.app.get(StaffStatusService);
      for (const status of ['suspended', 'left'] as const) {
        await expect(service.changeStatus(session, boss.staffId, { status, reason: 'Testing R72' })).rejects.toMatchObject({
          status: 409,
          code: 'LAST_PRINCIPAL',
        });
      }
      const second = await createSchoolUser(db, s, { systemRole: 'principal' });
      await expect(
        service.changeStatus(session, boss.staffId, { status: 'suspended', reason: 'Testing R72' }),
      ).resolves.toMatchObject({ status: 'suspended' });
      // Now `second` is the only one counted.
      await expect(
        service.changeStatus(session, second.staffId, { status: 'left', reason: 'Testing R72' }),
      ).rejects.toMatchObject({ code: 'LAST_PRINCIPAL' });
      // The suspended one is not counted, so it may leave.
      await expect(
        service.changeStatus(session, boss.staffId, { status: 'left', reason: 'Testing R72' }),
      ).resolves.toMatchObject({ status: 'left' });
    });
  });

  describe('POST /staff/:id/issue-login', () => {
    const login = (s: TestSchool & { shortCode: string }, d: string) =>
      request(h.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', nextIp())
        .send({ schoolCode: s.shortCode, username: d, password: d });

    it('creates a login: username the CNIC hash, default password, one role, audited', async () => {
      const d = digits();
      const staff = await createStaff({ cnic: d });
      const res = await issueLogin(staff.id, { systemRole: 'teacher' });
      expect(res.status).toBe(201);
      const user = res.body as User;
      expect(user).toMatchObject({
        id: expect.stringMatching(ID),
        staffId: staff.id,
        guardianId: null,
        systemRoles: ['teacher'],
        passwordIsDefault: true,
        hasEmail: false,
        status: 'active',
      });
      const row = await db.user.findFirst({ where: { schoolId: school.id, id: BigInt(user.id) } });
      expect(row?.usernameHash).toBe(testIdentityHash(d));
      expect(await h.app.get(PasswordHasher).verify(row?.passwordHash ?? '', d)).toBe(true);
      const roles = await db.userRole.findMany({ where: { schoolId: school.id, userId: BigInt(user.id) } });
      expect(roles.map((r) => [r.systemRole, r.assignedBy, r.endedAt])).toEqual([['teacher', principal.userId, null]]);
      const audit = await auditFor(school.id, 'user', user.id);
      expect(audit.map((a) => [a.action, a.metadata])).toEqual([
        ['user.login_issued', { capacity: 'staff', systemRole: 'teacher', linkedExistingUser: false }],
      ]);
      expect((await get(`${BASE}/${staff.id}`)).body).toMatchObject({ userId: user.id, systemRoles: ['teacher'] });
      const signedIn = await login(school, d);
      expect(signedIn.status).toBe(200);
    });

    it('R21: refused for suspended or left staff, without a CNIC, and when a login exists', async () => {
      const suspended = await createStaff();
      await changeStatus(suspended.id, 'suspended');
      const left = await createStaff();
      await changeStatus(left.id, 'left');
      for (const id of [suspended.id, left.id]) {
        expect(errorOf(await issueLogin(id)).code).toBe('STAFF_NOT_ACTIVE');
      }
      const noCnic = await createStaff({ cnic: null });
      expect(errorOf(await issueLogin(noCnic.id)).code).toBe('IDENTITY_NUMBER_MISSING');
      const done = await createStaff();
      expect((await issueLogin(done.id)).status).toBe(201);
      const again = await issueLogin(done.id, { systemRole: 'office_staff' });
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('LOGIN_ALREADY_EXISTS');
      expect((await issueLogin(done.id, {})).status).toBe(422);
      expect((await issueLogin(done.id, { systemRole: 'parent' })).status).toBe(422);
    });

    it('R13: a role beyond the caller’s set needs role.manage; principal always does', async () => {
      const forTeacher = await createStaff();
      const refused = await issueLogin(forTeacher.id, { systemRole: 'teacher' }, office.cookie);
      expect(refused.status).toBe(403);
      expect(errorOf(refused).details).toEqual({ reason: 'role_exceeds_actor' });
      const forPrincipal = await createStaff();
      const refusedPrincipal = await issueLogin(forPrincipal.id, { systemRole: 'principal' }, office.cookie);
      expect(errorOf(refusedPrincipal).details).toEqual({ reason: 'role_exceeds_actor' });
      expect(await db.user.count({ where: { schoolId: school.id, staffId: BigInt(forTeacher.id) } })).toBe(0);
      const clerk = await createStaff();
      expect((await issueLogin(clerk.id, { systemRole: 'office_staff' }, office.cookie)).status).toBe(201);
      expect((await issueLogin(forPrincipal.id, { systemRole: 'principal' })).status).toBe(201);
    });

    it('R22: an existing guardian login is linked only when confirmed, and then reset', async () => {
      const parent = await createGuardianUser(db, school);
      sentDigits.push(parent.cnic);
      await db.user.updateMany({
        where: { schoolId: school.id, id: parent.userId },
        data: { email: 'parent@example.com', emailVerifiedAt: new Date(), passwordIsDefault: false },
      });
      await createSchoolSession(db, school, parent);
      await db.userToken.create({
        data: {
          schoolId: school.id,
          userId: parent.userId,
          tokenHash: 'a'.repeat(64),
          purpose: 'password_reset',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const staff = await createStaff({ cnic: parent.cnic });

      const unconfirmed = await issueLogin(staff.id, { systemRole: 'teacher' });
      expect(unconfirmed.status).toBe(409);
      expect(errorOf(unconfirmed).code).toBe('LINK_EXISTING_LOGIN_UNCONFIRMED');
      const untouched = await db.user.findFirst({ where: { schoolId: school.id, id: parent.userId } });
      expect(untouched).toMatchObject({ staffId: null, email: 'parent@example.com' });
      expect(await liveSessions(school.id, parent.userId)).toBe(1);
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: parent.userId } })).toBe(0);

      const res = await issueLogin(staff.id, { systemRole: 'teacher', confirmLinkExisting: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: String(parent.userId),
        staffId: staff.id,
        guardianId: String(parent.guardianId),
        systemRoles: ['teacher'],
        passwordIsDefault: true,
        hasEmail: false,
      });
      expect(await db.user.count({ where: { schoolId: school.id, usernameHash: testIdentityHash(parent.cnic) } })).toBe(1);
      expect(await liveSessions(school.id, parent.userId)).toBe(0);
      expect(
        await db.userToken.count({ where: { schoolId: school.id, userId: parent.userId, expiresAt: { gt: new Date() } } }),
      ).toBe(0);
      const audit = await auditFor(school.id, 'user', parent.userId);
      expect(audit.map((a) => [a.action, a.metadata, a.actorUserId])).toEqual([
        ['user.reset_on_staff_link', { capacity: 'teacher' }, principal.userId],
        ['user.login_issued', { capacity: 'staff', systemRole: 'teacher', linkedExistingUser: true }, principal.userId],
      ]);
      expect((await login(school, parent.cnic)).status).toBe(200);
    });

    it('never links onto a student login, a disabled login or another staff login', async () => {
      const d = digits();
      const student = await createStudent(db, school, { bForm: d });
      await db.user.create({
        data: {
          schoolId: school.id,
          usernameHash: testIdentityHash(d),
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
          studentId: student.id,
        },
      });
      const onStudent = await createStaff({ cnic: d });
      const refused = await issueLogin(onStudent.id, { systemRole: 'teacher', confirmLinkExisting: true });
      expect(refused.status).toBe(409);
      expect(errorOf(refused).code).toBe('USERNAME_IN_USE');

      const disabled = await createGuardianUser(db, school, { userStatus: 'disabled' });
      sentDigits.push(disabled.cnic);
      const onDisabled = await createStaff({ cnic: disabled.cnic });
      const res = await issueLogin(onDisabled.id, { systemRole: 'teacher', confirmLinkExisting: true });
      expect(errorOf(res).code).toBe('USER_DISABLED');
      expect(await db.userRole.count({ where: { schoolId: school.id, userId: disabled.userId } })).toBe(0);
    });

    it('R77: racing issue-logins for one person create one user; the losers get R21, not 500', async () => {
      const staff = await createStaff();
      const results = await Promise.all([1, 2, 3].map(() => issueLogin(staff.id)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(errorOf(r).code).toBe('LOGIN_ALREADY_EXISTS');
      }
      expect(await db.user.count({ where: { schoolId: school.id, staffId: BigInt(staff.id) } })).toBe(1);
    });
  });

  it('R16: no identity number in any response body or log line of this suite', () => {
    expect(sentDigits.length).toBeGreaterThan(10);
    const everything = [...h.bodies, ...h.logs].join('\n');
    for (const d of sentDigits) {
      expect(everything).not.toContain(d);
      expect(everything).not.toContain(dashed(d));
    }
  });
});
