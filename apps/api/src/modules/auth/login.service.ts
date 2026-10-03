import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import { PasswordHasher } from '../../common/crypto/password';
import { failureLog } from '../../common/errors/all-exceptions.filter';
import { ApiException } from '../../common/errors/api-exception';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolLookupRepository } from '../../repositories/school-lookup.repository';
import { UserRepository, type UserCredentialRow } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { SchoolSessionResolver } from '../../tenancy/school-session-resolver';
import { PermissionsService } from '../access/permissions.service';
import type { SchoolLoginDto } from './dto';
import { LoginKeys, SchoolLoginLockout, SPRAY } from './login-limits';
import { LoginSpikeRecorder } from './login-spike.recorder';
import { MeService, type IssuedSession, type RequestMeta } from './me.service';

const authFailed = () =>
  new ApiException(401, ErrorCode.AUTH_FAILED, 'School code, username or password is incorrect.');

/** Thrown inside the login transaction when the re-check under the row lock fails. */
class LoginRefused extends Error {}

/**
 * School login (contract slice-2 §3.1, R1, R11, R81). Every refusal is the same 401 AUTH_FAILED,
 * counted against the lockout of the typed school code and username, so no response tells an
 * absent school, an absent user, a wrong password, a lock, a disabled account, a user with no
 * capacity or a terminated school apart.
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger('SchoolLoginService');

  constructor(
    private readonly lookup: SchoolLookupRepository,
    private readonly users: UserRepository,
    private readonly permissions: PermissionsService,
    private readonly hasher: PasswordHasher,
    private readonly keys: LoginKeys,
    private readonly lockout: SchoolLoginLockout,
    private readonly resolver: SchoolSessionResolver,
    private readonly me: MeService,
    private readonly audit: AuditLogRepository,
    private readonly spikes: LoginSpikeRecorder,
  ) {}

  async login(dto: SchoolLoginDto, req: Request, meta: RequestMeta): Promise<IssuedSession> {
    const usernameHash = this.keys.usernameHash(dto.username);
    const account = this.keys.account(dto.schoolCode, usernameHash);
    // First, so an unreachable Redis is a 503 before any work, never a login without it (R81).
    const locked = await this.lockout.isLocked(account);
    // R1: the school whose code was typed, then the user inside it, never a "first match".
    const school = await this.lookup.findByCode(dto.schoolCode);
    const user = school
      ? await this.users.findCredentialsByUsernameHash(school.id, usernameHash)
      : null;
    // A locked account gets the dummy verify, so its timing says nothing about the password.
    const passwordOk =
      user && !locked
        ? await this.hasher.verify(user.passwordHash, dto.password)
        : await this.hasher.verifyDummy(dto.password);
    // Only after the password verifies (F5): loading permissions for any existing user would make
    // an existing username measurably slower than an absent one.
    // Also only for a live account in a live school: otherwise a correct password on a disabled
    // account would answer measurably slower than a wrong one.
    const access =
      school &&
      school.status !== 'terminated' &&
      user &&
      user.status === 'active' &&
      passwordOk &&
      !locked
        ? await this.permissions.load(school.id, user.id)
        : null;

    const ok =
      school !== null &&
      school.status !== 'terminated' &&
      user !== null &&
      user.status === 'active' &&
      access !== null &&
      this.permissions.hasAnyCapacity(access) &&
      passwordOk &&
      !locked;
    if (!ok || !school || !user || !access) {
      await this.fail(account, school?.id ?? null);
      throw authFailed();
    }

    let issued: IssuedSession;
    try {
      issued = await this.complete(school.id, user, req, meta);
    } catch (error) {
      if (!(error instanceof LoginRefused)) throw error;
      await this.fail(account, school.id);
      throw authFailed();
    }
    // Committed: a Redis failure now must not turn a live session into a 503.
    try {
      await this.lockout.resetCount(account);
    } catch (error) {
      this.logger.warn(failureLog(error), 'lockout reset failed after a committed sign-in');
    }
    return issued;
  }

  /** Re-checks under the user row lock, records the login and mints the session. */
  @Transactional()
  private async complete(
    schoolId: SchoolId,
    checked: UserCredentialRow,
    req: Request,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const user = await this.users.lock(schoolId, checked.id);
    const access = user ? await this.permissions.load(schoolId, user.id) : null;
    if (
      !user ||
      !access ||
      user.status !== 'active' ||
      user.passwordHash !== checked.passwordHash ||
      !this.permissions.hasAnyCapacity(access)
    ) {
      throw new LoginRefused();
    }
    const now = new Date();
    await this.resolver.revokePresented(req, now);
    // Read before recordLogin overwrites last_login_at (contract §3.1 step 5).
    const afterOfficeReset =
      user.officeResetAt !== null &&
      (user.lastLoginAt === null || user.lastLoginAt < user.officeResetAt);
    await this.users.recordLogin(schoolId, user.id, now);
    // Every sign-in on the default password (the CNIC digits, which colleagues may know) is
    // audited, whatever made it default; an office reset always leaves it default.
    if (user.passwordIsDefault) {
      await this.audit.record(schoolId, {
        actorUserId: user.id,
        action: 'user.login_on_default_password',
        subjectType: 'user',
        subjectId: user.id,
        metadata: { afterOfficeReset },
      });
    }
    const { token, expiresAt } = await this.me.mint(schoolId, user.id, meta, now);
    return { token, expiresAt, me: await this.me.build(schoolId, user.id, access, expiresAt) };
  }

  /**
   * Counts a failure toward the account lockout and, for a school that exists, toward the
   * school's spray window (contract §3.1 step 6). Spraying many CNICs never trips a per-account
   * lock, so the platform sees it instead.
   */
  private async fail(account: string, schoolId: SchoolId | null): Promise<void> {
    await this.lockout.recordFailure(account);
    if (schoolId === null) return;
    const now = new Date();
    const { failures, windowStartedAt } = await this.lockout.countSchoolFailure(schoolId, now);
    if (failures === SPRAY.threshold) await this.spikes.record(schoolId, failures, windowStartedAt);
  }
}

