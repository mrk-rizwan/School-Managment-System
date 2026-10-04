import { Global, Module } from '@nestjs/common';
import { CapabilityGrantRepository } from '../../repositories/capability-grant.repository';
import { CustomRoleRepository } from '../../repositories/custom-role.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { StudentGuardianRepository } from '../../repositories/student-guardian.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import { UserRepository } from '../../repositories/user.repository';
import { PermissionsService } from './permissions.service';
import { SchoolClock } from '../../common/school-clock';

// Global: the access guard (an APP_GUARD) and session resolution in src/tenancy need
// PermissionsService on every school route. SchoolClock is the school's "today" for every
// date rule (R53); TeacherAssignmentRepository is exported for the academics SECTION_IN_USE
// check (contracts/slice-4.md §4.5), so the academics module needs no new provider. The custom-role
// and grant repositories are exported for role assignment and R17 in the staff module (slice 7).
@Global()
@Module({
  providers: [
    PermissionsService,
    SchoolClock,
    UserRepository,
    CustomRoleRepository,
    CapabilityGrantRepository,
    OwnSchoolRepository,
    TeacherAssignmentRepository,
    // The guardian capacity scope (contracts/slice-13.md §1.2).
    StudentGuardianRepository,
  ],
  exports: [
    PermissionsService,
    SchoolClock,
    TeacherAssignmentRepository,
    CustomRoleRepository,
    CapabilityGrantRepository,
  ],
})
export class AccessModule {}
