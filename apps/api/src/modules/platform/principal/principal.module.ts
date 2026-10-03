import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { UserRoleRepository } from '../../../repositories/user-role.repository';
import { UserTokenRepository } from '../../../repositories/user-token.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { MailModule } from '../../auth/mailer';
import { PrincipalLoginController } from './principal.controller';
import { PrincipalLoginService } from './principal.service';

/** POST /api/v1/platform/schools/:id/issue-principal-login (contracts/slice-2.md §7). */
@Module({
  imports: [CryptoModule, MailModule],
  controllers: [PrincipalLoginController],
  providers: [
    PrincipalLoginService,
    SchoolRepository,
    StaffRepository,
    UserRepository,
    UserRoleRepository,
    UserTokenRepository,
    AuditLogRepository,
    PlatformAuditRepository,
  ],
})
export class PrincipalLoginModule {}
