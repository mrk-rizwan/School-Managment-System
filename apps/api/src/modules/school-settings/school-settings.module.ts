import { Module } from '@nestjs/common';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SchoolSettingsController } from './school-settings.controller';
import { SchoolSettingsService } from './school-settings.service';

/** /api/v1/school/settings (contracts/slice-2.md §6). */
@Module({
  controllers: [SchoolSettingsController],
  providers: [SchoolSettingsService, SchoolSettingsRepository, AuditLogRepository],
})
export class SchoolSettingsModule {}
