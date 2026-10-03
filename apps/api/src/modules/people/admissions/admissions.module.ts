import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { GuardianRepository } from '../../../repositories/guardian.repository';
import { IdempotencyKeyRepository } from '../../../repositories/idempotency-key.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { StagedUploadRepository } from '../../../repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../../repositories/student-document.repository';
import { GuardiansService } from '../guardians/guardians.service';
import { StudentsModule } from '../students/students.module';
import { AdmissionProbeThrottleGuard, AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { ReadmissionService } from './readmission.service';

/**
 * POST /admissions and POST /students/:id/readmit (contracts/slice-6.md §3.7, §6.3). Builds on
 * the students module's exported services and repositories; SchoolClock comes from the global
 * AccessModule. GuardiansService is provided here for its lock and survivor-resolving lookup.
 */
@Module({
  imports: [CryptoModule, StudentsModule],
  controllers: [AdmissionsController],
  providers: [
    SchoolContext,
    AdmissionsService,
    ReadmissionService,
    AdmissionProbeThrottleGuard,
    GuardiansService,
    GuardianRepository,
    IdempotencyKeyRepository,
    SchoolSettingsRepository,
    StagedUploadRepository,
    StudentDocumentRepository,
    AuditLogRepository,
  ],
})
export class AdmissionsModule {}
