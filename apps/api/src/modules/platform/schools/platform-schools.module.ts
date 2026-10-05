import { Module } from '@nestjs/common';
import { FeeHeadRepository } from '../../../repositories/fee-head.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { SchoolCounterRepository } from '../../../repositories/school-counter.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

/** /api/v1/platform/schools (contracts/slice-1.md section 4). */
@Module({
  controllers: [SchoolsController],
  providers: [
    SchoolsService,
    SchoolRepository,
    SchoolSettingsRepository,
    SchoolCounterRepository,
    FeeHeadRepository,
    PlatformAuditRepository,
  ],
})
export class PlatformSchoolsModule {}
