import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolLookupRepository } from '../../repositories/school-lookup.repository';
import { UserRepository } from '../../repositories/user.repository';
import { UserTokenRepository } from '../../repositories/user-token.repository';
import { AccessModule } from '../access/access.module';
import { SchoolSettingsModule } from '../school-settings/school-settings.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { CredentialsService } from './credentials.service';
import {
  ForgotPasswordThrottleGuard,
  LoginKeys,
  SchoolLoginLockout,
  SchoolLoginThrottleGuard,
  SchoolSessionThrottleGuard,
  TokenThrottleGuard,
} from './login-limits';
import { LOGIN_SPIKE_PROVIDERS } from './login-spike.recorder';
import { LoginService } from './login.service';
import { MailModule } from './mailer';
import { MeController } from './me.controller';
import { MeService } from './me.service';

// School login, sessions, me, users and school settings (contracts/slice-2.md). Registered in
// AppModule by the main thread so parallel agents never edit app.module.ts; it imports the
// slice-2 submodules. AccessModule is global: the access guard and session resolution use it.
@Module({
  imports: [AccessModule, CryptoModule, MailModule, UsersModule, SchoolSettingsModule],
  controllers: [AuthController, MeController],
  providers: [
    LoginService,
    ...LOGIN_SPIKE_PROVIDERS,
    CredentialsService,
    MeService,
    LoginKeys,
    SchoolLoginLockout,
    SchoolLoginThrottleGuard,
    ForgotPasswordThrottleGuard,
    TokenThrottleGuard,
    SchoolSessionThrottleGuard,
    SchoolLookupRepository,
    UserRepository,
    UserTokenRepository,
    AuditLogRepository,
  ],
})
export class SchoolAuthModule {}
