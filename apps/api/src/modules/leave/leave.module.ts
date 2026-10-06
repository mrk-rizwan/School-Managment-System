import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { LeaveRequestRepository } from '../../repositories/leave-request.repository';
import { LeaveTypeRepository } from '../../repositories/leave-type.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { UserRepository } from '../../repositories/user.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { StaffModule } from '../people/staff/staff.module';
import {
  LeaveRequestsController,
  LeaveTypesController,
  MyLeaveController,
  StaffLeaveController,
} from './leave.controller';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveTypesService } from './leave-types.service';

/**
 * Staff leave (phase-3-financial.md slice 24, contracts/slice-24.md): leave types, balances,
 * requests and their decisions. The cover on approval is the slice-10 cover assignment, created and
 * ended through StaffModule's TeacherAssignmentsService; working days come from CalendarModule.
 * PermissionsService, SchoolClock and TeacherAssignmentRepository come from the global AccessModule.
 */
@Module({
  imports: [MessagingModule, CalendarModule, StaffModule],
  controllers: [LeaveTypesController, MyLeaveController, LeaveRequestsController, StaffLeaveController],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    LeaveTypesService,
    LeaveRequestsService,
    LeaveTypeRepository,
    LeaveRequestRepository,
    StaffRepository,
    UserRepository,
    ChangeContextRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
  // The Approvals read (slice 27) lists the pending queue through the service.
  exports: [LeaveRequestsService],
})
export class LeaveModule {}
