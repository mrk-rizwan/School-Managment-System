import { Module } from '@nestjs/common';
import { PlatformAuthModule } from './auth/platform-auth.module';
import { PlatformSchoolsModule } from './schools/platform-schools.module';

/**
 * Everything under /api/v1/platform (contracts/slice-1.md). The platform OpenAPI document is built
 * from this module's tree and the school document excludes it.
 */
@Module({
  imports: [PlatformAuthModule, PlatformSchoolsModule],
})
export class PlatformModule {}
