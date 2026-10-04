import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StaffAttendanceRepository } from '../../repositories/staff-attendance.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  MyStaffAttendanceController,
  StaffAttendanceController,
  StaffMemberAttendanceController,
} from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';

/**
 * Staff attendance (Phase 2 slice 12, contracts/slice-12.md): the day sheet, submit and amend,
 * GET /staff/:id/attendance and GET /me/staff/attendance. Working days come from CalendarModule
 * (R136); no alerts, no outbox. SchoolClock comes from the global AccessModule: a second
 * provider here would give tests that move the clock a different instance.
 */
@Module({
  imports: [CalendarModule],
  controllers: [
    StaffAttendanceController,
    StaffMemberAttendanceController,
    MyStaffAttendanceController,
  ],
  providers: [
    SchoolContext,
    MeReadsThrottleGuard,
    StaffAttendanceService,
    StaffAttendanceRepository,
    StaffRepository,
    ChangeContextRepository,
    SchoolSettingsRepository,
    AuditLogRepository,
  ],
})
export class StaffAttendanceModule {}
