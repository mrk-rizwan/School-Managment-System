import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, LOGIN_ISSUED_REASONS } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { PasswordHasher } from '../../../common/crypto/password';
import { ApiException } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { bFormAad, identityHash } from '../../../common/identity';
import { SchoolContext } from '../../../common/school-context';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { UserRepository } from '../../../repositories/user.repository';
import type { IssueLoginDto, UserDto } from '../../users/users.dto';
import { toUserDto } from '../../users/users.service';
import { StudentsService } from './students.service';

// POST /students/:id/issue-login (contracts/slice-6.md §3.8; R40). The username is the student's
// B-Form, stored only as its HMAC; the default password is the same digits. Never links to an
// existing user: a B-Form colliding with any username (a staff or guardian CNIC) is refused.

const STUDENT_ID_UNIQUE = 'users_school_id_student_id_key';
const USERNAME_UNIQUE = 'users_school_id_username_hash_key';

const conflict = (code: ErrorCode, message: string) => new ApiException(409, code, message);
const loginExists = () =>
  conflict(ErrorCode.LOGIN_ALREADY_EXISTS, 'This student already has a login.');
const usernameInUse = () =>
  conflict(
    ErrorCode.USERNAME_IN_USE,
    'This B-Form number is already the username of another login.',
  );

@Injectable()
export class StudentLoginService {
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly students: StudentsService,
    private readonly users: UserRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    private readonly passwords: PasswordHasher,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  /**
   * A unique violation aborts the transaction, so a race is caught here, outside it: the student
   * gained a login meanwhile → LOGIN_ALREADY_EXISTS; the username was taken → USERNAME_IN_USE.
   */
  async issueLogin(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: IssueLoginDto,
  ): Promise<UserDto> {
    try {
      return await this.issueInTransaction(session, studentId, dto);
    } catch (error) {
      const constraint = summariseDatabaseError(error)?.constraint;
      if (constraint === STUDENT_ID_UNIQUE) throw loginExists();
      if (constraint === USERNAME_UNIQUE) throw usernameInUse();
      throw error;
    }
  }

  @Transactional()
  private async issueInTransaction(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: IssueLoginDto,
  ): Promise<UserDto> {
    const { schoolId, userId: actorUserId } = this.context.actor();
    // Preconditions in contract order, on the locked row: racing issue-logins queue here.
    const student = await this.students.lock(schoolId, scopeOf(session), studentId);
    if (!(await this.settings.find(schoolId))?.studentLoginEnabled) {
      throw conflict(
        ErrorCode.STUDENT_LOGIN_DISABLED,
        'Student logins are turned off in the school settings.',
      );
    }
    if (student.status !== 'active') {
      throw conflict(ErrorCode.STUDENT_NOT_ACTIVE, 'Only an active student can be given a login.');
    }
    if (student.bForm === null) {
      throw conflict(
        ErrorCode.IDENTITY_NUMBER_MISSING,
        'A login needs the student’s B-Form number: it is the username.',
      );
    }
    if (student.userId !== null) throw loginExists();

    const digits = this.encryption.decrypt(student.bForm, bFormAad(schoolId));
    const usernameHash = identityHash(digits, this.hashKey);
    if (await this.users.findCredentialsByUsernameHash(schoolId, usernameHash)) {
      throw usernameInUse();
    }
    const userId = await this.users.create(schoolId, {
      usernameHash,
      passwordHash: await this.passwords.hash(digits),
      studentId,
    });
    await this.audit.record(schoolId, {
      actorUserId,
      action: 'user.login_issued',
      subjectType: 'user',
      subjectId: userId,
      reason: dto.reason ?? LOGIN_ISSUED_REASONS.student,
      metadata: { capacity: 'student', linkedExistingUser: false },
    });
    const user = await this.users.find(schoolId, userId);
    if (!user) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toUserDto(user);
  }
}
