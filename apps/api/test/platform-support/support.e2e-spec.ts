// Slice 45 over HTTP (phase-5-extended.md rule 35, §3.1 "Exception 7", R349-R352;
// contracts/slice-45.md): opening with a reason, a ticket and a fresh second factor; one open per
// school and three per platform user; expiry at the platform setting; the principals told on open
// and close; revoke, close and logout; every support read in both audit logs with the session and
// subject ids; the three read-only layers (the query guard, READ ONLY, lint in
// test/guardrails/lint-boundaries.spec.ts); no identity number, file or message in any view; lists
// at most 50; another admin's session 404 and an ended one 403.
import { NestExpressApplication } from '@nestjs/platform-express';
import { ClsService } from 'nestjs-cls';
import { TransactionHost } from '@nestjs-cls/transactional';
import { generate } from 'otplib';
import request from 'supertest';
import { ErrorCode } from '@asms/shared';
import { FieldCipher } from '../../src/common/crypto/field-encryption';
import { loadEnv } from '../../src/config/env';
import { newTotpSecret, totpSecretAad } from '../../src/modules/platform/auth/totp';
import {
  SupportSessionsService,
  supportNoticeSubjectId,
} from '../../src/modules/platform/support/support-sessions.service';
import type { PrismaTxAdapter } from '../../src/repositories/prisma';
import { SupportSessionRepository } from '../../src/repositories/platform/support-session.repository';
import { assertSupportRead, SupportWriteRefusedError } from '../../src/repositories/query-guard';
import { inSupportContext } from '../../src/tenancy/support-flag';
import { SupportReadContext } from '../../src/tenancy/support-read-context';
import { createTestApp } from '../core/app';
import { paymentsHttp, type World } from '../payments/payments-support';
import { createPlatformSession, createPlatformUser } from '../support/platform';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createGuardian, createStudent, linkGuardian } from '../support/students';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const db = () => testDb();

interface Session {
  id: string;
  schoolId: string;
  platformUserId: string;
  platformUserEmail: string;
  mine: boolean;
  reason: string;
  ticketRef: string;
  openedAt: string;
  expiresAt: string;
  status: 'open' | 'ended';
  closedAt: string | null;
  endKind: string | null;
}
interface ErrorBody {
  error: { code: string; details: Record<string, unknown> | null };
}
interface PageOf<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

/** A platform admin with a real enrolled authenticator and a full session. */
interface Admin {
  id: bigint;
  email: string;
  secret: string;
  cookie: string;
}

const HOUR_MS = 60 * 60_000;

