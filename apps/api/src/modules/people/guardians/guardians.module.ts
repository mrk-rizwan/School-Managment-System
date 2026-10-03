import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { CnicProbeThrottleGuard, IdentityProbeThrottleGuard } from '../../../common/rate-limit';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../../repositories/enrolment.repository';
import { GuardianLoginRepository } from '../../../repositories/guardian-login.repository';
import { GuardianRepository } from '../../../repositories/guardian.repository';
import { StudentGuardianRepository } from '../../../repositories/student-guardian.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { GuardianLoginService } from './guardian-login.service';
import { GuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';

/** /api/v1/guardians (contracts/slice-5.md). PermissionsService comes from the global AccessModule. */
@Module({
  imports: [CryptoModule],
  controllers: [GuardiansController],
  providers: [
    SchoolContext,
    GuardiansService,
    GuardianLoginService,
    GuardianRepository,
    GuardianLoginRepository,
    UserRepository,
    AuditLogRepository,
    StudentGuardianRepository,
    EnrolmentRepository,
    IdentityProbeThrottleGuard,
    CnicProbeThrottleGuard,
  ],
})
export class GuardiansModule {}
