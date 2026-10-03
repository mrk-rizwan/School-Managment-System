import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { PasswordHasher } from '../../../common/crypto/password';
import { normaliseEmail } from '../../../config/env';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformUserRepository } from '../../../repositories/platform/platform-user.repository';

/**
 * Contract slice-1 §7. Creates a platform admin who must enrol an authenticator and change the
 * password on first sign-in. Idempotent: an existing user with that email is never touched, so
 * re-running it cannot reset a password, a TOTP enrolment or a status.
 */
@Injectable()
export class PlatformAdminSeeder {
  constructor(
    private readonly users: PlatformUserRepository,
    private readonly audit: PlatformAuditRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async seed(email: string, password: string): Promise<'created' | 'exists'> {
    const passwordHash = await this.hasher.hash(password);
    return this.insert(normaliseEmail(email), passwordHash);
  }

  @Transactional()
  private async insert(email: string, passwordHash: string): Promise<'created' | 'exists'> {
    const id = await this.users.insertIfAbsent(email, passwordHash);
    if (id === null) return 'exists';
    await this.audit.record({
      actorPlatformUserId: null,
      schoolId: null,
      action: 'platform_user.seeded',
      subjectType: 'platform_user',
      subjectId: id,
      metadata: {},
    });
    return 'created';
  }
}
