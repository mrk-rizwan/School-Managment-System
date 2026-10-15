import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { MessagingModule } from '../../../messaging/messaging.module';
import { CnicProbeThrottleGuard } from '../../../common/rate-limit';
import { SchoolContext } from '../../../common/school-context';
import { AcademicYearRepository } from '../../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { ClassRepository } from '../../../repositories/class.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { SectionRepository } from '../../../repositories/section.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { SubjectRepository } from '../../../repositories/subject.repository';
import { UserRoleRepository } from '../../../repositories/user-role.repository';
import { UserTokenRepository } from '../../../repositories/user-token.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../../common/idempotency';
import { StorageModule } from '../../../common/storage/storage.module';
import { IdempotencyKeyRepository } from '../../../repositories/idempotency-key.repository';
import { MessageRecipientRepository } from '../../../repositories/message-recipient.repository';
import { SalaryStructureRepository } from '../../../repositories/salary-structure.repository';
import { StaffContractRepository } from '../../../repositories/staff-contract.repository';
import { StagedUploadRepository } from '../../../repositories/staged-upload.repository';
import { DocumentsModule } from '../../documents/documents.module';
import { EventsModule } from '../../events/events.module';
import { TransportModule } from '../../transport/transport.module';
import { MeReadsThrottleGuard } from '../../me/me-throttles';
import { ContractExpiryWarn } from './contract-expiry.job';
import {
  MyStaffContractController,
  StaffContractFilesThrottleGuard,
  StaffContractsController,
  StaffContractWritesThrottleGuard,
} from './staff-contracts.controller';
import { StaffContractsService } from './staff-contracts.service';
import { StaffLoginService } from './staff-login.service';
import { StaffStatusService } from './staff-status.service';
import { StaffController, TeacherAssignmentsController, UserRolesController } from './staff.controller';
import { StaffService } from './staff.service';
import { TeacherAssignmentsService } from './teacher-assignments.service';
import { UserRolesService } from './user-roles.service';
import { StaffReportsController, StaffReportsThrottleGuard } from './staff-report.controller';
import { StaffReportService } from './staff-report.service';
import { StaffReportRepository } from '../../../repositories/staff-report.repository';

/**
 * /api/v1/staff, /teacher-assignments, /users/:id/roles and /user-roles (contracts/slice-4.md).
 * PermissionsService, SchoolClock and TeacherAssignmentRepository come from the global
 * AccessModule; SessionRepository from the global TenancyModule.
 */
@Module({
  // Phase 5 slice 39: DocumentsModule lends AttachmentFiles, so contract scans stream as receipts do.
  // Phase 5 close (B8): leaving clears vehicles (TransportService) and event duties (EventsService).
  imports: [CryptoModule, MessagingModule, DocumentsModule, StorageModule, TransportModule, EventsModule],
  controllers: [
    StaffController,
    TeacherAssignmentsController,
    UserRolesController,
    StaffContractsController,
    MyStaffContractController,
    // Phase 5 slice 42 (R337): the staff report.
    StaffReportsController,
  ],
  providers: [
    // Phase 5 slice 39 (contracts/slice-39.md): staff contracts and the contract-expiry-warn body.
    StaffContractsService,
    ContractExpiryWarn,
    StaffReportService,
    StaffReportRepository,
    StaffReportsThrottleGuard,
    StaffContractRepository,
    SalaryStructureRepository,
    StagedUploadRepository,
    MessageRecipientRepository,
    IdempotencyKeyRepository,
    IdempotentRequests,
    IdempotencyKeyGuard,
    MeReadsThrottleGuard,
    StaffContractWritesThrottleGuard,
    StaffContractFilesThrottleGuard,
    SchoolContext,
    CnicProbeThrottleGuard,
    StaffService,
    StaffStatusService,
    StaffLoginService,
    TeacherAssignmentsService,
    UserRolesService,
    StaffRepository,
    UserRepository,
    UserRoleRepository,
    UserTokenRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
    AcademicYearRepository,
    ClassRepository,
    SectionRepository,
    SubjectRepository,
  ],
  // Slice 24: leave approval creates and ends the slice-10 cover assignment through it.
  exports: [TeacherAssignmentsService, ContractExpiryWarn],
})
export class StaffModule {}
