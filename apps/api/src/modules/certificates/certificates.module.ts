import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { CertificateRepository } from '../../repositories/certificate.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import { FinanceReportsModule } from '../finance-reports/finance-reports.module';
import { ResultsModule } from '../results/results.module';
import { CertificatesController, PrintThrottleGuard, StudentCertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

/**
 * Certificates (phase-4-academic.md slice 34): issue per type, the register, reissue, void and the
 * print view. Dues are read only through FinanceReportsService.clearance (§5.1); CryptoModule
 * lends FieldEncryption for the leaving certificate's B-Form, decrypted in the print path only.
 */
@Module({
  // ResultsModule (wave P): the marks table of an academic or completion certificate (A11).
  imports: [FinanceReportsModule, CryptoModule, ResultsModule],
  controllers: [CertificatesController, StudentCertificatesController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    PrintThrottleGuard,
    CertificatesService,
    CertificateRepository,
    EnrolmentRepository,
    SchoolSettingsRepository,
    UserRoleRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
})
export class CertificatesModule {}
