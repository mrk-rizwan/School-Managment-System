import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { FieldDecryptionError, FieldEncryption } from '../../common/crypto/field-encryption';
import { PasswordHasher } from '../../common/crypto/password';
import { failureLog } from '../../common/errors/failure-log';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SessionRepository } from '../../repositories/session.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import { UserTokenRepository } from '../../repositories/user-token.repository';
import {
  UserRepository,
  type UserCredentialRow,
  type UserRecord,
  type UserStatusValue,
} from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { PermissionsService } from '../access/permissions.service';
import { LoginKeys, SchoolLoginLockout } from '../auth/login-limits';
import { Mailer, type MailMessage } from '../auth/mailer';
import type { ListUsersQueryDto, OfficeResetDto, ReasonDto, UserDto } from './users.dto';
import { identityAad } from '../../common/identity';

/** `alice@example.com` → `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id.toString(),
    staffId: user.staffId?.toString() ?? null,
    guardianId: user.guardianId?.toString() ?? null,
    studentId: user.studentId?.toString() ?? null,
    fullName: user.fullName,
    systemRoles: user.systemRoles,
    customRoleNames: user.customRoleNames,
    status: user.status,
    emailMasked: user.email === null ? null : maskEmail(user.email),
    hasEmail: user.email !== null,
    hasVerifiedEmail: user.emailVerifiedAt !== null,
    passwordIsDefault: user.passwordIsDefault,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * The office's user-account administration (contract slice-2 §5). Every action locks the target
 * row and checks, in order: not oneself (R10), a principal target needs role.manage (R12), and
 * without role.manage the target's effective set must be within the caller's (R14).
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger('UsersService');

  constructor(
    private readonly users: UserRepository,
    private readonly roles: UserRoleRepository,
    private readonly sessions: SessionRepository,
    private readonly tokens: UserTokenRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly permissions: PermissionsService,
    private readonly hasher: PasswordHasher,
    private readonly cipher: FieldEncryption,
    private readonly keys: LoginKeys,
    private readonly lockout: SchoolLoginLockout,
    private readonly mailer: Mailer,
  ) {}

  async list(schoolId: SchoolId, query: ListUsersQueryDto): Promise<Page<UserDto>> {
    const { rows, total } = await this.users.list(schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.passwordIsDefault === undefined ? {} : { passwordIsDefault: query.passwordIsDefault }),
      ...(query.hasEmail === undefined ? {} : { hasEmail: query.hasEmail }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'fullName',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toUserDto), query, total);
  }

  async get(schoolId: SchoolId, id: bigint): Promise<UserDto> {
    const user = await this.users.find(schoolId, id);
    if (!user) throw notFound();
    return toUserDto(user);
  }

  // ---------------------------------------------------------------------------- office reset

  async officeReset(session: SchoolSessionContext, id: bigint, dto: OfficeResetDto): Promise<UserDto> {
    const { user, outbox } = await this.applyOfficeReset(session, id, dto);
    // After commit (R4): the lockout of the school code and username is cleared.
    try {
      await this.lockout.clear(this.keys.account(session.school.shortCode, user.usernameHash));
    } catch (error) {
      this.logger.warn(failureLog(error), 'lockout clear failed after a committed office reset');
    }
    for (const message of outbox) void this.mailer.send(message);
    return this.get(session.schoolId, id);
  }

  @Transactional()
  private async applyOfficeReset(
    session: SchoolSessionContext,
    id: bigint,
    dto: OfficeResetDto,
  ): Promise<{ user: UserCredentialRow; outbox: MailMessage[] }> {
    const { schoolId } = session;
    const target = await this.lockTarget(session, id);
    const digits = await this.defaultPassword(schoolId, target.id);
    const now = new Date();
    await this.users.setDefaultPassword(
      schoolId,
      target.id,
      await this.hasher.hash(digits),
      now,
      dto.clearEmail,
    );
    // R5: every session and every outstanding token of the target ends now. Status untouched (R6).
    await this.sessions.revokeAllForUser(schoolId, target.id, now);
    await this.tokens.voidOutstanding(schoolId, target.id, now);
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'user.office_reset',
      subjectType: 'user',
      subjectId: target.id,
      reason: dto.reason,
      metadata: { clearEmail: dto.clearEmail },
    });
    const keptVerified = !dto.clearEmail && target.email !== null && target.emailVerifiedAt !== null;
    return {
      user: target,
      outbox:
        keptVerified && target.email !== null
          ? [
              {
                to: target.email,
                subject: 'Your password was reset by the school office',
                text:
                  'The school office reset the password of your school account to its default. ' +
                  'Sign in and choose a new password. If you did not ask for this, contact the office.',
              },
            ]
          : [],
    };
  }

  /**
   * The default password: the decrypted 13 digits of the linked identity number, staff CNIC,
   * guardian CNIC or student B-Form (contract §5.4).
   */
  private async defaultPassword(schoolId: SchoolId, userId: bigint): Promise<string> {
    const missing = () =>
      new ApiException(
        409,
        ErrorCode.IDENTITY_NUMBER_MISSING,
        'This account has no identity number on record to reset to.',
      );
    const found = await this.users.findIdentityCiphertext(schoolId, userId);
    if (!found) throw missing();
    try {
      const digits = this.cipher.decrypt(found.ciphertext, identityAad(schoolId, found));
      if (!/^[0-9]{13}$/.test(digits)) throw missing();
      return digits;
    } catch (error) {
      if (!(error instanceof FieldDecryptionError)) throw error;
      this.logger.error({ userId: userId.toString() }, 'identity number failed to decrypt');
      throw missing();
    }
  }

  // ------------------------------------------------------------------------ disable / enable

  async disable(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<UserDto> {
    await this.applyStatus(session, id, 'disabled', dto.reason);
    return this.get(session.schoolId, id);
  }

  async enable(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<UserDto> {
    await this.applyStatus(session, id, 'active', dto.reason);
    return this.get(session.schoolId, id);
  }

  @Transactional()
  private async applyStatus(
    session: SchoolSessionContext,
    id: bigint,
    status: UserStatusValue,
    reason: string,
  ): Promise<void> {
    const { schoolId } = session;
    const target = await this.lockTarget(session, id);
    if (target.status === status) return;
    const now = new Date();
    if (status === 'disabled') {
      // R72 / R73: the settings row serialises every path that could remove the last principal.
      await this.settings.lock(schoolId);
      if (
        (await this.roles.hasLivePrincipalRole(schoolId, target.id)) &&
        (await this.roles.countActivePrincipals(schoolId, target.id)) === 0
      ) {
        throw new ApiException(
          409,
          ErrorCode.LAST_PRINCIPAL,
          'This is the school’s only active principal and cannot be disabled.',
        );
      }
      await this.users.setStatus(schoolId, target.id, 'disabled');
      // R9, R100: access ends at once.
      await this.sessions.revokeAllForUser(schoolId, target.id, now);
      await this.tokens.voidOutstanding(schoolId, target.id, now);
    } else {
      await this.users.setStatus(schoolId, target.id, 'active');
    }
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: status === 'disabled' ? 'user.disabled' : 'user.enabled',
      subjectType: 'user',
      subjectId: target.id,
      reason,
      metadata: {},
    });
  }

  // -------------------------------------------------------------------- sign out everywhere

  /**
   * contracts/slice-9.md §3.7 (R169): the target's every live session, any channel, ends; their
   * devices die by the push join. Password, email, tokens and status are untouched. Refusals as
   * office reset (R10, R12, R14). Audited only when something was revoked.
   */
  @Transactional()
  async signOutEverywhere(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReasonDto,
  ): Promise<{ revoked: number }> {
    const { schoolId } = session;
    const target = await this.lockTarget(session, id);
    const revoked = await this.sessions.revokeAllForUser(schoolId, target.id, new Date());
    if (revoked > 0) {
      await this.audit.record(schoolId, {
        actorUserId: session.access.userId,
        action: 'user.signed_out_everywhere',
        subjectType: 'user',
        subjectId: target.id,
        reason: dto.reason,
        metadata: { revoked },
      });
    }
    return { revoked };
  }

  // -------------------------------------------------------------------------- target rules

  /** Locks the target user row (R99), then applies contract §5.3 in order. */
  private async lockTarget(session: SchoolSessionContext, id: bigint): Promise<UserCredentialRow> {
    const { schoolId, access: actor } = session;
    const target = await this.users.lock(schoolId, id);
    if (!target) throw notFound();
    if (target.id === actor.userId) {
      throw new ApiException(
        409,
        ErrorCode.SELF_ACTION_FORBIDDEN,
        'You cannot do this to your own account.',
      );
    }
    if (this.permissions.holds(actor, Capability.ROLE_MANAGE)) return target;
    if (await this.roles.hasLivePrincipalRole(schoolId, target.id)) {
      throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only a principal can do this to a principal.', {
        reason: 'target_is_principal',
      });
    }
    const targetAccess = await this.permissions.load(schoolId, target.id);
    if (targetAccess && !this.permissions.isSubset(targetAccess, actor)) {
      throw new ApiException(
        403,
        ErrorCode.PERMISSION_DENIED,
        'This account holds permissions you do not hold.',
        { reason: 'target_exceeds_actor' },
      );
    }
    return target;
  }
}