describe('slice 45: platform support access (R349-R353)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const pay = paymentsHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const admin = async (): Promise<Admin> => {
    const user = await createPlatformUser();
    const secret = newTotpSecret();
    await db().platformUser.update({
      where: { id: user.id },
      data: { totpSecret: new FieldCipher(loadEnv().FIELD_ENCRYPTION_KEYS).encrypt(secret, totpSecretAad(user.id)) }, // pragma: allowlist secret
    });
    const session = await createPlatformSession(user.id);
    return { id: user.id, email: user.email, secret, cookie: session.cookie };
  };

  /** A code for the current step, away from a step boundary. */
  const totp = async (a: Admin, offset = 0): Promise<string> => {
    const into = (Date.now() / 1000) % 30;
    if (into > 27) await new Promise((resolve) => setTimeout(resolve, (30.5 - into) * 1000));
    return generate({ secret: a.secret, epoch: Math.floor(Date.now() / 1000) + offset * 30 });
  };

  /** A code whose step is fresh: the last accepted step is forgotten first (many opens per test). */
  const freshTotp = async (a: Admin): Promise<string> => {
    await db().platformUser.update({ where: { id: a.id }, data: { totpLastStep: null } });
    return totp(a);
  };

  const pGet = (path: string, a: Pick<Admin, 'cookie'>) => http().get(`${API}/platform${path}`).set('Cookie', a.cookie);
  const pPost = (path: string, a: Pick<Admin, 'cookie'>, body: object = {}) =>
    http().post(`${API}/platform${path}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send(body);
  const sGet = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const sPost = (path: string, s: { cookie: string }, body: object = {}) =>
    http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);
  const err = (res: request.Response) => res.body as ErrorBody;

  const open = async (a: Admin, school: { id: bigint }, extra: object = {}) =>
    pPost(`/schools/${school.id}/support-sessions`, a, {
      reason: 'Fee screen shows a wrong balance',
      ticketRef: 'TCK-1042',
      totp: await freshTotp(a),
      ...extra,
    });

  const openOk = async (a: Admin, school: { id: bigint }): Promise<Session> => {
    const res = await open(a, school);
    if (res.status !== 201) throw new Error(`open refused ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as Session;
  };

  const principalOf = async (school: TestSchool) => {
    const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
    return { user, session: await createSchoolSession(db(), school, user) };
  };

  /** A session row written directly (its times are immutable once inserted). */
  const insertSession = (platformUserId: bigint, schoolId: bigint, openedAt: Date, expiresAt: Date) =>
    db().platformSupportSession.create({
      data: { platformUserId, schoolId, reason: 'Seeded session', ticketRef: 'TCK-SEED', openedAt, expiresAt },
    });

  const bothLogs = async (schoolId: bigint, action: string, sessionId: bigint | string) => {
    const subjectId = BigInt(sessionId);
    const platform = await db().platformAuditLog.findMany({
      where: { schoolId, action, subjectType: 'support_session', subjectId },
      orderBy: { id: 'asc' },
    });
    const school = await db().auditLog.findMany({
      where: { schoolId, action, subjectType: 'support_session', subjectId },
      orderBy: { id: 'asc' },
    });
    return { platform, school };
  };

  const notices = (schoolId: bigint, type: 'support_session_opened' | 'support_session_closed') =>
    db().message.findMany({ where: { schoolId, type }, orderBy: { id: 'asc' } });

  // ------------------------------------------------------------------------------------ open

  describe('R349: opening', () => {
    it('needs a reason, a ticket reference and a six-digit code (422 each)', async () => {
      const school = await createSchool();
      // Two admins: the open throttle (5 a minute) counts before validation.
      const admins = [await admin(), await admin()];
      const code = await freshTotp(admins[0]!);
      let i = 0;
      for (const body of [
        { ticketRef: 'T-1', totp: code },
        { reason: 'Looking into fees', totp: code },
        { reason: 'Looking into fees', ticketRef: 'T-1' },
        { reason: 'Looking into fees', ticketRef: 'T-1', totp: '12ab56' },
        { reason: 'Looking into fees', ticketRef: 'x'.repeat(41), totp: code },
        { reason: 'Looking into 35202-1234567-1', ticketRef: 'T-1', totp: code },
      ]) {
        const res = await pPost(`/schools/${school.id}/support-sessions`, admins[i++ % 2]!, body);
        expect(res.status).toBe(422);
      }
      expect(await db().platformSupportSession.count({ where: { schoolId: school.id } })).toBe(0);
    });

    it('needs a fresh second factor: a wrong code and a replayed step are refused (409 TOTP_INVALID)', async () => {
      const a = await admin();
      const [s1, s2] = [await createSchool(), await createSchool()];
      const wrong = String((Number(await totp(a)) + 1) % 1_000_000).padStart(6, '0');
      const refused = await pPost(`/schools/${s1.id}/support-sessions`, a, { reason: 'Fee query', ticketRef: 'T-2', totp: wrong });
      expect(refused.status).toBe(409);
      expect(err(refused).error.code).toBe(ErrorCode.TOTP_INVALID);

      await db().platformUser.update({ where: { id: a.id }, data: { totpLastStep: null } });
      const code = await totp(a);
      const first = await pPost(`/schools/${s1.id}/support-sessions`, a, { reason: 'Fee query', ticketRef: 'T-2', totp: code });
      expect(first.status).toBe(201);
      // The same code again (another school): its step is no longer later than the last accepted.
      const replay = await pPost(`/schools/${s2.id}/support-sessions`, a, { reason: 'Fee query', ticketRef: 'T-3', totp: code });
      expect(replay.status).toBe(409);
      expect(err(replay).error.code).toBe(ErrorCode.TOTP_INVALID);
      expect(await db().platformSupportSession.count({ where: { schoolId: s2.id } })).toBe(0);
    });

    it('opens for support_session_hours, writes both logs and tells every principal', async () => {
      const a = await admin();
      const school = await createSchool();
      const p1 = await principalOf(school);
      const p2 = await principalOf(school);
      const session = await openOk(a, school);
      expect(session).toMatchObject({
        schoolId: school.id.toString(),
        platformUserId: a.id.toString(),
        platformUserEmail: a.email,
        mine: true,
        status: 'open',
        reason: 'Fee screen shows a wrong balance',
        ticketRef: 'TCK-1042',
        endKind: null,
      });
      const { supportSessionHours } = await db().platformSettings.findFirstOrThrow({ where: { id: 1n } });
      expect(new Date(session.expiresAt).getTime() - new Date(session.openedAt).getTime()).toBe(
        supportSessionHours * HOUR_MS,
      );
      const logs = await bothLogs(school.id, 'support_session.opened', session.id);
      expect(logs.platform).toHaveLength(1);
      expect(logs.school).toHaveLength(1);
      expect(logs.platform[0]).toMatchObject({ actorPlatformUserId: a.id, reason: 'Fee screen shows a wrong balance' });
      expect(logs.platform[0]?.metadata).toMatchObject({ ticketRef: 'TCK-1042', principalsNotified: 2 });
      expect(logs.school[0]).toMatchObject({ actorUserId: null, actorPlatformUserId: a.id });
      const sent = await notices(school.id, 'support_session_opened');
      expect(sent.map((m) => m.staffId).sort()).toEqual([p1.user.staffId, p2.user.staffId].sort());
      expect(sent[0]).toMatchObject({
        subjectType: 'support_session',
        subjectId: supportNoticeSubjectId(BigInt(session.id), 'opened'),
      });
      expect(sent[0]?.body).toContain('Fee screen shows a wrong balance');
      // R349's banner: every staff user's /me carries the open session.
      const me = await sGet('/me', p1.session).expect(200);
      expect((me.body as { supportSession: unknown }).supportSession).toEqual({
        id: session.id,
        reason: session.reason,
        expiresAt: session.expiresAt,
      });
    });

    it('a school with no active principal: the session opens, the notice is in the platform log only', async () => {
      const a = await admin();
      const school = await createSchool();
      const session = await openOk(a, school);
      expect(await notices(school.id, 'support_session_opened')).toEqual([]);
      const logs = await bothLogs(school.id, 'support_session.opened', session.id);
      expect(logs.platform[0]?.metadata).toMatchObject({ principalsNotified: 0 });
    });

    it('refuses an unknown school (404) and a terminated one (409 SCHOOL_TERMINATED)', async () => {
      const a = await admin();
      expect((await open(a, { id: 999_999_999n })).status).toBe(404);
      const terminated = await createSchool({ status: 'terminated' });
      const res = await open(a, terminated);
      expect(res.status).toBe(409);
      expect(err(res).error.code).toBe(ErrorCode.SCHOOL_TERMINATED);
    });

    it('one open session per school (409 SUPPORT_SESSION_OPEN with its id)', async () => {
      const [a, b] = [await admin(), await admin()];
      const school = await createSchool();
      const first = await openOk(a, school);
      const res = await open(b, school);
      expect(res.status).toBe(409);
      expect(err(res).error).toMatchObject({ code: ErrorCode.SUPPORT_SESSION_OPEN, details: { sessionId: first.id } });
    });

    it('at most three open per platform user (409 SUPPORT_SESSION_LIMIT)', async () => {
      const a = await admin();
      for (let i = 0; i < 3; i++) await openOk(a, await createSchool());
      const res = await open(a, await createSchool());
      expect(res.status).toBe(409);
      expect(err(res).error.code).toBe(ErrorCode.SUPPORT_SESSION_LIMIT);
    });

    it('expired sessions are closed (and recorded) before anything is counted', async () => {
      const a = await admin();
      const school = await createSchool();
      await principalOf(school);
      const other = await admin();
      const past = new Date(Date.now() - 6 * HOUR_MS);
      // The school's stale session (another admin's) and two of the caller's elsewhere.
      const stale = await insertSession(other.id, school.id, past, new Date(past.getTime() + 4 * HOUR_MS));
      for (let i = 0; i < 2; i++) {
        const s = await createSchool();
        await insertSession(a.id, s.id, past, new Date(past.getTime() + HOUR_MS));
      }
      await openOk(a, await createSchool());
      await openOk(a, await createSchool());
      // Two live, two stale for the caller, and the school's stale one: the third opens.
      const third = await open(a, school);
      expect(third.status).toBe(201);
      const closed = await db().platformSupportSession.findFirstOrThrow({ where: { id: stale.id } });
      expect(closed.endKind).toBe('expired');
      expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(closed.expiresAt.getTime());
      const logs = await bothLogs(school.id, 'support_session.expired', stale.id);
      expect(logs.platform).toHaveLength(1);
      expect(logs.school).toHaveLength(1);
      expect(logs.school[0]).toMatchObject({ actorPlatformUserId: other.id });
      expect(await db().platformSupportSession.count({ where: { platformUserId: a.id, closedAt: null } })).toBe(3);
    });
  });

  // ------------------------------------------------------------------------------- the views

  describe('R350-R352: the support views', () => {
    let w: World;
    let a: Admin;
    let session: Session;
    let bForm: string;
    let guardianCnic: string;
    let studentId: bigint;

    beforeAll(async () => {
      w = await pay.world();
      a = await admin();
      // A paid charge and an advance, so both lists have rows.
      await pay.pay(w, w.office, { studentIds: [w.a.studentId], amount: 4000 });
      const student = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: w.a.studentId } });
      studentId = student.id;
      const extra = await createStudent(db(), w.school, {});
      bForm = extra.bForm ?? '';
      const guardian = await createGuardian(db(), w.school, {});
      guardianCnic = guardian.cnic ?? '';
      await linkGuardian(db(), w.school, extra, guardian);
      session = await openOk(a, w.school);
    });

    const view = (path: string) => pGet(`/support-sessions/${session.id}${path}`, a);

    it('settings: the school and its settings, read-only fields only', async () => {
      const res = await view('/settings').expect(200);
      expect(res.body).toMatchObject({ schoolId: w.school.id.toString(), feeDueDay: expect.any(Number) });
    });

    it('a student by admission number, then the student with guardian names and phones', async () => {
      const student = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: studentId } });
      const list = await view(`/students?admissionNo=${student.admissionNo}`).expect(200);
      const page = list.body as PageOf<{ id: string; fullName: string; current: { className: string } | null }>;
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({ id: studentId.toString(), fullName: 'Hamza Tariq' });
      expect(page.data[0]?.current).not.toBeNull();
      const one = await view(`/students/${studentId}`).expect(200);
      expect(one.body).toMatchObject({
        id: studentId.toString(),
        guardians: [expect.objectContaining({ fullName: 'Tariq Mehmood', isFeePayer: true })],
      });
    });

    it('charges and payments, as amounts, dates, statuses and receipt numbers', async () => {
      const charges = (await view(`/students/${studentId}/charges`).expect(200)).body as PageOf<{
        amount: number;
        paid: number;
        outstanding: number;
        status: string;
      }>;
      expect(charges.total).toBeGreaterThanOrEqual(2);
      expect(charges.data.some((c) => c.paid > 0)).toBe(true);
      const payments = (await view(`/students/${studentId}/payments`).expect(200)).body as PageOf<{
        amount: number;
        forStudent: number;
        receiptNo: number | null;
        status: string;
      }>;
      expect(payments.data[0]).toMatchObject({ amount: 4000, status: 'verified', receiptNo: expect.any(Number) });
      expect(payments.data[0]?.forStudent).toBeGreaterThan(0);
    });

    it("the school's audit log with the audit screen's filters", async () => {
      expect((await view('/audit-log')).status).toBe(422);
      const res = await view(`/audit-log?subjectType=support_session&subjectId=${session.id}`).expect(200);
      const page = res.body as PageOf<{ action: string; actor: { kind: string; name: string } }>;
      expect(page.data.map((e) => e.action)).toContain('support_session.opened');
      expect(page.data.find((e) => e.action === 'support_session.opened')?.actor).toMatchObject({
        kind: 'platform',
        name: 'Platform support',
      });
    });

    it('R350: every read writes support.read to both logs with the session and the subject ids', async () => {
      const before = await bothLogs(w.school.id, 'support.read', session.id);
      await view(`/students/${studentId}/charges`).expect(200);
      const after = await bothLogs(w.school.id, 'support.read', session.id);
      expect(after.platform).toHaveLength(before.platform.length + 1);
      expect(after.school).toHaveLength(before.school.length + 1);
      const ids = await db().charge.findMany({
        where: { schoolId: w.school.id, studentId },
        select: { id: true },
        orderBy: [{ dueOn: 'desc' }, { id: 'desc' }],
        take: 25,
      });
      const expected = { view: 'charges', student: studentId.toString(), charges: ids.map((c) => c.id.toString()).join(',') };
      expect(after.platform.at(-1)?.metadata).toEqual(expected);
      expect(after.school.at(-1)?.metadata).toEqual(expected);
      expect(after.platform.at(-1)).toMatchObject({ actorPlatformUserId: a.id, subjectId: BigInt(session.id) });
      expect(after.school.at(-1)).toMatchObject({ actorUserId: null, actorPlatformUserId: a.id });
      // Each of the six views writes one row in each log.
      const student = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: studentId } });
      for (const path of [
        '/settings',
        `/students?admissionNo=${student.admissionNo}`,
        `/students/${studentId}`,
        `/students/${studentId}/payments`,
        `/audit-log?subjectType=student&subjectId=${studentId}`,
      ]) {
        await view(path).expect(200);
      }
      const all = await bothLogs(w.school.id, 'support.read', session.id);
      expect(all.platform).toHaveLength(after.platform.length + 5);
      expect(all.school).toHaveLength(after.school.length + 5);
      expect(all.school.map((r) => (r.metadata as { view: string }).view).slice(-5)).toEqual([
        'settings',
        'students',
        'student',
        'payments',
        'audit_log',
      ]);
    });

    it('R351: no view carries an identity number, a hash, an object key or a message', async () => {
      const extra = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, bFormHash: { not: null }, NOT: { id: studentId } }, orderBy: { id: 'desc' } });
      const bodies: string[] = [];
      for (const path of [
        '/settings',
        `/students?admissionNo=${extra.admissionNo}`,
        `/students/${extra.id}`,
        `/students/${studentId}`,
        `/students/${studentId}/charges`,
        `/students/${studentId}/payments`,
        `/audit-log?subjectType=support_session&subjectId=${session.id}`,
      ]) {
        bodies.push(JSON.stringify((await view(path).expect(200)).body));
      }
      for (const text of bodies) {
        expect(text).not.toMatch(/[0-9]{13}/);
        expect(text).not.toMatch(/[0-9]{5}-[0-9]{7}-[0-9]/);
        expect(text).not.toContain(bForm);
        expect(text).not.toContain(guardianCnic);
        expect(text).not.toMatch(/"(cnic|cnicHash|bForm|bFormHash|usernameHash|passwordHash|objectKey|body|mediaObjectKey)"/);
      }
      // No route serves files or messages through a session.
      for (const path of ['/messages', `/students/${studentId}/documents`, '/payment-claims', '/payroll']) {
        expect((await view(path)).status).toBe(404);
      }
    });

    it('R351: lists are at most 50 rows', async () => {
      expect((await view(`/students/${studentId}/charges?limit=51`)).status).toBe(422);
      expect((await view(`/students/${studentId}/payments?limit=51`)).status).toBe(422);
      expect((await view(`/audit-log?subjectType=student&subjectId=1&limit=51`)).status).toBe(422);
      const page = (await view(`/students/${studentId}/charges?limit=50`).expect(200)).body as PageOf<unknown>;
      expect(page.limit).toBe(50);
    });

    it("another school's student is 404 through the session", async () => {
      const other = await createSchool();
      const stranger = await createStudent(db(), other, {});
      expect((await view(`/students/${stranger.id}`)).status).toBe(404);
      expect((await view(`/students/${stranger.id}/charges`)).status).toBe(404);
      expect((await view(`/students/${stranger.id}/payments`)).status).toBe(404);
      const list = await view(`/students?admissionNo=${stranger.admissionNo}`).expect(200);
      expect((list.body as PageOf<unknown>).data).toEqual([]);
    });

    it("R352: another admin's session is 404 for the views and for close", async () => {
      const b = await admin();
      expect((await pGet(`/support-sessions/${session.id}/settings`, b)).status).toBe(404);
      expect((await pPost(`/support-sessions/${session.id}/close`, b)).status).toBe(404);
      // The list and the record itself are platform metadata every admin may see.
      const seen = await pGet(`/support-sessions/${session.id}`, b).expect(200);
      expect((seen.body as Session).mine).toBe(false);
      expect((await pGet('/support-sessions/999999999/settings', a)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------- close, revoke, logout

  describe('R349, R352: ending a session', () => {
    it('the owner closes it: both logs, the principals told, the next read 403 closed', async () => {
      const a = await admin();
      const school = await createSchool();
      const p = await principalOf(school);
      const session = await openOk(a, school);
      const res = await pPost(`/support-sessions/${session.id}/close`, a, { reason: 'Ticket resolved' }).expect(200);
      expect(res.body).toMatchObject({ status: 'ended', endKind: 'closed' });
      const logs = await bothLogs(school.id, 'support_session.closed', session.id);
      expect(logs.platform).toHaveLength(1);
      expect(logs.school).toHaveLength(1);
      expect(logs.school[0]?.reason).toBe('Ticket resolved');
      const closed = await notices(school.id, 'support_session_closed');
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        staffId: p.user.staffId,
        subjectId: supportNoticeSubjectId(BigInt(session.id), 'closed'),
      });
      const read = await pGet(`/support-sessions/${session.id}/settings`, a);
      expect(read.status).toBe(403);
      expect(err(read).error).toMatchObject({ code: ErrorCode.SUPPORT_SESSION_ENDED, details: { reason: 'closed' } });
      const again = await pPost(`/support-sessions/${session.id}/close`, a);
      expect(again.status).toBe(403);
      expect(((await sGet('/me', p.session).expect(200)).body as { supportSession: unknown }).supportSession).toBeNull();
    });

    it('the principal lists and revokes it; the next read is 403 revoked', async () => {
      const a = await admin();
      const school = await createSchool();
      const p = await principalOf(school);
      const session = await openOk(a, school);
      expect((await view(a, session, `/audit-log?subjectType=support_session&subjectId=${session.id}`)).status).toBe(200);
      const list = await sGet('/school/support-sessions', p.session).expect(200);
      expect((list.body as PageOf<{ id: string; supportName: string; status: string }>).data[0]).toMatchObject({
        id: session.id,
        supportName: a.email,
        status: 'open',
      });
      // A teacher holds no school.settings.manage.
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const tSession = await createSchoolSession(db(), school, teacher);
      expect((await sPost(`/school/support-sessions/${session.id}/revoke`, tSession, { reason: 'Not agreed' })).status).toBe(403);
      // Another school's principal cannot see or revoke it.
      const otherSchool = await createSchool();
      const otherPrincipal = await principalOf(otherSchool);
      expect((await sPost(`/school/support-sessions/${session.id}/revoke`, otherPrincipal.session, { reason: 'Not ours' })).status).toBe(404);

      const res = await sPost(`/school/support-sessions/${session.id}/revoke`, p.session, { reason: 'Not agreed with us' }).expect(200);
      expect(res.body).toMatchObject({ status: 'ended', endKind: 'revoked', revokeReason: 'Not agreed with us' });
      const logs = await bothLogs(school.id, 'support_session.revoked', session.id);
      expect(logs.school[0]).toMatchObject({ actorUserId: p.user.userId, actorPlatformUserId: null });
      expect(logs.platform[0]).toMatchObject({ actorPlatformUserId: a.id });
      expect(logs.platform[0]?.metadata).toMatchObject({ by: 'school', revokedByUserId: p.user.userId.toString() });
      expect(await notices(school.id, 'support_session_closed')).toHaveLength(1);
      const read = await view(a, session, '/settings');
      expect(read.status).toBe(403);
      expect(err(read).error.details).toEqual({ reason: 'revoked' });
      const twice = await sPost(`/school/support-sessions/${session.id}/revoke`, p.session, { reason: 'Again please' });
      expect(twice.status).toBe(403);
    });

    it('an expired session is 403 expired, and the expiry closes it with both logs and the notice', async () => {
      const a = await admin();
      const school = await createSchool();
      await principalOf(school);
      const past = new Date(Date.now() - 5 * HOUR_MS);
      const row = await insertSession(a.id, school.id, past, new Date(past.getTime() + 4 * HOUR_MS));
      const live = await insertSession(a.id, (await createSchool()).id, new Date(), new Date(Date.now() + HOUR_MS));
      const read = await pGet(`/support-sessions/${row.id}/settings`, a);
      expect(read.status).toBe(403);
      expect(err(read).error.details).toEqual({ reason: 'expired' });

      const sessions = app.get(SupportSessionsService);
      expect(await sessions.expireForSchool(school.id)).toBe(1);
      expect(await sessions.expireForSchool(school.id)).toBe(0);
      const closed = await db().platformSupportSession.findFirstOrThrow({ where: { id: row.id } });
      expect(closed).toMatchObject({ endKind: 'expired' });
      const logs = await bothLogs(school.id, 'support_session.expired', row.id);
      expect(logs.platform).toHaveLength(1);
      expect(logs.school[0]?.metadata).toMatchObject({ job: 'support-session-expire' });
      expect(await notices(school.id, 'support_session_closed')).toHaveLength(1);
      expect((await db().platformSupportSession.findFirstOrThrow({ where: { id: live.id } })).closedAt).toBeNull();
    });

    it('platform logout closes every session the user holds open', async () => {
      const a = await admin();
      const [s1, s2] = [await createSchool(), await createSchool()];
      const first = await openOk(a, s1);
      const second = await openOk(a, s2);
      await pPost('/auth/logout', a).expect(204);
      for (const [school, session] of [[s1, first], [s2, second]] as const) {
        const row = await db().platformSupportSession.findFirstOrThrow({ where: { id: BigInt(session.id) } });
        expect(row.endKind).toBe('closed');
        const logs = await bothLogs(school.id, 'support_session.closed', session.id);
        expect(logs.platform[0]?.metadata).toMatchObject({ via: 'logout' });
        expect(logs.school).toHaveLength(1);
      }
    });

    it('logout closes the support sessions first: a failing close leaves the platform session alive', async () => {
      const a = await admin();
      const school = await createSchool();
      const session = await openOk(a, school);
      const sessions = app.get(SupportSessionsService);
      const spy = jest.spyOn(sessions, 'closeAllForUser').mockRejectedValueOnce(new Error('close failed'));
      try {
        expect((await pPost('/auth/logout', a)).status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      // Still signed in, the support session still open: logging out again finishes the job.
      await pGet('/me', a).expect(200);
      expect((await db().platformSupportSession.findFirstOrThrow({ where: { id: BigInt(session.id) } })).closedAt).toBeNull();
      await pPost('/auth/logout', a).expect(204);
      await pGet('/me', a).expect(401);
      expect((await db().platformSupportSession.findFirstOrThrow({ where: { id: BigInt(session.id) } })).endKind).toBe('closed');
    });

    it('a close that loses the race to a revoke is 403 SUPPORT_SESSION_ENDED revoked, writing nothing (§2.3)', async () => {
      const a = await admin();
      const school = await createSchool();
      const p = await principalOf(school);
      const session = await openOk(a, school);
      // The revoke lands between the close's read and its conditional update. (The repository is
      // provided per module, so the prototype is spied on, not one instance.)
      const realClose = SupportSessionRepository.prototype.close;
      const spy = jest
        .spyOn(SupportSessionRepository.prototype, 'close')
        .mockImplementationOnce(async function (this: SupportSessionRepository, ...args) {
          await sPost(`/school/support-sessions/${session.id}/revoke`, p.session, { reason: 'Not agreed with us' }).expect(200);
          return realClose.apply(this, args);
        });
      try {
        const res = await pPost(`/support-sessions/${session.id}/close`, a, { reason: 'Ticket resolved' });
        expect(res.status).toBe(403);
        expect(err(res).error).toMatchObject({ code: ErrorCode.SUPPORT_SESSION_ENDED, details: { reason: 'revoked' } });
      } finally {
        spy.mockRestore();
      }
      expect((await bothLogs(school.id, 'support_session.closed', session.id)).platform).toHaveLength(0);
      expect((await db().platformSupportSession.findFirstOrThrow({ where: { id: BigInt(session.id) } })).endKind).toBe('revoked');
    });

    it('the expiry stamps closed_at with the time of the write, not the time it was asked for', async () => {
      const a = await admin();
      const school = await createSchool();
      const past = new Date(Date.now() - 6 * HOUR_MS);
      const expiresAt = new Date(past.getTime() + 4 * HOUR_MS);
      const row = await insertSession(a.id, school.id, past, expiresAt);
      const askedFor = new Date(expiresAt.getTime() + 60_000);
      const before = Date.now();
      expect(await app.get(SupportSessionsService).expireForSchool(school.id, askedFor)).toBe(1);
      const closed = await db().platformSupportSession.findFirstOrThrow({ where: { id: row.id } });
      expect(closed.endKind).toBe('expired');
      expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(closed.closedAt!.getTime()).not.toBe(askedFor.getTime());
    });

    it("every staff user's /me carries the open session (office staff)", async () => {
      const a = await admin();
      const school = await createSchool();
      await openOk(a, school);
      const staff = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      const me = await sGet('/me', await createSchoolSession(db(), school, staff)).expect(200);
      expect((me.body as { supportSession: { id: string } | null }).supportSession).not.toBeNull();
    });

    const view = (a: Admin, session: Session, path: string) => pGet(`/support-sessions/${session.id}${path}`, a);
  });

  // --------------------------------------------------------------------- the read-only layers

  describe('R350: a planted write is refused', () => {
    const plantedWrite = (tx: TransactionHost<PrismaTxAdapter>['tx']) =>
      tx.platformAuditLog.create({
        data: { actorPlatformUserId: null, schoolId: null, action: 'login_failure_spike', subjectType: 'school', subjectId: null },
        select: { id: true },
      });

    it('by the query guard while the support flag is set (SUPPORT_WRITE_REFUSED)', async () => {
      const context = app.get(SupportReadContext);
      const txHost = app.get<TransactionHost<PrismaTxAdapter>>(TransactionHost);
      const before = await db().platformAuditLog.count();
      await expect(
        context.run(async () => {
          expect(inSupportContext()).toBe(true);
          // A read passes.
          await txHost.tx.school.findFirst({ select: { id: true } });
          await plantedWrite(txHost.tx);
        }),
      ).rejects.toMatchObject({ status: 403, code: ErrorCode.SUPPORT_WRITE_REFUSED });
      // A raw statement and a write on another client in the same context are refused too.
      await expect(context.run(() => txHost.tx.$executeRaw`SELECT 1`)).rejects.toMatchObject({
        code: ErrorCode.SUPPORT_WRITE_REFUSED,
      });
      // A tagged $queryRaw too: a raw statement is opaque to the guard, whatever it reads.
      await expect(context.run(() => txHost.tx.$queryRaw`SELECT 1`)).rejects.toMatchObject({
        code: ErrorCode.SUPPORT_WRITE_REFUSED,
      });
      await expect(context.run(() => plantedWrite(db()))).rejects.toMatchObject({ code: ErrorCode.SUPPORT_WRITE_REFUSED });
      expect(await db().platformAuditLog.count()).toBe(before);
      expect(inSupportContext()).toBe(false);
    });

    it('by Postgres, the transaction being READ ONLY, when the flag is cleared', async () => {
      const context = app.get(SupportReadContext);
      const cls = app.get(ClsService);
      const txHost = app.get<TransactionHost<PrismaTxAdapter>>(TransactionHost);
      await expect(
        context.run(async () => {
          // A raw statement is refused under the flag, so the mode is read once it is cleared.
          await expect(txHost.tx.$queryRaw`SHOW transaction_read_only`).rejects.toBeInstanceOf(SupportWriteRefusedError);
          cls.set('support', false);
          const [mode] = await txHost.tx.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
          expect(mode?.transaction_read_only).toBe('on');
          await plantedWrite(txHost.tx);
        }),
      ).rejects.toMatchObject({ status: 403, code: ErrorCode.SUPPORT_WRITE_REFUSED });
    });

    it('assertSupportRead admits only reads under the flag', () => {
      for (const op of ['findFirst', 'findMany', 'count', 'aggregate', 'groupBy', 'findUnique']) {
        expect(() => assertSupportRead('Student', op, true)).not.toThrow();
      }
      for (const op of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createManyAndReturn']) {
        expect(() => assertSupportRead('Student', op, true)).toThrow(SupportWriteRefusedError);
        expect(() => assertSupportRead('Student', op, false)).not.toThrow();
      }
      expect(() => assertSupportRead(undefined, '$queryRaw', false)).not.toThrow();
      for (const op of ['$queryRaw', '$executeRaw', '$runCommandRaw', 'findMany']) {
        expect(() => assertSupportRead(undefined, op, true)).toThrow(SupportWriteRefusedError);
      }
    });
  });
});
