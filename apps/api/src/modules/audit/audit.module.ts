import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { AuditReadsRepository } from '../../repositories/audit-reads.repository';
import { AuditController, AuditReadsThrottleGuard } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * The audit screen (Phase 5 slice 46, contracts/slice-46.md): reads audit_log through the
 * read-only AuditReadsRepository. PermissionsService and SchoolClock come from the global modules.
 */
@Module({
  controllers: [AuditController],
  providers: [SchoolContext, AuditService, AuditReadsRepository, AuditLogRepository, AuditReadsThrottleGuard],
})
export class AuditModule {}
