import { Global, Module } from '@nestjs/common';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import { UserRepository } from '../../repositories/user.repository';
import { PermissionsService } from './permissions.service';
import { SchoolClock } from '../../common/school-clock';

// Global: the access guard (an APP_GUARD) and session resolution in src/tenancy need
// PermissionsService on every school route. SchoolClock is the school's "today" for every
// date rule (R53); TeacherAssignmentRepository is exported for the academics SECTION_IN_USE
// check (contracts/slice-4.md §4.5), so the academics module needs no new provider. Slice 7 adds
// custom roles and grants here.
@Global()
@Module({
  providers: [
    PermissionsService,
    SchoolClock,
    UserRepository,
    OwnSchoolRepository,
    TeacherAssignmentRepository,
  ],
  exports: [PermissionsService, SchoolClock, TeacherAssignmentRepository],
})
export class AccessModule {}
