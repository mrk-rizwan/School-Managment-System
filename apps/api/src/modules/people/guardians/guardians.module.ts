import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { GuardianLoginRepository } from '../../../repositories/guardian-login.repository';
import { GuardianRepository } from '../../../repositories/guardian.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { GuardianLoginService } from './guardian-login.service';
import { GuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';
import { GuardianLookupThrottleGuard } from './lookup-throttle.guard';

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
    GuardianLookupThrottleGuard,
  ],
})
export class GuardiansModule {}
