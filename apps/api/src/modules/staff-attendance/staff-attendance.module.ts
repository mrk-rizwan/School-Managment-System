import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AttendanceDisputeRepository } from '../../repositories/attendance-dispute.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { DevicePunchRepository } from '../../repositories/device-punch.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { LeaveRequestRepository } from '../../repositories/leave-request.repository';
import { LeaveTypeRepository } from '../../repositories/leave-type.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StaffAttendanceRepository } from '../../repositories/staff-attendance.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { UserRepository } from '../../repositories/user.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  AttendanceDisputesController,
  MyAttendanceDisputesController,
} from './attendance-disputes.controller';
import { AttendanceDisputesService } from './attendance-disputes.service';
import {
  DevicePunchesController,
  DeviceTokenController,
  StaffDeviceUserController,
} from './biometric.controller';
import { BiometricService } from './biometric.service';
import { PunchIntakeService } from './punch-intake.service';
import {
  MyStaffAttendanceController,
  StaffAttendanceController,
  StaffMemberAttendanceController,
} from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';

/**
 * Staff attendance (Phase 2 slice 12, contracts/slice-12.md): the day sheet, submit and amend,
 * GET /staff/:id/attendance and GET /me/staff/attendance. Working days come from CalendarModule
 * (R136). SchoolClock comes from the global AccessModule: a second provider here would give tests
 * that move the clock a different instance.
 *
 * Phase 5 slice 44 (contracts/slice-44.md): the biometric device (token rotation, the device
 * mapping, the punch intake and its day view) and staff attendance disputes. The device token
 * itself is resolved by DevicePunchService, provided in AppModule for RouteAccessGuard.
 */
@Module({
  imports: [CalendarModule, MessagingModule],
  controllers: [
    StaffAttendanceController,
    StaffMemberAttendanceController,
    MyStaffAttendanceController,
    DevicePunchesController,
    DeviceTokenController,
    StaffDeviceUserController,
    MyAttendanceDisputesController,
    AttendanceDisputesController,
  ],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    StaffAttendanceService,
    BiometricService,
    PunchIntakeService,
    AttendanceDisputesService,
    StaffAttendanceRepository,
    StaffRepository,
    ChangeContextRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
    IdempotencyKeyRepository,
    UserRepository,
    DevicePunchRepository,
    AttendanceDisputeRepository,
    // Slice 24: the day sheet's approvedLeave.
    LeaveRequestRepository,
    LeaveTypeRepository,
  ],
  // The Approvals read (R347) lists the pending queue through the service.
  exports: [AttendanceDisputesService],
})
export class StaffAttendanceModule {}
