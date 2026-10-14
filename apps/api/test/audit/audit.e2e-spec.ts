// Slice 46 over HTTP (phase-5-extended.md rule 40, §1.1 "Audit screen", R354; contracts/slice-46.md):
// the filters and the required-filter rule, the 92-day range, the action prefix, the excluded
// access-management family, masking of identity-, phone- and email-shaped values, the platform
// actor shown as "Platform support", 404 outside the school, audit.view grantable and principal by
// default, inert on a default password, and `audit.viewed` written once per actor per day.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, type SystemRole } from '@asms/shared';
import { AUDIT_VIEWED_ACTION } from '../../src/modules/audit/audit.service';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

const API = '/api/v1';
const db = () => testDb();

interface Entry {
  id: string;
  createdAt: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  actor: { kind: string; userId: string | null; name: string };
  reason: string | null;
  details: { key: string; value: string }[];
}
interface PageOf<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}
interface ErrorBody {
  error: { code: string; details: { fields?: { path: string }[] } | null };
}

describe('slice 46: the audit screen (R354)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const get = (path: string, cookie: string) => http().get(`${API}${path}`).set('Cookie', cookie);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const signIn = async (school: TestSchool, systemRole: SystemRole, defaultPassword = false) => {
    const user = await createSchoolUser(db(), school, { systemRole, ...(defaultPassword ? { defaultPassword } : {}) });
    return { user, session: await createSchoolSession(db(), school, user) };
  };

  /** A school with a principal and a set of rows written at fixed instants. */
  const seed = async () => {
    const school = await createSchool();
    const principal = await signIn(school, 'principal');
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff', fullName: 'Bilal Clerk' });
    const at = (iso: string) => new Date(iso);
    const row = (data: {
      action: string;
      actorUserId?: bigint | null;
      actorPlatformUserId?: bigint;
      subjectType?: string;
      subjectId?: bigint | null;
      reason?: string;
      metadata?: object;
      createdAt: Date;
    }) =>
      db().auditLog.create({
        data: {
          schoolId: school.id,
          actorUserId: data.actorUserId === undefined ? clerk.userId : data.actorUserId,
          ...(data.actorPlatformUserId === undefined ? {} : { actorPlatformUserId: data.actorPlatformUserId }),
          action: data.action,
          subjectType: data.subjectType ?? 'payment',
          subjectId: data.subjectId === undefined ? 501n : data.subjectId,
          ...(data.reason === undefined ? {} : { reason: data.reason }),
          metadata: data.metadata ?? {},
          createdAt: data.createdAt,
        },
        select: { id: true },
      });
    const recorded = await row({
      action: 'payment.recorded',
      metadata: {
        amount: 2500,
        receiptNo: '2026-0007',
        guardianPhone: '+923001234567',
        note: 'call 0300-1234567 or mail ali.khan@example.com, cnic 35202 1234567 1',
        nested: { contact: 'x@y.pk', at: '2026-10-01T09:00:00.000Z' },
      },
      reason: 'Paid by 35202 1234567 1',
      createdAt: at('2026-10-01T05:00:00.000Z'),
    });
    const voided = await row({ action: 'payment.voided', createdAt: at('2026-10-02T05:00:00.000Z') });
    const account = await row({
      action: 'payment_account.created',
      subjectType: 'payment_account',
      subjectId: 9n,
      createdAt: at('2026-10-03T05:00:00.000Z'),
    });
    const student = await row({
      action: 'student.updated',
      subjectType: 'student',
      subjectId: 77n,
      createdAt: at('2026-06-01T05:00:00.000Z'),
    });
    const platform = await row({
      action: 'support.read',
      actorUserId: null,
      actorPlatformUserId: 3n,
      subjectType: 'student',
      subjectId: 77n,
      createdAt: at('2026-10-04T05:00:00.000Z'),
    });
    // The access-management family: never listed.
    const hidden = [];
    for (const action of [
      'user.password_changed',
      'user.default_password_blocked',
      'user.login_issued',
      'user_role.assigned',
      'custom_role.created',
      'capability_grant.created',
    ]) {
      hidden.push(await row({ action, subjectType: 'user', subjectId: clerk.userId, createdAt: at('2026-10-02T06:00:00.000Z') }));
    }
    return { school, principal, clerk, ids: { recorded: recorded.id, voided: voided.id, account: account.id, student: student.id, platform: platform.id }, hidden: hidden.map((h) => h.id) };
  };

  const list = async (cookie: string, query: string) => {
    const res = await get(`/audit-log?${query}`, cookie).expect(200);
    return res.body as PageOf<Entry>;
  };
  const fieldsOf = (res: request.Response) => ((res.body as ErrorBody).error.details?.fields ?? []).map((f) => f.path);

  it('R354: one of actor, subject or a date range is required; pairs go together; at most 92 days', async () => {
    const { principal } = await seed();
    const cookie = principal.session.cookie;
    const none = await get('/audit-log', cookie);
    expect([none.status, (none.body as ErrorBody).error.code]).toEqual([422, ErrorCode.VALIDATION_FAILED]);
    // actionPrefix alone narrows nothing enough.
    expect((await get('/audit-log?actionPrefix=payment', cookie)).status).toBe(422);
    const half = await get('/audit-log?subjectType=student', cookie);
    expect([half.status, fieldsOf(half)]).toEqual([422, ['subjectId']]);
    const oneDate = await get('/audit-log?createdFrom=2026-10-01', cookie);
    expect([oneDate.status, fieldsOf(oneDate)]).toEqual([422, ['createdTo']]);
    // 92 calendar days inclusive is allowed; 93 is not; a reversed range is not.
    expect((await get('/audit-log?createdFrom=2026-07-05&createdTo=2026-10-04', cookie)).status).toBe(200);
    const wide = await get('/audit-log?createdFrom=2026-07-04&createdTo=2026-10-04', cookie);
    expect([wide.status, fieldsOf(wide)]).toEqual([422, ['createdTo']]);
    expect((await get('/audit-log?createdFrom=2026-10-04&createdTo=2026-10-01', cookie)).status).toBe(422);
    // Shapes.
    expect((await get('/audit-log?actorUserId=abc', cookie)).status).toBe(422);
    expect((await get('/audit-log?subjectType=Student&subjectId=1', cookie)).status).toBe(422);
    expect((await get('/audit-log?actorUserId=1&actionPrefix=pay%25', cookie)).status).toBe(422);
    expect((await get('/audit-log?actorUserId=1&limit=51', cookie)).status).toBe(422);
  });

  it('R354: filters by date range (school days, inclusive), actor, subject and action prefix, newest first', async () => {
    const { principal, clerk, ids } = await seed();
    const cookie = principal.session.cookie;

    const october = await list(cookie, 'createdFrom=2026-10-01&createdTo=2026-10-04');
    expect(october.data.map((e) => e.id)).toEqual(
      [ids.platform, ids.account, ids.voided, ids.recorded].map(String),
    );
    expect(october.total).toBe(4);
    // A single school day: 2026-10-02 in Asia/Karachi.
    expect((await list(cookie, 'createdFrom=2026-10-02&createdTo=2026-10-02')).data.map((e) => e.id)).toEqual([String(ids.voided)]);

    const byActor = await list(cookie, `actorUserId=${clerk.userId}`);
    expect(byActor.data.map((e) => e.id)).toEqual([ids.account, ids.voided, ids.recorded, ids.student].map(String));

    const bySubject = await list(cookie, 'subjectType=student&subjectId=77');
    expect(bySubject.data.map((e) => e.id)).toEqual([ids.platform, ids.student].map(String));

    // A family means `family.*`: `payment` is not `payment_account`.
    const family = await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=payment`);
    expect(family.data.map((e) => e.action)).toEqual(['payment.voided', 'payment.recorded']);
    const prefix = await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=payment.rec`);
    expect(prefix.data.map((e) => e.action)).toEqual(['payment.recorded']);
    expect((await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=payment_account`)).data.map((e) => e.action)).toEqual([
      'payment_account.created',
    ]);

    // Paging.
    const first = await list(cookie, `actorUserId=${clerk.userId}&limit=2`);
    const second = await list(cookie, `actorUserId=${clerk.userId}&limit=2&page=2`);
    expect([first.total, first.data.length, second.data.length]).toEqual([4, 2, 2]);
    expect(second.data[0]?.id).toBe(String(ids.recorded));
  });

  it('R354: the access-management family is never listed and never served by id', async () => {
    const { principal, clerk, hidden } = await seed();
    const cookie = principal.session.cookie;
    const all = await list(cookie, 'createdFrom=2026-10-01&createdTo=2026-10-04');
    const byActor = await list(cookie, `actorUserId=${clerk.userId}`);
    const bySubject = await list(cookie, `subjectType=user&subjectId=${clerk.userId}`);
    const byPrefix = await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=user`);
    for (const page of [all, byActor, bySubject, byPrefix]) {
      expect(page.data.filter((e) => /^(user|user_role|custom_role|capability_grant)\./.test(e.action))).toEqual([]);
    }
    expect([bySubject.total, byPrefix.total]).toEqual([0, 0]);
    for (const id of hidden) {
      await get(`/audit-log/${id}`, cookie).expect(404);
    }
  });

  it('R354: an underscore is a letter, never a LIKE wildcard: user_role does not hide userxrole, pay_ent finds nothing', async () => {
    const { school, principal, clerk } = await seed();
    const cookie = principal.session.cookie;
    const lookalike = await db().auditLog.create({
      data: {
        schoolId: school.id,
        actorUserId: clerk.userId,
        action: 'userxrole.probe',
        subjectType: 'payment',
        subjectId: 501n,
        metadata: {},
        createdAt: new Date('2026-10-02T07:00:00.000Z'),
      },
      select: { id: true },
    });
    const byActor = await list(cookie, `actorUserId=${clerk.userId}`);
    expect(byActor.data.map((e) => e.action)).toContain('userxrole.probe');
    await get(`/audit-log/${lookalike.id}`, cookie).expect(200);
    expect((await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=pay_ent`)).total).toBe(0);
    expect((await list(cookie, `actorUserId=${clerk.userId}&actionPrefix=userxrole`)).data.map((e) => e.action)).toEqual(['userxrole.probe']);
  });

  it('R354: metadata as key/value text with identity, phone and email shapes masked; a platform actor is "Platform support"', async () => {
    const { principal, clerk, ids } = await seed();
    const cookie = principal.session.cookie;
    const entry = (await get(`/audit-log/${ids.recorded}`, cookie).expect(200)).body as Entry;
    expect(entry.actor).toEqual({ kind: 'user', userId: String(clerk.userId), name: 'Bilal Clerk' });
    expect(entry.subjectType).toBe('payment');
    expect(entry.subjectId).toBe('501');
    expect(entry.details).toEqual([
      { key: 'amount', value: '2500' },
      { key: 'guardianPhone', value: '***' },
      { key: 'nested.at', value: '2026-10-01T09:00:00.000Z' },
      { key: 'nested.contact', value: 'x***@y.pk' },
      { key: 'note', value: 'call *********67 or mail a***@example.com, cnic ***********71' },
      { key: 'receiptNo', value: '2026-0007' },
    ]);
    expect(entry.reason).toBe('Paid by ***********71');
    const text = JSON.stringify(entry);
    expect(text).not.toMatch(/1234567/);
    expect(text).not.toMatch(/ali\.khan/);

    const support = (await get(`/audit-log/${ids.platform}`, cookie).expect(200)).body as Entry;
    expect(support.actor).toEqual({ kind: 'platform', userId: null, name: 'Platform support' });
  });

  it('R354: another school, an unknown id and a hidden row are 404; the list never crosses schools', async () => {
    const a = await seed();
    const b = await seed();
    await get(`/audit-log/${b.ids.recorded}`, a.principal.session.cookie).expect(404);
    await get('/audit-log/999999999', a.principal.session.cookie).expect(404);
    const page = await list(a.principal.session.cookie, `actorUserId=${b.clerk.userId}`);
    expect(page).toMatchObject({ total: 0, data: [] });
  });

  it('R354: audit.view is the principal default and grantable; office staff and teachers are refused', async () => {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    const teacher = await signIn(school, 'teacher');
    for (const caller of [office, teacher]) {
      const res = await get('/audit-log?createdFrom=2026-10-01&createdTo=2026-10-02', caller.session.cookie);
      expect([res.status, (res.body as ErrorBody).error.code]).toEqual([403, ErrorCode.PERMISSION_DENIED]);
    }
    const principal = await signIn(school, 'principal');
    await db().userCapabilityGrant.create({
      data: {
        schoolId: school.id,
        userId: office.user.userId,
        capabilityKey: Capability.AUDIT_VIEW,
        effect: 'grant',
        grantedBy: principal.user.userId,
        reason: 'Audit duty',
      },
    });
    await get('/audit-log?createdFrom=2026-10-01&createdTo=2026-10-02', office.session.cookie).expect(200);
  });

  it('R354, R355: inert on a default password (both routes), and works once the password is changed', async () => {
    const { school, ids } = await seed();
    const { user, session } = await signIn(school, 'principal', true);
    for (const path of ['/audit-log?createdFrom=2026-10-01&createdTo=2026-10-02', `/audit-log/${ids.recorded}`]) {
      const res = await get(path, session.cookie);
      expect([res.status, (res.body as ErrorBody).error.code]).toEqual([403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]);
    }
    await db().user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { passwordIsDefault: false } });
    await get('/audit-log?createdFrom=2026-10-01&createdTo=2026-10-02', session.cookie).expect(200);
    await get(`/audit-log/${ids.recorded}`, session.cookie).expect(200);
  });

  it('R57: audit.viewed is written once per actor per day, by the list and the entry alike', async () => {
    const { school, principal, ids } = await seed();
    const cookie = principal.session.cookie;
    await list(cookie, 'createdFrom=2026-10-01&createdTo=2026-10-02');
    await get(`/audit-log/${ids.recorded}`, cookie).expect(200);
    await list(cookie, `actorUserId=${principal.user.userId}`);
    const viewed = await db().auditLog.findMany({
      where: { schoolId: school.id, action: AUDIT_VIEWED_ACTION },
      select: { actorUserId: true, subjectType: true },
    });
    expect(viewed).toEqual([{ actorUserId: principal.user.userId, subjectType: 'audit_log' }]);
    // A refused request writes nothing.
    await get('/audit-log', cookie).expect(422);
  });
});
