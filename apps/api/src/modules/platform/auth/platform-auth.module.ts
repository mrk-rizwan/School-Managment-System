import { Global, Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformSessionRepository } from '../../../repositories/platform/platform-session.repository';
import { PlatformUserRepository } from '../../../repositories/platform/platform-user.repository';
import { LoginLockout, LoginThrottleGuard, SessionThrottleGuard } from './login-limits';
import { PlatformAdminSeeder } from './platform-admin.seeder';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessionAccess } from './platform-session-access';

// Global for one export: RouteAccessGuard (an APP_GUARD in AppModule) needs PlatformSessionAccess
// to resolve @PlatformSession routes. The platform repositories behind it stay inside this module.
@Global()
@Module({
  imports: [CryptoModule],
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
  ],
  exports: [PlatformSessionAccess],
})
export class PlatformAuthModule {}
