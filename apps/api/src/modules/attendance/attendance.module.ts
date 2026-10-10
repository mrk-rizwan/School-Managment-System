import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AttendanceAlertRepository } from '../../repositories/attendance-alert.repository';
import { AttendanceMarkRepository } from '../../repositories/attendance-mark.repository';
import { AttendanceRegisterRepository } from '../../repositories/attendance-register.repository';
import { AttendanceReportRepository } from '../../repositories/attendance-report.repository';
import { AttendanceSummaryRepository } from '../../repositories/attendance-summary.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { TimetableReadsRepository } from '../../repositories/timetable-reads.repository';
import { UserRepository } from '../../repositories/user.repository';
import { CalendarModule } from '../calendar/calendar.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { AttendanceAccess } from './attendance-access';
import { AttendanceAlertProcessor, AttendanceAlertWriter } from './attendance-alerts';
import { AttendanceCalendarListener } from './attendance-calendar.listener';
import { AttendanceRollup, AttendanceSweeps, RegisterDeadlineSweep } from './attendance-jobs';
import { AttendanceReadsService } from './attendance-reads.service';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { AttendanceWritesThrottleGuard } from './attendance-throttles';
import { AttendanceController } from './attendance.controller';
import { MarkHistoryProbe } from './mark-history-probe';
import { MarksService } from './marks.service';
import { MyAttendanceController } from './my-attendance.controller';
import { RegistersService } from './registers.service';
import { TimetablePeriods } from './timetable-periods';

/**
 * Student attendance (Phase 2 slice 11, contracts/slice-11.md): registers, marks, the gate's
 * arrivals, alerts, the rollup and the reports, plus the guardian and student reads. Imports
 * CalendarModule (teaching days; registers the R167 listener from onModuleInit) and
 * MessagingModule (NotificationService, OutboxDispatcher, MessageRepository, the settings
 * repository). Exports the history probe StudentsModule binds (§9.1) and the job bodies the
 * worker runs (src/jobs). PermissionsService and SchoolClock come from the global AccessModule.
 *
 * Readers of attendance_day_status (Phase 4 included) must apply the school calendar at read:
 * nothing stored says whether a date is a teaching day (§7).
 */
@Module({
  imports: [CalendarModule, MessagingModule],
  controllers: [AttendanceController, MyAttendanceController],
  providers: [
    SchoolContext,
    AttendanceAccess,
    SchoolSettingsReader,
    RegistersService,
    MarksService,
    AttendanceReadsService,
    AttendanceAlertWriter,
    AttendanceAlertProcessor,
    AttendanceRollup,
    AttendanceSweeps,
    RegisterDeadlineSweep,
    AttendanceCalendarListener,
    MarkHistoryProbe,
    AttendanceWritesThrottleGuard,
    MeReadsThrottleGuard,
    AttendanceRegisterRepository,
    AttendanceMarkRepository,
    AttendanceAlertRepository,
    AttendanceSummaryRepository,
    AttendanceReportRepository,
    ChangeContextRepository,
    StudentRepository,
    UserRepository,
    // Phase 5 slice 37: R304, R305 and SectionDayDto.periods read the timetable through it.
    TimetableReadsRepository,
    TimetablePeriods,
  ],
  exports: [MarkHistoryProbe, AttendanceAlertProcessor, AttendanceRollup, AttendanceSweeps, RegisterDeadlineSweep],
})
export class AttendanceModule {}
