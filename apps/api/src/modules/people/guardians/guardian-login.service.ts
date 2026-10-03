import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { PasswordHasher } from '../../../common/crypto/password';
import { ApiException } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { identityHash } from '../../../common/identity';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { GuardianLoginRepository } from '../../../repositories/guardian-login.repository';
import { UserRepository, type UserCredentialRow } from '../../../repositories/user.repository';
import { PermissionsService } from '../../access/permissions.service';
import type { UserDto } from '../../users/users.dto';
import { toUserDto } from '../../users/users.service';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { cnicAad, guardianMerged, GuardiansService } from './guardians.service';

// POST /guardians/:id/issue-login (contracts/slice-5.md §3.7; R21, R22, R27, R77). The username
// is the guardian's CNIC, stored only as its HMAC; the default password is the same digits.

const GUARDIAN_ID_UNIQUE = 'users_school_id_guardian_id_key';
const USERNAME_UNIQUE = 'users_school_id_username_hash_key';

const loginExists = () =>
  new ApiException(409, ErrorCode.LOGIN_ALREADY_EXISTS, 'This guardian already has a login.');
const denied = (reason: 'target_is_principal' | 'target_exceeds_actor') =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    'You do not have permission to change this account.',
    { reason },
  );

@Injectable()
export class GuardianLoginService {
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly guardians: GuardiansService,
    private readonly logins: GuardianLoginRepository,
    private readonly users: UserRepository,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    private readonly passwords: PasswordHasher,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  /**
   * R77: a unique violation aborts the transaction, so it is caught here, outside it. The
   * guardian gained a login meanwhile → LOGIN_ALREADY_EXISTS; the username was taken by another
   * user (say a staff login issued at the same moment) → once more, which now takes the link path.
   */
  async issueLogin(guardianId: bigint): Promise<UserDto> {
    const actor = this.context.actor();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.issueInTransaction(actor, guardianId);
      } catch (error) {
        const constraint = summariseDatabaseError(error)?.constraint;
        if (constraint === GUARDIAN_ID_UNIQUE) throw loginExists();
        if (constraint === USERNAME_UNIQUE && attempt === 0) continue;
        throw error;
      }
    }
  }

  @Transactional()
  private async issueInTransaction(actor: Actor, guardianId: bigint): Promise<UserDto> {
    const { schoolId } = actor;
    // Preconditions in contract order, on the locked row: racing issue-logins queue here.
    const guardian = await this.guardians.lock(schoolId, guardianId);
    if (guardian.status === 'merged') throw guardianMerged();
    if (guardian.cnic === null) {
      throw new ApiException(
        409,
        ErrorCode.GUARDIAN_CNIC_MISSING,
        'A login needs the guardian’s CNIC: it is the username.',
      );
    }
    if (guardian.userId !== null) throw loginExists();
    this.assertLoginLink();

    const digits = this.encryption.decrypt(guardian.cnic, cnicAad(schoolId));
    const usernameHash = identityHash(digits, this.hashKey);
    const found = await this.users.findCredentialsByUsernameHash(schoolId, usernameHash);
    // R99: the existing user is locked and read again before anything is decided about it.
    const existing = found && (await this.users.lock(schoolId, found.id));

    let userId: bigint;
    if (existing) {
      // R22: the person already has a login (a teacher who is also a parent): link, never a second.
      await this.assertMayChange(actor, existing);
      if ((await this.logins.linkGuardian(schoolId, existing.id, guardianId)) !== 1) {
        // Already linked to another guardian record: the same person entered twice.
        throw loginExists();
      }
      userId = existing.id;
    } else {
      userId = await this.logins.createGuardianUser(schoolId, {
        usernameHash,
        passwordHash: await this.passwords.hash(digits),
        guardianId,
      });
    }

    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'user.login_issued',
      subjectType: 'user',
      subjectId: userId,
      metadata: { capacity: 'guardian', linkedExistingUser: existing !== null },
    });
    const user = await this.users.find(schoolId, userId);
    if (!user) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toUserDto(user);
  }

  /**
   * Slice 6 adds: no live student_guardians link with can_login → 409 GUARDIAN_NO_LOGIN_LINK.
   * Until then the CNIC is the only precondition (contract §3.7 step 4).
   */
  private assertLoginLink(): void {}

  /** Target rules on the existing user: USER_DISABLED, then contracts/slice-2.md §5.3 (R10, R12, R14). */
  private async assertMayChange(actor: Actor, target: UserCredentialRow): Promise<void> {
    if (target.status === 'disabled') {
      throw new ApiException(409, ErrorCode.USER_DISABLED, 'That login is disabled.');
    }
    if (target.id === actor.userId) {
      throw new ApiException(
        409,
        ErrorCode.SELF_ACTION_FORBIDDEN,
        'You cannot issue a login to your own account.',
      );
    }
    const actorAccess = await this.permissions.load(actor.schoolId, actor.userId);
    const targetAccess = await this.permissions.load(actor.schoolId, target.id);
    if (!actorAccess || !targetAccess) throw denied('target_exceeds_actor');
    if (this.permissions.holds(actorAccess, Capability.ROLE_MANAGE)) return;
    if (targetAccess.systemRoles.includes('principal')) throw denied('target_is_principal');
    if (!this.permissions.isSubset(targetAccess, actorAccess)) throw denied('target_exceeds_actor');
  }
}
