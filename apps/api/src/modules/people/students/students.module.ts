import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { SchoolContext } from '../../../common/school-context';
import { AcademicYearRepository } from '../../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { ClassRepository } from '../../../repositories/class.repository';
import { EnrolmentRepository } from '../../../repositories/enrolment.repository';
import { GuardianRepository } from '../../../repositories/guardian.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { SectionRepository } from '../../../repositories/section.repository';
import { SessionRepository } from '../../../repositories/session.repository';
import { StudentGuardianRepository } from '../../../repositories/student-guardian.repository';
import { StudentStatusChangeRepository } from '../../../repositories/student-status-change.repository';
import { StudentRepository } from '../../../repositories/student.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { AttendanceModule } from '../../attendance/attendance.module';
import { MarkHistoryProbe } from '../../attendance/mark-history-probe';
import { AttendanceHistoryProbe } from './attendance-history-probe';
import { EnrolmentsController } from './enrolments.controller';
import { EnrolmentsService } from './enrolments.service';
import { GuardianLinksController } from './guardian-links.controller';
import { GuardianLinksService } from './guardian-links.service';
import { IdentityProbeThrottleGuard } from '../../../common/rate-limit';
import { StudentLoginService } from './student-login.service';
import { BFormPatchThrottleGuard, StudentsController } from './students.controller';
import { StudentsService } from './students.service';

/**
 * /api/v1/students, /guardian-links, /enrolments (contracts/slice-6.md §1-§5). PermissionsService
 * and SchoolClock come from the global AccessModule. Exports the services and repositories the
 * admission and readmission flows (slice 6B) build on: StudentsService (lock, require, toDtos,
 * toDetailDto), GuardianLinksService (toDto), EnrolmentsService (lockTarget) and the four
 * student-linked repositories.
 */
@Module({
  // AttendanceModule provides the real history probe (contracts/slice-11.md §9.1); it never
  // imports this module, so there is no cycle.
  imports: [CryptoModule, AttendanceModule],
  controllers: [StudentsController, GuardianLinksController, EnrolmentsController],
  providers: [
    SchoolContext,
    StudentsService,
    GuardianLinksService,
    EnrolmentsService,
    { provide: AttendanceHistoryProbe, useExisting: MarkHistoryProbe },
    StudentLoginService,
    IdentityProbeThrottleGuard,
    BFormPatchThrottleGuard,
    StudentRepository,
    StudentGuardianRepository,
    EnrolmentRepository,
    StudentStatusChangeRepository,
    GuardianRepository,
    AcademicYearRepository,
    ClassRepository,
    SectionRepository,
    SchoolSettingsRepository,
    SessionRepository,
    UserRepository,
    AuditLogRepository,
  ],
  exports: [
    StudentsService,
    GuardianLinksService,
    EnrolmentsService,
    StudentRepository,
    StudentGuardianRepository,
    EnrolmentRepository,
    StudentStatusChangeRepository,
  ],
})
export class StudentsModule {}
