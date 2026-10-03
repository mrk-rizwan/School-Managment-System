import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import {
  newSessionToken,
  PLATFORM_SESSION_LIMITS,
  type PlatformSessionContext,
  type PlatformSessionStage,
} from '../../../common/auth/platform-session';
import { FieldDecryptionError, FieldEncryption } from '../../../common/crypto/field-encryption';
import { PasswordHasher } from '../../../common/crypto/password';
import { failureLog } from '../../../common/errors/failure-log';
import { ApiException } from '../../../common/errors/api-exception';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformSessionRepository } from '../../../repositories/platform/platform-session.repository';
import {
  PlatformUserRepository,
  type PlatformUserRow,
} from '../../../repositories/platform/platform-user.repository';
import type { ChangePlatformPasswordDto, PlatformLoginDto, PlatformMeDto, TotpEnrolmentDto } from './dto';
import { emailKey, LoginLockout } from './login-limits';
import { newTotpSecret, otpauthUri, totpSecretAad, verifyTotp } from './totp';

/** Who is asking, for the session row and for rotation. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  /** SHA-256 of a platform cookie sent with the request, if any: revoked on login (fixation). */
  presentedTokenHash: string | undefined;
}

/** A freshly minted session: the token goes only into the cookie, never into a body. */
export interface IssuedSession {
  token: string;
  me: PlatformMeDto;
}

const authFailed = () =>
  new ApiException(401, ErrorCode.AUTH_FAILED, 'Email, password or code is incorrect.');
const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');
const alreadyEnrolled = () =>
  new ApiException(409, ErrorCode.TOTP_ALREADY_ENROLLED, 'The authenticator is already set up.');

const currentPasswordIncorrect = () =>
  new ApiException(409, ErrorCode.CURRENT_PASSWORD_INCORRECT, 'The current password is incorrect.');

/** Thrown inside the login transaction when the re-check under the row lock fails. */
class LoginRefused extends Error {}

/** Thrown inside the password-change transaction, so the failure is counted after rollback. */
class WrongCurrentPassword extends Error {}

