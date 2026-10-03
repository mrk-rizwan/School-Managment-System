// Control 4 / R62 for the slice-2 tables (staff, users, sessions, user_tokens, user_roles,
// audit_log), through their repositories; the session repository's one unscoped read (named
// exception 4, raw SQL), the users page query (raw SQL) and the school lookup (exception 2);
// R64 (tokens stored only as hashes); R76 (the guard refuses a session query without schoolId).
import { Test } from '@nestjs/testing';
import { newSessionToken, sha256Hex } from '../../src/common/auth/platform-session';
import { EnvModule } from '../../src/config/env';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { OwnSchoolRepository } from '../../src/repositories/own-school.repository';
import { SchoolLookupRepository } from '../../src/repositories/school-lookup.repository';
import { SessionRepository } from '../../src/repositories/session.repository';
import { StaffRepository } from '../../src/repositories/staff.repository';
import { UserRoleRepository } from '../../src/repositories/user-role.repository';
import { UserTokenRepository } from '../../src/repositories/user-token.repository';
import { UserRepository } from '../../src/repositories/user.repository';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { expectIsolated } from '../support/isolation';
import { createSchoolSession, createSchoolUser, randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, testDb } from '../support/schools';
import { createGuardianUser } from './support';

describe('slice-2 repositories', () => {
  let staff: StaffRepository;
  let users: UserRepository;
  let sessions: SessionRepository;
  let tokens: UserTokenRepository;
  let roles: UserRoleRepository;
  let audit: AuditLogRepository;
  let lookup: SchoolLookupRepository;
  let ownSchool: OwnSchoolRepository;
  let close: () => Promise<void>;
  const db = () => testDb();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
      providers: [
        StaffRepository,
        UserRepository,
        UserTokenRepository,
        UserRoleRepository,
        AuditLogRepository,
        SchoolLookupRepository,
      ],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    staff = moduleRef.get(StaffRepository);
    users = moduleRef.get(UserRepository);
    sessions = moduleRef.get(SessionRepository);
    tokens = moduleRef.get(UserTokenRepository);
    roles = moduleRef.get(UserRoleRepository);
    audit = moduleRef.get(AuditLogRepository);
    lookup = moduleRef.get(SchoolLookupRepository);
    ownSchool = moduleRef.get(OwnSchoolRepository);
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  it('staff: a row written for school A is invisible to school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const digits = randomIdentityDigits();
        return staff.create(schoolId, {
          fullName: 'Isolated Staff',
          cnic: 'v1:k:x:y:z',
          cnicHash: testIdentityHash(digits),
          phone: '+923001234567',
          designation: 'Teacher',
          joinedOn: new Date('2026-01-01T00:00:00Z'),
        });
      },
      read: async (schoolId, id) => {
        const row = await db().staff.findFirst({ where: { schoolId, id } });
        if (!row?.cnicHash) return row;
        return staff.findByCnicHash(schoolId, row.cnicHash);
      },
    });
  });

  it('staff: the same CNIC hash in school B finds nothing', async () => {
    const { a, b } = await createTwoSchools();
    const u = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    expect(await staff.findByCnicHash(a.id, u.usernameHash)).not.toBeNull();
    expect(await staff.findByCnicHash(b.id, u.usernameHash)).toBeNull();
  });

  it('users: invisible and unwritable across schools', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (await createSchoolUser(db(), schoolId === schools.a.id ? schools.a : schools.b, { systemRole: 'teacher' })).userId,
      read: (schoolId, id) => users.find(schoolId, id),
      list: async (schoolId) =>
        (await users.list(schoolId, { sort: 'fullName', skip: 0, take: 50 })).rows,
      write: async (schoolId, id) => {
        const locked = await users.lock(schoolId, id);
        if (!locked) return 0;
        await users.setStatus(schoolId, id, 'disabled');
        return 1;
      },
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
  });

  it('users (raw page query): every sort, filter and page sees only its own school', async () => {
    const { a, b } = await createTwoSchools();
    const own = { a: [] as bigint[], b: [] as bigint[] };
    for (const [key, school] of [['a', a], ['b', b]] as const) {
      own[key].push((await createSchoolUser(db(), school, { systemRole: 'teacher', fullName: 'Shared Name' })).userId);
      own[key].push((await createGuardianUser(db(), school)).userId);
    }
    const sorts = ['fullName', '-fullName', 'lastLoginAt', '-lastLoginAt', 'createdAt', '-createdAt'] as const;
    for (const [key, school] of [['a', a], ['b', b]] as const) {
      for (const sort of sorts) {
        const { rows, total } = await users.list(school.id, { sort, skip: 0, take: 50 });
        expect(rows.map((r) => r.id).sort()).toEqual([...own[key]].sort());
        expect(total).toBe(2);
      }
      const named = await users.list(school.id, { sort: 'fullName', q: 'Shared', skip: 0, take: 50 });
      expect(named.rows.map((r) => r.id)).toEqual([own[key][0]]);
      expect(named.total).toBe(1);
      const guardians = await users.list(school.id, { sort: 'fullName', kind: 'guardian', skip: 0, take: 50 });
      expect(guardians.rows.map((r) => r.id)).toEqual([own[key][1]]);
      expect((await users.list(school.id, { sort: 'fullName', skip: 2, take: 50 })).rows).toEqual([]);
    }
  });

  it('users: by username hash, credentials and access are per school', async () => {
    const { a, b } = await createTwoSchools();
    const u = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    expect(await users.findCredentialsByUsernameHash(a.id, u.usernameHash)).not.toBeNull();
    expect(await users.findCredentialsByUsernameHash(b.id, u.usernameHash)).toBeNull();
    expect(await users.findAccess(b.id, u.userId)).toBeNull();
    expect(await users.findIdentityCiphertext(b.id, u.userId)).toBeNull();
    expect(await users.findIdentityCiphertext(a.id, u.userId)).toMatchObject({ table: 'staff' });
  });

  it('sessions: scoped methods neither see nor revoke another school’s session', async () => {
    const { a, b } = await createTwoSchools();
    const u = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    const s = await createSchoolSession(db(), a, u);
    await sessions.revoke(b.id, s.sessionId, new Date());
    expect(await sessions.revokeAllForUser(b.id, u.userId, new Date())).toBe(0);
    expect(await sessions.countLiveForUser(b.id, u.userId, new Date())).toBe(0);
    expect(await sessions.countLiveForUser(a.id, u.userId, new Date())).toBe(1);
  });

  it('sessions (exception 4): findActiveByTokenHash returns the row with its own school, and only live rows', async () => {
    const { a, b } = await createTwoSchools();
    const ua = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    const ub = await createSchoolUser(db(), b, { systemRole: 'teacher' });
    const sa = await createSchoolSession(db(), a, ua);
    const sb = await createSchoolSession(db(), b, ub, { channel: 'bearer' });
    const hash = sha256Hex;
    const ra = await sessions.findActiveByTokenHash(hash(sa.token));
    const rb = await sessions.findActiveByTokenHash(hash(sb.token));
    expect(ra).toMatchObject({ id: sa.sessionId, schoolId: a.id, userId: ua.userId, channel: 'cookie' });
    expect(rb).toMatchObject({ id: sb.sessionId, schoolId: b.id, userId: ub.userId, channel: 'bearer' });
    const revoked = await createSchoolSession(db(), a, ua, { revokedAt: new Date() });
    const expired = await createSchoolSession(db(), a, ua, { expiresAt: new Date(Date.now() - 1000) });
    expect(await sessions.findActiveByTokenHash(hash(revoked.token))).toBeNull();
    expect(await sessions.findActiveByTokenHash(hash(expired.token))).toBeNull();
    expect(await sessions.findActiveByTokenHash('0'.repeat(64))).toBeNull();
  });

  it('R64: only the token hash is stored', async () => {
    const school = await createSchool();
    const u = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const s = await createSchoolSession(db(), school, u);
    const row = await db().session.findFirst({ where: { schoolId: school.id, id: s.sessionId } });
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(s.token);
  });

  it('R76: the query guard refuses a session read without schoolId', async () => {
    await expect(db().session.findFirst({ where: { tokenHash: '0'.repeat(64) } })).rejects.toThrow(/schoolId/);
  });

  it('user_tokens: consume and void act only inside the token’s school', async () => {
    const { a, b } = await createTwoSchools();
    const u = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    const { tokenHash } = newSessionToken();
    const now = new Date();
    await tokens.create(a.id, { userId: u.userId, purpose: 'password_reset', tokenHash, email: null, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    expect(await tokens.consume(b.id, tokenHash, 'password_reset', new Date())).toBeNull();
    expect(await tokens.voidOutstanding(b.id, u.userId, new Date())).toBe(0);
    expect(await tokens.consume(a.id, tokenHash, 'email_verify', new Date())).toBeNull();
    expect(await tokens.consume(a.id, tokenHash, 'password_reset', new Date())).toEqual({ userId: u.userId, email: null });
    expect(await tokens.consume(a.id, tokenHash, 'password_reset', new Date())).toBeNull();
  });

  it('user_roles: principal counts and checks are per school', async () => {
    const { a, b } = await createTwoSchools();
    const p = await createSchoolUser(db(), a, { systemRole: 'principal' });
    expect(await roles.countActivePrincipals(a.id)).toBe(1);
    expect(await roles.countActivePrincipals(b.id)).toBe(0);
    expect(await roles.hasLivePrincipalRole(b.id, p.userId)).toBe(false);
    expect(await roles.activePrincipalUserIds(b.id)).toEqual([]);
    // A suspended principal does not count (R72).
    await createSchoolUser(db(), a, { systemRole: 'principal', staffStatus: 'suspended' });
    expect(await roles.countActivePrincipals(a.id)).toBe(1);
  });

  it('audit_log: a row written for school A is invisible to school B', async () => {
    const { a, b } = await createTwoSchools();
    const u = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    await audit.record(a.id, { actorUserId: u.userId, action: 'user.email_changed', subjectType: 'user', subjectId: u.userId, metadata: {} });
    expect(await db().auditLog.count({ where: { schoolId: a.id, subjectId: u.userId } })).toBe(1);
    expect(await db().auditLog.count({ where: { schoolId: b.id, subjectId: u.userId } })).toBe(0);
  });

  it('school lookup (exception 2) and own school: by code, and only one’s own row', async () => {
    const { a, b } = await createTwoSchools();
    expect(await lookup.findByCode(a.shortCode)).toEqual({ id: a.id, shortCode: a.shortCode, status: 'active' });
    expect(await lookup.findByCode('nosuchcode')).toBeNull();
    expect((await ownSchool.find(b.id))?.id).toBe(b.id);
    expect((await ownSchool.find(a.id))?.shortCode).toBe(a.shortCode);
  });
});
