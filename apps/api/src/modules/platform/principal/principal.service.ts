import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { PasswordHasher } from '../../../common/crypto/password';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { identityHash, staffCnicAad } from '../../../common/identity';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { UserRoleRepository } from '../../../repositories/user-role.repository';
import { SessionRepository } from '../../../repositories/session.repository';
import { UserTokenRepository } from '../../../repositories/user-token.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { fromPlatformSchool } from '../../../tenancy/school-id.mint';
import { todayIn } from '../../../common/school-clock';
import { Mailer, type MailMessage } from '../../auth/mailer';
import { resetOnStaffLink } from '../../people/staff/reset-on-staff-link';
import type { IssuedPrincipalLoginDto, IssuePrincipalLoginDto } from './principal.dto';

const conflict = (code: ErrorCode, message: string) => new ApiException(409, code, message);

/**
 * The platform issuing a school's principal login (contract slice-2 §7; CLAUDE.md exception 1,
 * the second of the platform's two operations inside a school). The SchoolId comes only from the
 * school row locked by SchoolRepository.lockForPrincipalIssue, never from the route parameter.
 * The school row lock serialises racing issues for one school, so the loser gets a refusal
 * (ALREADY_PRINCIPAL or ACTIVE_PRINCIPAL_EXISTS), never a unique-constraint 500 (R77).
 */
@Injectable()
export class PrincipalLoginService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly schools: SchoolRepository,
    private readonly staff: StaffRepository,
    private readonly users: UserRepository,
    private readonly roles: UserRoleRepository,
    private readonly sessions: SessionRepository,
    private readonly tokens: UserTokenRepository,
    private readonly audit: AuditLogRepository,
    private readonly platformAudit: PlatformAuditRepository,
    private readonly cipher: FieldEncryption,
    private readonly hasher: PasswordHasher,
    private readonly mailer: Mailer,
  ) {}

  async issue(
    platformUserId: bigint,
    schoolRowId: bigint,
    dto: IssuePrincipalLoginDto,
  ): Promise<IssuedPrincipalLoginDto> {
    // The default password is the digits; hashed before the transaction holds the school lock.
    const defaultHash = await this.hasher.hash(dto.cnic);
    const { result, outbox } = await this.apply(platformUserId, schoolRowId, dto, defaultHash);
    for (const message of outbox) void this.mailer.send(message);
    return result;
  }

  @Transactional()
  private async apply(
    platformUserId: bigint,
    schoolRowId: bigint,
    dto: IssuePrincipalLoginDto,
    defaultHash: string,
  ): Promise<{ result: IssuedPrincipalLoginDto; outbox: MailMessage[] }> {
    const school = await this.schools.lockForPrincipalIssue(schoolRowId);
    if (!school) throw notFound();
    if (school.status === 'terminated') {
      throw conflict(ErrorCode.SCHOOL_TERMINATED, 'A terminated school cannot be changed.');
    }
    const schoolId = fromPlatformSchool(school);

    // R103: a second principal needs a stated reason; the existing ones are told.
    const existing = await this.roles.activePrincipalUserIds(schoolId);
    if (existing.length > 0 && dto.reason === undefined) {
      throw conflict(
        ErrorCode.ACTIVE_PRINCIPAL_EXISTS,
        'This school already has an active principal. Give a reason to add another.',
      );
    }

    const hash = identityHash(dto.cnic, this.env.IDENTITY_HASH_KEY);
    const now = new Date();
    const actor = { actorUserId: null, actorPlatformUserId: platformUserId };
    const reason = dto.reason === undefined ? {} : { reason: dto.reason };

    // R22: an existing login for the same digits (a parent, say) is linked, never duplicated.
    // R99: it is locked and read again before anything is decided about it.
    const found = await this.users.findCredentialsByUsernameHash(schoolId, hash);
    const foundUser = found && (await this.users.lock(schoolId, found.id));
    const linkedExistingUser = foundUser !== null;
    const foundStaff = await this.staff.findByCnicHash(schoolId, hash);
    if (foundStaff && foundStaff.status !== 'active') {
      throw conflict(ErrorCode.STAFF_NOT_ACTIVE, 'This person’s staff record is not active.');
    }
    if (foundUser) {
      if (foundUser.status === 'disabled') {
        throw conflict(ErrorCode.USER_DISABLED, 'This person’s login is disabled.');
      }
      // A student's login is never shared (R40): its B-Form username collides with this CNIC.
      if (foundUser.studentId !== null) {
        throw conflict(ErrorCode.USERNAME_IN_USE, 'This CNIC is already the username of a student login.');
      }
      // Before the confirmation check, so a resubmit after a timeout still reads as done.
      if (await this.roles.hasLivePrincipalRole(schoolId, foundUser.id)) {
        throw conflict(ErrorCode.ALREADY_PRINCIPAL, 'This person is already a principal of the school.');
      }
      // Linking resets the account (resetOnStaffLink); the platform must say it means this login.
      if (dto.confirmLinkExisting !== true) {
        throw conflict(
          ErrorCode.LINK_EXISTING_LOGIN_UNCONFIRMED,
          'A login with this CNIC already exists at the school. Confirm to link it: its password ' +
            'returns to the default, its email is cleared and it is signed out everywhere.',
        );
      }
    }

    let staffId: bigint;
    let fullName = dto.fullName;
    if (foundStaff) {
      staffId = foundStaff.id;
      fullName = foundStaff.fullName;
    } else {
      staffId = await this.staff.create(schoolId, {
        fullName: dto.fullName,
        cnic: this.cipher.encrypt(dto.cnic, staffCnicAad(schoolId)),
        cnicHash: hash,
        phone: dto.phone,
        designation: 'Principal',
        joinedOn: todayIn(school.timezone),
      });
      await this.audit.record(schoolId, {
        ...actor,
        action: 'staff.created',
        subjectType: 'staff',
        subjectId: staffId,
        ...reason,
        metadata: { linkedExistingUser },
      });
    }

    let userId: bigint;
    if (foundUser) {
      userId = foundUser.id;
      if (foundUser.staffId === null) await this.users.linkStaff(schoolId, userId, staffId);
      const { users, sessions, tokens, audit } = this;
      await resetOnStaffLink({ users, sessions, tokens, audit }, schoolId, userId, {
        defaultHash,
        now,
        actor,
        capacity: 'principal',
      });
    } else {
      userId = await this.users.create(schoolId, { usernameHash: hash, passwordHash: defaultHash, staffId });
    }

    const outbox: MailMessage[] = [];
    if (dto.reason !== undefined) {
      for (const id of existing) {
        const principal = await this.users.findCredentials(schoolId, id);
        if (principal?.email && principal.emailVerifiedAt) {
          outbox.push({
            to: principal.email,
            subject: 'Another principal login was issued for your school',
            text:
              'The platform administrator issued a principal login for another person at your ' +
              `school. Reason given: ${dto.reason}`,
          });
        }
      }
    }

    await this.roles.insertPlatformPrincipal(schoolId, userId, now);
    await this.audit.record(schoolId, {
      ...actor,
      action: 'user.principal_login_issued',
      subjectType: 'user',
      subjectId: userId,
      ...reason,
      metadata: { linkedExistingUser },
    });
    await this.platformAudit.record({
      actorPlatformUserId: platformUserId,
      schoolId,
      action: 'school.principal_login_issued',
      subjectType: 'school',
      subjectId: schoolId,
      ...reason,
      metadata: { linkedExistingUser },
    });
    return {
      result: { userId: userId.toString(), staffId: staffId.toString(), fullName, linkedExistingUser },
      outbox,
    };
  }
}
