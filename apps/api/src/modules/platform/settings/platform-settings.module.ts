import { Module } from '@nestjs/common';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformSettingsRepository } from '../../../repositories/platform/platform-settings.repository';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';

/** /api/v1/platform/settings (contracts/slice-9.md §6.2). */
@Module({
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService, PlatformSettingsRepository, PlatformAuditRepository],
})
export class PlatformSettingsModule {}
