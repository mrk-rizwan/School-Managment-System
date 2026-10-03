import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, LOGIN_ISSUED_REASONS, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { PasswordHasher } from '../../../common/crypto/password';
import { ApiException } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { identityHash } from '../../../common/identity';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { SessionRepository } from '../../../repositories/session.repository';
import { UserRoleRepository } from '../../../repositories/user-role.repository';
import { UserTokenRepository } from '../../../repositories/user-token.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { PermissionsService } from '../../access/permissions.service';
import type { UserDto } from '../../users/users.dto';
import { toUserDto } from '../../users/users.service';
import { resetOnStaffLink } from './reset-on-staff-link';
import type { IssueStaffLoginDto } from './staff.dto';
import { denied, loginExists, selfForbidden, staffNotActive } from './staff.errors';
import { StaffService } from './staff.service';

// POST /staff/:id/issue-login (contracts/slice-4.md §3.6; R13, R21, R22, R77, R99). The username
// is the staff member's CNIC, stored only as its HMAC; the default password is the same digits.

const STAFF_ID_UNIQUE = 'users_school_id_staff_id_key';
const USERNAME_UNIQUE = 'users_school_id_username_hash_key';

const conflict = (code: ErrorCode, message: string) => new ApiException(409, code, message);

@Injectable()
export class StaffLoginService {
  private readonly hashKey: string;

  constructor(
    private readonly staffService: StaffService,
    private readonly users: UserRepository,
    private readonly roles: UserRoleRepository,
    private readonly sessions: SessionRepository,
    private readonly tokens: UserTokenRepository,
    private readonly audit: AuditLogRepository,
    private readonly permissions: PermissionsService,
    private readonly passwords: PasswordHasher,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  /**
   * R77: a unique violation aborts the transaction, so it is caught here, outside it. The staff
   * row gained a login meanwhile → LOGIN_ALREADY_EXISTS; the username was taken by another user
   * (a guardian login issued at the same moment) → once more, which now takes the link path.
   */
  async issueLogin(
    session: SchoolSessionContext,
    staffId: bigint,
    dto: IssueStaffLoginDto,
  ): Promise<UserDto> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.issueInTransaction(session, staffId, dto);
      } catch (error) {
        const constraint = summariseDatabaseError(error)?.constraint;
        if (constraint === STAFF_ID_UNIQUE) throw loginExists();
        if (constraint === USERNAME_UNIQUE && attempt === 0) continue;
        throw error;
      }
    }
  }

  @Transactional()
  private async issueInTransaction(
    session: SchoolSessionContext,
    staffId: bigint,
    dto: IssueStaffLoginDto,
  ): Promise<UserDto> {
    const { schoolId, access: actor } = session;
    // Preconditions in contract order, on the locked row: racing issue-logins queue here.
    const staff = await this.staffService.lock(schoolId, staffId);
    if (staff.status !== 'active') throw staffNotActive();
    const digits = this.staffService.cnicDigits(schoolId, staff);
    if (digits === null) {
      throw conflict(
        ErrorCode.IDENTITY_NUMBER_MISSING,
        'A login needs the staff member’s CNIC: it is the username.',
      );
    }
    if (staff.userId !== null) throw loginExists();
    // R13: a role whose defaults exceed the caller's set needs role.manage (so principal always does).
    if (
      !this.permissions.holds(actor, Capability.ROLE_MANAGE) &&
      !SYSTEM_ROLE_DEFAULTS[dto.systemRole].every((key) => actor.capabilities.has(key))
    ) {
      throw denied('role_exceeds_actor');
    }

    const usernameHash = identityHash(digits, this.hashKey);
    const defaultHash = await this.passwords.hash(digits);
    const found = await this.users.findCredentialsByUsernameHash(schoolId, usernameHash);
    // R99: the existing user is locked and read again before anything is decided about it.
    const existing = found && (await this.users.lock(schoolId, found.id));
    const now = new Date();

    let userId: bigint;
    if (existing) {
      // R22: the person already has a login (a parent who is also a teacher): link, never a second.
      if (existing.id === actor.userId) throw selfForbidden();
      if (existing.status === 'disabled') {
        throw conflict(ErrorCode.USER_DISABLED, 'The existing login with this CNIC is disabled.');
      }
      if (existing.studentId !== null) {
        throw conflict(ErrorCode.USERNAME_IN_USE, 'This CNIC is already the username of a student login.');
      }
      if (existing.staffId !== null) throw loginExists();
      if (dto.confirmLinkExisting !== true) {
        throw conflict(
          ErrorCode.LINK_EXISTING_LOGIN_UNCONFIRMED,
          'A login with this CNIC already exists at the school. Confirm to link it: its password ' +
            'returns to the default, its email is cleared and it is signed out everywhere.',
        );
      }
      userId = existing.id;
      await this.users.linkStaff(schoolId, userId, staffId);
      const { users, sessions, tokens, audit } = this;
      await resetOnStaffLink({ users, sessions, tokens, audit }, schoolId, userId, {
        defaultHash,
        now,
        actor: { actorUserId: actor.userId },
        capacity: dto.systemRole,
      });
    } else {
      userId = await this.users.create(schoolId, { usernameHash, passwordHash: defaultHash, staffId });
    }

    await this.roles.assign(schoolId, {
      userId,
      role: { kind: 'system', systemRole: dto.systemRole },
      assignedBy: actor.userId,
      now,
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'user.login_issued',
      subjectType: 'user',
      subjectId: userId,
      reason: dto.reason ?? LOGIN_ISSUED_REASONS.staff,
      metadata: {
        capacity: 'staff',
        systemRole: dto.systemRole,
        linkedExistingUser: existing !== null,
      },
    });
    const user = await this.users.find(schoolId, userId);
    if (!user) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toUserDto(user);
  }
}
