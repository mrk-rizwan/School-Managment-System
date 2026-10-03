// LoginService ordering proofs (whole-phase security review F5, and the locked-account timing fix,
// R81 / R2): which dependency runs, and which never runs, on each path through login(). The
// password hasher and the login keys are real; the repositories, the permissions service and the
// lockout are fakes, so each path can be driven exactly and every call observed.
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { PasswordHasher } from '../../src/common/crypto/password';
import { ApiException } from '../../src/common/errors/api-exception';
import { EnvModule } from '../../src/config/env';
import { PermissionsService, type UserAccess } from '../../src/modules/access/permissions.service';
import { LoginKeys, SchoolLoginLockout } from '../../src/modules/auth/login-limits';
import { LoginService } from '../../src/modules/auth/login.service';
import { LoginSpikeRecorder } from '../../src/modules/auth/login-spike.recorder';
import { MeService } from '../../src/modules/auth/me.service';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { SchoolLookupRepository } from '../../src/repositories/school-lookup.repository';
import { UserRepository, type UserCredentialRow } from '../../src/repositories/user.repository';
import { SchoolSessionResolver } from '../../src/tenancy/school-session-resolver';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';

const PASSWORD = 'the-right-password'; // pragma: allowlist secret
const USERNAME = '3520112345671';

