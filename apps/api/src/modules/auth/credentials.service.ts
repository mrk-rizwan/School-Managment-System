import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { newSessionToken, sha256Hex } from '../../common/auth/platform-session';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { PasswordHasher } from '../../common/crypto/password';
import { failureLog } from '../../common/errors/all-exceptions.filter';
import { ApiException } from '../../common/errors/api-exception';
import { identityHash } from '../../common/identity';
import { ENV, type Env } from '../../config/env';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolLookupRepository, type LookedUpSchool } from '../../repositories/school-lookup.repository';
import { SessionRepository } from '../../repositories/session.repository';
import { UserRepository, type UserCredentialRow } from '../../repositories/user.repository';
import {
  UserTokenRepository,
  type UserTokenPurposeValue,
} from '../../repositories/user-token.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { PermissionsService } from '../access/permissions.service';
import type {
  ChangeEmailDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  MeDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto';
import { LoginKeys, SchoolLoginLockout } from './login-limits';
import { Mailer, type MailMessage } from './mailer';
import { MeService, type IssuedSession, type RequestMeta } from './me.service';

const RESET_TOKEN_MS = 15 * 60_000;
const VERIFY_TOKEN_MS = 24 * 60 * 60_000;

const tokenInvalid = () =>
  new ApiException(409, ErrorCode.TOKEN_INVALID, 'This link is invalid or has expired.');
const currentPasswordIncorrect = () =>
  new ApiException(409, ErrorCode.CURRENT_PASSWORD_INCORRECT, 'The current password is incorrect.');
const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');
const passwordIsUsername = () =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [
      {
        path: 'newPassword',
        code: ErrorCode.INVALID_VALUE,
        message: 'newPassword must not be your username',
      },
    ],
  });

/** What a committed change asks to be mailed; sent only after commit (§3.3, R92). */
type Outbox = MailMessage[];

/**
 * Password and email flows (contract slice-2 §3.3-§3.5, §4.2-§4.3). Credential changes lock the
 * user row and re-check under the lock (R99); tokens are consumed by one conditional update and
 * consumption re-checks that the user is active (R100). Mail goes out after commit, never inside
 * the transaction.
 */
