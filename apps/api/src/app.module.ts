import { Module } from '@nestjs/common';
import { DatabaseModule } from './repositories/database.module';
import { TenancyModule } from './tenancy/tenancy.module';

// Slice 0 wiring. api-core owns this file and adds config, logging, throttling,
// health and the error filter. The tenancy agent owns the two imported modules.
@Module({
  imports: [DatabaseModule, TenancyModule],
})
export class AppModule {}
