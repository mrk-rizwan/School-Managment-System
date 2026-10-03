import { Module } from '@nestjs/common';
import { PlatformAuthModule } from './auth/platform-auth.module';
import { PrincipalLoginModule } from './principal/principal.module';
import { PlatformMessagingModule } from './messaging/platform-messaging.module';
import { PlatformSchoolsModule } from './schools/platform-schools.module';
import { PlatformSettingsModule } from './settings/platform-settings.module';

/**
 * Everything under /api/v1/platform (contracts/slice-1.md). The platform OpenAPI document is built
 * from this module's tree and the school document excludes it.
 */
@Module({
  imports: [
    PlatformAuthModule,
    PlatformSchoolsModule,
    PrincipalLoginModule,
    PlatformSettingsModule,
    PlatformMessagingModule,
  ],
})
export class PlatformModule {}
