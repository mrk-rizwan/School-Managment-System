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
import { StaffLoginService } from './staff-login.service';
import { StaffStatusService } from './staff-status.service';
import { StaffController, TeacherAssignmentsController, UserRolesController } from './staff.controller';
import { StaffService } from './staff.service';
import { TeacherAssignmentsService } from './teacher-assignments.service';
import { UserRolesService } from './user-roles.service';

/**
 * /api/v1/staff, /teacher-assignments, /users/:id/roles and /user-roles (contracts/slice-4.md).
 * PermissionsService, SchoolClock and TeacherAssignmentRepository come from the global
 * AccessModule; SessionRepository from the global TenancyModule.
 */
@Module({
  imports: [CryptoModule, MessagingModule],
  controllers: [StaffController, TeacherAssignmentsController, UserRolesController],
  providers: [
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
})
export class StaffModule {}
