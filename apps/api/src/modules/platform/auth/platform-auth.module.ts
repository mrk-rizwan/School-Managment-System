import { Global, Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformSessionRepository } from '../../../repositories/platform/platform-session.repository';
import { PlatformUserRepository } from '../../../repositories/platform/platform-user.repository';
import { LoginLockout, LoginThrottleGuard, SessionThrottleGuard } from './login-limits';
import { PlatformAdminSeeder } from './platform-admin.seeder';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformStepUp } from './platform-step-up';
import { SupportCoreModule } from '../support/support.module';
import { PlatformSessionAccess } from './platform-session-access';

// Global for its exports: RouteAccessGuard (an APP_GUARD in AppModule) needs PlatformSessionAccess
// to resolve @PlatformSession routes, and the support module (slice 45) needs PlatformStepUp for a
// fresh second factor. The platform repositories behind them stay inside this module. Logout
// closes the caller's support sessions (SupportCoreModule).
@Global()
@Module({
  imports: [CryptoModule, SupportCoreModule],
  controllers: [PlatformAuthController],
  providers: [
    PlatformAuthService,
    PlatformAdminSeeder,
    PlatformUserRepository,
    PlatformSessionRepository,
    PlatformAuditRepository,
    LoginLockout,
    LoginThrottleGuard,
    SessionThrottleGuard,
    PlatformSessionAccess,
    PlatformStepUp,
  ],
  exports: [PlatformSessionAccess, PlatformStepUp],
})
export class PlatformAuthModule {}