@Injectable()
export class CredentialsService {
  private readonly logger = new Logger('CredentialsService');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly lookup: SchoolLookupRepository,
    private readonly users: UserRepository,
    private readonly tokens: UserTokenRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditLogRepository,
    private readonly permissions: PermissionsService,
    private readonly hasher: PasswordHasher,
    private readonly keys: LoginKeys,
    private readonly lockout: SchoolLoginLockout,
    private readonly mailer: Mailer,
    private readonly me: MeService,
  ) {}

  // ------------------------------------------------------------------------- forgot password

  /**
   * Runs after the 202 has been sent (R2): the response never depends on whether the school,
   * the user or a verified email exists. Never takes an email (R2); mails only a verified
   * address of an active user (R3). Errors are logged, never surfaced.
   */
  async forgotInBackground(dto: ForgotPasswordDto): Promise<void> {
    try {
      const outbox = await this.issueResetToken(dto);
      this.send(outbox);
    } catch (error) {
      this.logger.error(failureLog(error), 'forgot-password failed after the response');
    }
  }

  @Transactional()
  private async issueResetToken(dto: ForgotPasswordDto): Promise<Outbox> {
    const school = await this.lookup.findByCode(dto.schoolCode);
    if (!school || school.status === 'terminated') return [];
    const user = await this.users.findCredentialsByUsernameHash(
      school.id,
      this.keys.usernameHash(dto.username),
    );
    if (!user) return [];
    const locked = await this.users.lock(school.id, user.id);
    if (!locked || locked.status !== 'active' || !locked.email || !locked.emailVerifiedAt) return [];
    const now = new Date();
    await this.tokens.voidOutstanding(school.id, locked.id, now, ['password_reset']);
    const { token, tokenHash } = newSessionToken();
    await this.tokens.create(school.id, {
      userId: locked.id,
      purpose: 'password_reset',
      tokenHash,
      email: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_MS),
    });
    return [
      {
        to: locked.email,
        subject: 'Reset your password',
        text:
          'Someone asked to reset the password of your school account. If it was you, open this ' +
          `link within 15 minutes:\n\n${this.link('reset', school.shortCode, token)}\n\n` +
          'If it was not you, ignore this email; your password has not changed.',
      },
    ];
  }

  // -------------------------------------------------------------------------- reset password

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const school = await this.lookup.findByCode(dto.schoolCode);
    if (!school || school.status === 'terminated') throw tokenInvalid();
    // Hashed before the transaction so the row lock is not held across argon2.
    const newHash = await this.hasher.hash(dto.newPassword);
    const { usernameHash, outbox } = await this.applyReset(school, dto, newHash);
    await this.clearLockout(school.shortCode, usernameHash);
    this.send(outbox);
  }

  @Transactional()
  private async applyReset(
    school: LookedUpSchool,
    dto: ResetPasswordDto,
    newHash: string,
  ): Promise<{ usernameHash: string; outbox: Outbox }> {
    const { user, now } = await this.lockTokenUser(school.id, dto.token, 'password_reset');
    if (this.isUsername(dto.newPassword, user.usernameHash)) throw passwordIsUsername();
    await this.users.setChosenPassword(school.id, user.id, newHash, now);
    await this.sessions.revokeAllForUser(school.id, user.id, now);
    await this.tokens.voidOutstanding(school.id, user.id, now);
    await this.audit.record(school.id, {
      actorUserId: user.id,
      action: 'user.password_reset_by_token',
      subjectType: 'user',
      subjectId: user.id,
      metadata: {},
    });
    return {
      usernameHash: user.usernameHash,
      outbox: user.email ? [this.passwordChangedNotice(user.email)] : [],
    };
  }

  // ---------------------------------------------------------------------------- verify email

  @Transactional()
  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const school = await this.lookup.findByCode(dto.schoolCode);
    if (!school || school.status === 'terminated') throw tokenInvalid();
    const { user, email, now } = await this.lockTokenUser(school.id, dto.token, 'email_verify');
    // Bound to the issued address: a token for an address since replaced verifies nothing.
    if (user.email === null || user.email !== email) throw tokenInvalid();
    await this.users.markEmailVerified(school.id, user.id, now);
    await this.audit.record(school.id, {
      actorUserId: user.id,
      action: 'user.email_verified',
      subjectType: 'user',
      subjectId: user.id,
      metadata: {},
    });
  }

  // ---------------------------------------------------------------------------- change email

  async changeEmail(session: SchoolSessionContext, dto: ChangeEmailDto): Promise<MeDto> {
    const outbox = await this.applyEmailChange(session, dto);
    this.send(outbox);
    const access = await this.permissions.load(session.schoolId, session.access.userId);
    if (!access) throw authRequired();
    return this.me.build(session.schoolId, access.userId, access, session.expiresAt);
  }

  @Transactional()
  private async applyEmailChange(session: SchoolSessionContext, dto: ChangeEmailDto): Promise<Outbox> {
    const { schoolId } = session;
    const user = await this.users.lock(schoolId, session.access.userId);
    if (!user || user.status !== 'active') throw authRequired();
    // The session may have been revoked while this request waited for the lock.
    if (!(await this.sessions.isLive(schoolId, session.sessionId, new Date()))) throw authRequired();
    if (!(await this.hasher.verify(user.passwordHash, dto.currentPassword))) {
      throw currentPasswordIncorrect();
    }
    // Already this address and verified: nothing to do.
    if (user.email === dto.email && user.emailVerifiedAt !== null) return [];
    const now = new Date();
    await this.users.setEmail(schoolId, user.id, dto.email);
    // R93 and contract decision 7: a new address voids earlier verify and reset tokens.
    await this.tokens.voidOutstanding(schoolId, user.id, now);
    const { token, tokenHash } = newSessionToken();
    await this.tokens.create(schoolId, {
      userId: user.id,
      purpose: 'email_verify',
      tokenHash,
      email: dto.email,
      createdAt: now,
      expiresAt: new Date(now.getTime() + VERIFY_TOKEN_MS),
    });
    await this.audit.record(schoolId, {
      actorUserId: user.id,
      action: 'user.email_changed',
      subjectType: 'user',
      subjectId: user.id,
      metadata: {},
    });
    const outbox: Outbox = [
      {
        to: dto.email,
        subject: 'Verify your email address',
        text:
          'Open this link within 24 hours and press "Verify" to confirm this address for your ' +
          `school account:\n\n${this.link('verify-email', session.school.shortCode, token)}`,
      },
    ];
    if (user.email !== null && user.emailVerifiedAt !== null && user.email !== dto.email) {
      outbox.push({
        to: user.email,
        subject: 'Your account email was changed',
        text:
          'The email address on your school account was changed to a different address. If you ' +
          'did not do this, contact your school office.',
      });
    }
    return outbox;
  }

  // ------------------------------------------------------------------------- change password

  async changePassword(
    session: SchoolSessionContext,
    dto: ChangePasswordDto,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const newHash = await this.hasher.hash(dto.newPassword);
    const { issued, outbox } = await this.applyPasswordChange(session, dto, newHash, meta);
    this.send(outbox);
    return issued;
  }

  /**
   * One transaction with the user row locked: verify, replace, revoke every session, rotate.
   * The new session keeps the presented one's absolute expiry.
   */
  @Transactional()
  private async applyPasswordChange(
    session: SchoolSessionContext,
    dto: ChangePasswordDto,
    newHash: string,
    meta: RequestMeta,
  ): Promise<{ issued: IssuedSession; outbox: Outbox }> {
    const { schoolId } = session;
    const user = await this.users.lock(schoolId, session.access.userId);
    if (!user || user.status !== 'active') throw authRequired();
    // The session may have been revoked while this request waited for the lock.
    if (!(await this.sessions.isLive(schoolId, session.sessionId, new Date()))) throw authRequired();
    if (!(await this.hasher.verify(user.passwordHash, dto.currentPassword))) {
      throw currentPasswordIncorrect();
    }
    // R7: no password change without a verified email, so every changed password has a reset path.
    if (user.email === null || user.emailVerifiedAt === null) {
      throw new ApiException(
        409,
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email address before changing your password.',
      );
    }
    if (this.isUsername(dto.newPassword, user.usernameHash)) throw passwordIsUsername();
    const now = new Date();
    await this.users.setChosenPassword(schoolId, user.id, newHash, now);
    await this.sessions.revokeAllForUser(schoolId, user.id, now);
    await this.audit.record(schoolId, {
      actorUserId: user.id,
      action: 'user.password_changed',
      subjectType: 'user',
      subjectId: user.id,
      metadata: {},
    });
    const { token, expiresAt } = await this.me.mint(schoolId, user.id, meta, now, session.expiresAt);
    const access = await this.permissions.load(schoolId, user.id);
    if (!access) throw authRequired();
    return {
      issued: { token, expiresAt, me: await this.me.build(schoolId, user.id, access, expiresAt) },
      outbox: [this.passwordChangedNotice(user.email)],
    };
  }

  // ------------------------------------------------------------------------------- helpers

  /**
   * Token consumption with one lock order everywhere: the user row first, then the token row.
   * Office reset, disable and change-email lock the user and then void tokens; taking the token
   * first here deadlocked against them (40P01). So: read the token's user without locking, lock
   * that user, then consume by the conditional update, which re-checks under the lock that the
   * token is still unused, unexpired and this user's. Any miss, or an inactive user (R100), is
   * TOKEN_INVALID. Must run inside the caller's transaction.
   *
   * `now` is read after the lock is held: voiding sets expires_at to the voider's clock, taken
   * before its commit, so a `now` read before waiting would still see a voided token as live.
   */
  private async lockTokenUser(
    schoolId: SchoolId,
    token: string,
    purpose: UserTokenPurposeValue,
  ): Promise<{ user: UserCredentialRow; email: string | null; now: Date }> {
    const tokenHash = sha256Hex(token);
    const userId = await this.tokens.findUsableUserId(schoolId, tokenHash, purpose, new Date());
    if (userId === null) throw tokenInvalid();
    const user = await this.users.lock(schoolId, userId);
    if (!user || user.status !== 'active') throw tokenInvalid();
    const now = new Date();
    const consumed = await this.tokens.consume(schoolId, tokenHash, purpose, now);
    if (!consumed || consumed.userId !== user.id) throw tokenInvalid();
    return { user, email: consumed.email, now };
  }

  /** Contract §3.4: a 13-digit password equal to the username is refused. */
  private isUsername(password: string, usernameHash: string): boolean {
    return (
      /^[0-9]{13}$/.test(password) &&
      identityHash(password, this.env.IDENTITY_HASH_KEY) === usernameHash
    );
  }

  /** The token travels in the fragment, so it reaches no access log (CLAUDE.md conventions). */
  private link(page: 'reset' | 'verify-email', shortCode: string, token: string): string {
    return `${new URL(this.env.APP_URL).origin}/${page}/${shortCode}#token=${token}`;
  }

  private passwordChangedNotice(to: string): MailMessage {
    return {
      to,
      subject: 'Your password was changed',
      text:
        'The password of your school account was just changed. If you did not do this, contact ' +
        'your school office.',
    };
  }

  /** Fire and forget: Mailer.send never rejects and retries on its own (R92). */
  private send(outbox: Outbox): void {
    for (const message of outbox) void this.mailer.send(message);
  }

  /** After a committed reset; a Redis failure is logged, not thrown (the reset stands). */
  private async clearLockout(shortCode: string, usernameHash: string): Promise<void> {
    try {
      await this.lockout.clear(this.keys.account(shortCode, usernameHash));
    } catch (error) {
      this.logger.warn(failureLog(error), 'lockout clear failed after a committed reset');
    }
  }
}
