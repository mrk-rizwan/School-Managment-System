import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import { UserRepository } from '../../repositories/user.repository';
import { CustomRolesService } from './custom-roles.service';
import { GrantsService } from './grants.service';
import { CustomRolesController, GrantsController } from './roles.controller';

/**
 * /api/v1/custom-roles, /users/:id/permissions, /users/:id/grants, /grants (contracts/slice-7.md).
 * PermissionsService and the custom-role and grant repositories come from the global AccessModule.
 */
@Module({
  controllers: [CustomRolesController, GrantsController],
  providers: [
    SchoolContext,
    CustomRolesService,
    GrantsService,
    AuditLogRepository,
    StaffRepository,
    UserRepository,
    UserRoleRepository,
  ],
})
export class RolesModule {}
