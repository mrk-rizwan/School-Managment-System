import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import { UserTokenRepository } from '../../repositories/user-token.repository';
import { UserRepository } from '../../repositories/user.repository';
import { LoginKeys, SchoolLoginLockout } from '../auth/login-limits';
import { MailModule } from '../auth/mailer';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** /api/v1/users (contracts/slice-2.md §5). */
@Module({
  imports: [CryptoModule, MailModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserRepository,
    UserRoleRepository,
    UserTokenRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
    LoginKeys,
    SchoolLoginLockout,
  ],
})
export class UsersModule {}