/**
 * Platform admin authentication (contracts/slice-1.md §2, §3). Every refusal at login is the same
 * 401 AUTH_FAILED, so no response distinguishes an unknown email, a wrong password, a wrong or
 * replayed code, a disabled account or a lock.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger('PlatformAuthService');

  constructor(
    private readonly users: PlatformUserRepository,
    private readonly sessions: PlatformSessionRepository,
    private readonly audit: PlatformAuditRepository,
    private readonly hasher: PasswordHasher,
    private readonly cipher: FieldEncryption,
    private readonly lockout: LoginLockout,
  ) {}

  async login(dto: PlatformLoginDto, meta: RequestMeta): Promise<IssuedSession> {
    const key = emailKey(dto.email);
    // Checked first so that Redis being down is a 503 before any work, never a login without it.
    const locked = await this.lockout.isLocked(key);
    const user = await this.users.findByEmail(dto.email);
    // A dummy verification when there is no such user, so timing does not reveal it.
    const passwordOk = user
      ? await this.hasher.verify(user.passwordHash, dto.password)
      : await this.hasher.verifyDummy(dto.password);

    let step: bigint | null = null;
    let ok = user !== null && passwordOk && user.status === 'active' && !locked;
    if (ok && user?.totpEnrolledAt) {
      step = dto.totpCode === undefined ? null : await this.verifyCode(user, dto.totpCode);
      ok = step !== null;
    }
    if (!ok || !user) {
      await this.lockout.recordFailure(key);
      throw authFailed();
    }

    let issued: IssuedSession;
    try {
      issued = await this.completeLogin(user, step, meta);
    } catch (error) {
      if (!(error instanceof LoginRefused)) throw error;
      await this.lockout.recordFailure(key);
      throw authFailed();
    }
    // The login has committed: a Redis failure now must not turn it into a 503 that leaves a live
    // session behind an error. The stale count expires with its key (LOCKOUT.durationMs).
    await this.resetLockoutAfterCommit(key);
    return issued;
  }

  /** Re-checks under the user row lock, records the login and mints the session. */
  @Transactional()
  private async completeLogin(
    checked: PlatformUserRow,
    step: bigint | null,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const user = await this.users.lockById(checked.id);
    // Anything that changed since the unlocked check (password, status, enrolment, a concurrent
    // login with the same code) refuses this attempt.
    if (
      !user ||
      user.status !== 'active' ||
      user.passwordHash !== checked.passwordHash ||
      (user.totpEnrolledAt !== null) !== (step !== null) ||
      (step !== null && user.totpLastStep !== null && step <= user.totpLastStep)
    ) {
      throw new LoginRefused();
    }
    const now = new Date();
    await this.users.recordLogin(user.id, now, step);
    if (meta.presentedTokenHash) await this.sessions.revokeByTokenHash(meta.presentedTokenHash, now);
    const stage: PlatformSessionStage = step === null ? 'totp_enrolment' : 'full';
    const issued = await this.mintSession(user, stage, now, meta);
    await this.audit.record({
      actorPlatformUserId: user.id,
      schoolId: null,
      action: 'platform_user.login',
      subjectType: 'platform_user',
      subjectId: user.id,
      metadata: { stage },
    });
    return issued;
  }

  me(session: PlatformSessionContext): PlatformMeDto {
    return {
      id: session.userId.toString(),
      email: session.email,
      sessionStage: session.stage,
      totpEnrolled: session.totpEnrolled,
      mustChangePassword: session.mustChangePassword,
      sessionExpiresAt: session.expiresAt,
    };
  }

  async logout(session: PlatformSessionContext): Promise<void> {
    await this.sessions.revokeByTokenHash(session.tokenHash, new Date());
  }

  /** A new pending secret; replaces any earlier pending one. Nothing is enrolled until confirm. */
  async enrolTotp(session: PlatformSessionContext): Promise<TotpEnrolmentDto> {
    const user = await this.users.findById(session.userId);
    if (!user) throw authRequired();
    if (user.totpEnrolledAt !== null) throw alreadyEnrolled();
    const secret = newTotpSecret();
    const stored = await this.users.setPendingTotpSecret(
      user.id,
      this.cipher.encrypt(secret, totpSecretAad(user.id)),
    );
    if (!stored) throw alreadyEnrolled();
    return { otpauthUri: otpauthUri(user.email, secret), secret };
  }

  @Transactional()
  async confirmTotp(
    session: PlatformSessionContext,
    code: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const user = await this.users.lockById(session.userId);
    if (!user) throw authRequired();
    if (user.totpEnrolledAt !== null) throw alreadyEnrolled();
    if (user.totpSecret === null) {
      throw new ApiException(409, ErrorCode.TOTP_NOT_ENROLLED, 'Start the authenticator setup first.');
    }
    const step = await this.verifyCode(user, code);
    if (step === null) {
      throw new ApiException(409, ErrorCode.TOTP_INVALID, 'That code is not valid. Try the current one.');
    }
    const now = new Date();
    await this.users.confirmTotp(user.id, step, now);
    await this.sessions.revokeByTokenHash(session.tokenHash, now);
    const issued = await this.mintSession(
      { ...user, totpEnrolledAt: now },
      'full',
      now,
      meta,
    );
    await this.audit.record({
      actorPlatformUserId: user.id,
      schoolId: null,
      action: 'platform_user.totp_enrolled',
      subjectType: 'platform_user',
      subjectId: user.id,
    });
    return issued;
  }

  /**
   * A wrong current password counts toward the email's login lockout, and a locked email is
   * refused as if wrong: a stolen session cookie cannot guess the password without bound.
   */
  async changePassword(
    session: PlatformSessionContext,
    dto: ChangePlatformPasswordDto,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const key = emailKey(session.email);
    if (await this.lockout.isLocked(key)) throw currentPasswordIncorrect();
    // Hashed before the transaction so the row lock is not held across it.
    const newHash = await this.hasher.hash(dto.newPassword);
    let issued: IssuedSession;
    try {
      issued = await this.applyPasswordChange(session, dto.currentPassword, newHash, meta);
    } catch (error) {
      if (!(error instanceof WrongCurrentPassword)) throw error;
      await this.lockout.recordFailure(key);
      throw currentPasswordIncorrect();
    }
    await this.resetLockoutAfterCommit(key);
    return issued;
  }

  /**
   * One transaction with the user row locked (§3.3): verify, replace, revoke every session, rotate.
   * The new session keeps the presented one's absolute expiry: changing the password never
   * extends how long a sign-in lasts.
   */
  @Transactional()
  private async applyPasswordChange(
    session: PlatformSessionContext,
    currentPassword: string,
    newHash: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const user = await this.users.lockById(session.userId);
    if (!user || user.status !== 'active') throw authRequired();
    if (!(await this.hasher.verify(user.passwordHash, currentPassword))) {
      throw new WrongCurrentPassword();
    }
    const now = new Date();
    await this.users.changePassword(user.id, newHash, now);
    // Every session of this user, the presented one included; the caller gets a new one.
    await this.sessions.revokeAllForUser(user.id, now);
    const issued = await this.mintSession(
      { ...user, passwordHash: newHash, mustChangePassword: false },
      'full',
      now,
      meta,
      session.expiresAt,
    );
    await this.audit.record({
      actorPlatformUserId: user.id,
      schoolId: null,
      action: 'platform_user.password_changed',
      subjectType: 'platform_user',
      subjectId: user.id,
    });
    return issued;
  }

  /** The step of a valid, unreplayed code for this user's stored secret; null otherwise. */
  private async verifyCode(user: PlatformUserRow, code: string): Promise<bigint | null> {
    if (user.totpSecret === null) return null;
    let secret: string;
    try {
      secret = this.cipher.decrypt(user.totpSecret, totpSecretAad(user.id));
    } catch (error) {
      if (!(error instanceof FieldDecryptionError)) throw error;
      // A key or data problem, not the user's: logged, and the attempt fails closed.
      this.logger.error({ platformUserId: user.id.toString() }, 'TOTP secret failed to decrypt');
      return null;
    }
    return verifyTotp(secret, code, user.totpLastStep);
  }

  /** Resets the failure count after a committed success; a Redis error is logged, not thrown. */
  private async resetLockoutAfterCommit(key: string): Promise<void> {
    try {
      await this.lockout.reset(key);
    } catch (error) {
      this.logger.warn(failureLog(error), 'lockout reset failed after a committed sign-in');
    }
  }

  /** `expiresAt` defaults to the stage's absolute lifetime from `now`. */
  private async mintSession(
    user: PlatformUserRow,
    stage: PlatformSessionStage,
    now: Date,
    meta: RequestMeta,
    expiresAt: Date = new Date(
      now.getTime() +
        (stage === 'full'
          ? PLATFORM_SESSION_LIMITS.fullAbsoluteMs
          : PLATFORM_SESSION_LIMITS.enrolmentAbsoluteMs),
    ),
  ): Promise<IssuedSession> {
    const { token, tokenHash } = newSessionToken();
    const session = await this.sessions.create({
      platformUserId: user.id,
      tokenHash,
      stage,
      createdAt: now,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      token,
      me: {
        id: user.id.toString(),
        email: user.email,
        sessionStage: session.stage,
        totpEnrolled: user.totpEnrolledAt !== null,
        mustChangePassword: user.mustChangePassword,
        sessionExpiresAt: session.expiresAt,
      },
    };
  }
}