describe('LoginService: what runs on each path (F5, R81 / R2)', () => {
  let service: LoginService;
  let hasher: PasswordHasher;
  let school: TestSchool;
  let row: UserCredentialRow;
  let close: () => Promise<void>;

  const lookup = { findByCode: jest.fn() };
  const users = {
    findCredentialsByUsernameHash: jest.fn(),
    lock: jest.fn(),
    recordLogin: jest.fn(),
  };
  const permissions = { load: jest.fn(), hasAnyCapacity: jest.fn() };
  const lockout = {
    isLocked: jest.fn(),
    recordFailure: jest.fn(),
    countSchoolFailure: jest.fn(),
    resetCount: jest.fn(),
  };
  const resolver = { revokePresented: jest.fn() };
  const me = { mint: jest.fn(), build: jest.fn() };
  const audit = { record: jest.fn() };
  const spikes = { record: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
      providers: [
        LoginService,
        PasswordHasher,
        LoginKeys,
        { provide: SchoolLookupRepository, useValue: lookup },
        { provide: UserRepository, useValue: users },
        { provide: PermissionsService, useValue: permissions },
        { provide: SchoolLoginLockout, useValue: lockout },
        { provide: SchoolSessionResolver, useValue: resolver },
        { provide: MeService, useValue: me },
        { provide: AuditLogRepository, useValue: audit },
        { provide: LoginSpikeRecorder, useValue: spikes },
      ],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    service = moduleRef.get(LoginService);
    hasher = moduleRef.get(PasswordHasher);
    // A real school id (a SchoolId is minted, never asserted); nothing else touches the database.
    school = await createSchool();
    row = {
      id: 42n,
      usernameHash: 'h',
      passwordHash: await hasher.hash(PASSWORD),
      status: 'active',
      email: null,
      emailVerifiedAt: null,
      passwordIsDefault: false,
      lastLoginAt: null,
      officeResetAt: null,
      staffId: 7n,
      guardianId: null,
      studentId: null,
    };
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  const access: UserAccess = {
    userId: 42n,
    status: 'active',
    staffId: 7n,
    guardianId: null,
    capacities: { staff: true, guardian: false, student: false },
    systemRoles: ['teacher'],
    systemRoleRows: [],
    customRoles: [],
    grants: [],
    lines: [],
    capabilities: new Set(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    lookup.findByCode.mockResolvedValue({ id: school.id, shortCode: school.shortCode, status: 'active' });
    users.findCredentialsByUsernameHash.mockResolvedValue(row);
    users.lock.mockResolvedValue(row);
    users.recordLogin.mockResolvedValue(undefined);
    permissions.load.mockResolvedValue(access);
    permissions.hasAnyCapacity.mockReturnValue(true);
    lockout.isLocked.mockResolvedValue(false);
    lockout.recordFailure.mockResolvedValue(undefined);
    lockout.countSchoolFailure.mockResolvedValue({ failures: 1, windowStartedAt: '2026-10-03T00:00:00.000Z' });
    lockout.resetCount.mockResolvedValue(undefined);
    resolver.revokePresented.mockResolvedValue(undefined);
    me.mint.mockResolvedValue({ token: 'tok', expiresAt: new Date('2026-11-02T00:00:00.000Z') });
    me.build.mockResolvedValue({ id: '42' });
    audit.record.mockResolvedValue(undefined);
  });

  const req = { headers: {} } as Request;
  const meta = { ip: '203.0.113.9', userAgent: 'jest' };
  const login = (password: string) =>
    service.login({ schoolCode: school.shortCode, username: USERNAME, password }, req, meta);
  const caught = (promise: Promise<unknown>): Promise<ApiException> =>
    promise.then(
      () => {
        throw new Error('expected an ApiException');
      },
      (e: unknown) => {
        if (!(e instanceof ApiException)) throw e;
        return e;
      },
    );

  it('F5: an existing user with a wrong password never has their permissions loaded', async () => {
    const verify = jest.spyOn(hasher, 'verify');
    const error = await caught(login('a-wrong-password'));
    expect(error).toMatchObject({ status: 401, code: 'AUTH_FAILED' });
    expect(verify).toHaveBeenCalledWith(row.passwordHash, 'a-wrong-password');
    expect(permissions.load).not.toHaveBeenCalled();
    expect(lockout.recordFailure).toHaveBeenCalledTimes(1);
    expect(me.mint).not.toHaveBeenCalled();
  });

  it('F5 / R81 / R2: a locked account with the right password gets the dummy verify, AUTH_FAILED, and the lock is not cleared', async () => {
    lockout.isLocked.mockResolvedValue(true);
    const verify = jest.spyOn(hasher, 'verify');
    const dummy = jest.spyOn(hasher, 'verifyDummy');
    const error = await caught(login(PASSWORD));
    expect(error).toMatchObject({ status: 401, code: 'AUTH_FAILED' });
    // verifyDummy calls verify internally against the dummy hash; the user's hash is never checked.
    expect(dummy).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalledWith(row.passwordHash, expect.anything());
    expect(permissions.load).not.toHaveBeenCalled();
    expect(lockout.resetCount).not.toHaveBeenCalled();
    expect(lockout.recordFailure).toHaveBeenCalledTimes(1);
    expect(me.mint).not.toHaveBeenCalled();
  });

  it('F5: a disabled account, or a terminated school, never has permissions loaded even with the right password', async () => {
    users.findCredentialsByUsernameHash.mockResolvedValue({ ...row, status: 'disabled' });
    expect(await caught(login(PASSWORD))).toMatchObject({ status: 401, code: 'AUTH_FAILED' });
    expect(permissions.load).not.toHaveBeenCalled();

    users.findCredentialsByUsernameHash.mockResolvedValue(row);
    lookup.findByCode.mockResolvedValue({ id: school.id, shortCode: school.shortCode, status: 'terminated' });
    expect(await caught(login(PASSWORD))).toMatchObject({ status: 401, code: 'AUTH_FAILED' });
    expect(permissions.load).not.toHaveBeenCalled();
    expect(me.mint).not.toHaveBeenCalled();
  });

  it('F5: an unlocked account with the right password loads permissions once after the verify and before the session is minted', async () => {
    const verify = jest.spyOn(hasher, 'verify');
    const issued = await login(PASSWORD);
    expect(issued.token).toBe('tok');
    expect(verify).toHaveBeenCalledWith(row.passwordHash, PASSWORD);
    // Once on the pre-check, once more under the row lock inside the transaction.
    expect(permissions.load).toHaveBeenCalledTimes(2);
    expect(permissions.load).toHaveBeenNthCalledWith(1, school.id, row.id);
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0] ?? -1;
    const loadFirst = order(permissions.load);
    expect(loadFirst).toBeGreaterThan(order(verify));
    expect(loadFirst).toBeLessThan(order(users.lock));
    expect(loadFirst).toBeLessThan(order(me.mint));
    expect(lockout.resetCount).toHaveBeenCalledTimes(1);
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });
});
