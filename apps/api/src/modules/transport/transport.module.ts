import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { TransportRepository } from '../../repositories/transport.repository';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { MyTransportController, TransportController, TransportWritesThrottleGuard } from './transport.controller';
import { TransportAssignmentsService } from './transport-assignments.service';
import { TransportService } from './transport.service';

/**
 * Transport (phase-5-extended.md rule 37, slice 41; contracts/slice-41.md): vehicles, routes,
 * stops, route amounts and assignments, with the office, family and driver reads. Owns
 * TransportRepository (lint: importable only here); the charge job reads assignments only through
 * TransportReadsRepository (FeesModule). Exports TransportAssignmentsService for the leaving and
 * promotion hooks (StudentsService, PromotionService), and imports neither of their modules, so
 * there is no cycle. SchoolClock and PermissionsService come from the global AccessModule.
 */
@Module({
  controllers: [TransportController, MyTransportController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    TransportWritesThrottleGuard,
    MeReadsThrottleGuard,
    TransportService,
    TransportAssignmentsService,
    TransportRepository,
    StudentRepository,
    EnrolmentRepository,
    AcademicYearRepository,
    StaffRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  exports: [TransportAssignmentsService],
})
export class TransportModule {}
