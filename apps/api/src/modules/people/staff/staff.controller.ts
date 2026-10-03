import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { CnicProbeThrottleGuard } from '../../../common/rate-limit';
import { NoQueryDto } from '../../../common/validation';
import { UserDto } from '../../users/users.dto';
import {
  AssignRoleDto,
  ChangeStaffStatusDto,
  CreateStaffDto,
  CreateTeacherAssignmentDto,
  EndTeacherAssignmentDto,
  IssueStaffLoginDto,
  ListStaffQueryDto,
  ListTeacherAssignmentsQueryDto,
  ListUserRolesQueryDto,
  RemoveRoleDto,
  StaffDto,
  TeacherAssignmentDto,
  UpdateStaffDto,
  UserRoleDto,
} from './staff.dto';
import { StaffLoginService } from './staff-login.service';
import { StaffStatusService } from './staff-status.service';
import { StaffService } from './staff.service';
import { TeacherAssignmentsService } from './teacher-assignments.service';
import { UserRolesService } from './user-roles.service';

// contracts/slice-4.md. Common to every route: 401, 403 PERMISSION_DENIED / SCHOOL_SUSPENDED /
// ORIGIN_REJECTED, 429. No route here is section-scoped (§1).
const COMMON = [401, 403, 429];

@ApiTags('staff')
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly statuses: StaffStatusService,
    private readonly logins: StaffLoginService,
    private readonly assignments: TeacherAssignmentsService,
  ) {}

  @Get()
  @RequireCapability(Capability.STAFF_VIEW)
  @ApiPaginated(StaffDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListStaffQueryDto): Promise<Page<StaffDto>> {
    return this.staff.list(query);
  }

  @Post()
  @RequireCapability(Capability.STAFF_CREATE)
  @UseGuards(CnicProbeThrottleGuard)
  @ApiCreatedResponse({ type: StaffDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateStaffDto, @Query() _query: NoQueryDto): Promise<StaffDto> {
    return this.staff.create(body);
  }

  @Get(':id')
  @RequireCapability(Capability.STAFF_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<StaffDto> {
    return this.staff.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.STAFF_UPDATE)
  @UseGuards(CnicProbeThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateStaffDto,
    @Query() _query: NoQueryDto,
  ): Promise<StaffDto> {
    return this.staff.update(id, body);
  }

  @Post(':id/change-status')
  @HttpCode(200)
  @RequireCapability(Capability.STAFF_STATUS_CHANGE)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  changeStatus(
    @IdParam() id: bigint,
    @Body() body: ChangeStaffStatusDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StaffDto> {
    return this.statuses.changeStatus(session, id, body);
  }

  @Post(':id/issue-login')
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: UserDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  issueLogin(
    @IdParam() id: bigint,
    @Body() body: IssueStaffLoginDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserDto> {
    return this.logins.issueLogin(session, id, body);
  }

  @Get(':id/teacher-assignments')
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiPaginated(TeacherAssignmentDto)
  @ApiErrors(...COMMON, 404, 422)
  listAssignments(
    @IdParam() id: bigint,
    @Query() query: ListTeacherAssignmentsQueryDto,
  ): Promise<Page<TeacherAssignmentDto>> {
    return this.assignments.list(id, query);
  }

  @Post(':id/teacher-assignments')
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: TeacherAssignmentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  createAssignment(
    @IdParam() id: bigint,
    @Body() body: CreateTeacherAssignmentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<TeacherAssignmentDto> {
    return this.assignments.create(session, id, body);
  }
}

@ApiTags('staff')
@Controller('teacher-assignments')
export class TeacherAssignmentsController {
  constructor(private readonly assignments: TeacherAssignmentsService) {}

  @Post(':id/end')
  @HttpCode(200)
  @RequireCapability(Capability.CLASS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: TeacherAssignmentDto })
  @ApiErrors(...COMMON, 404, 422)
  end(
    @IdParam() id: bigint,
    @Body() body: EndTeacherAssignmentDto,
    @Query() _query: NoQueryDto,
  ): Promise<TeacherAssignmentDto> {
    return this.assignments.end(id, body);
  }
}

/** A login's system roles (contract §5). Paths under /users and /user-roles. */
@ApiTags('users')
@Controller()
export class UserRolesController {
  constructor(private readonly roles: UserRolesService) {}

  @Get('users/:id/roles')
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiPaginated(UserRoleDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@IdParam() id: bigint, @Query() query: ListUserRolesQueryDto): Promise<Page<UserRoleDto>> {
    return this.roles.list(id, query);
  }

  @Post('users/:id/roles')
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: UserRoleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  assign(
    @IdParam() id: bigint,
    @Body() body: AssignRoleDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserRoleDto> {
    return this.roles.assign(session, id, body);
  }

  @Post('user-roles/:id/remove')
  @HttpCode(200)
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: UserRoleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  remove(
    @IdParam() id: bigint,
    @Body() body: RemoveRoleDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserRoleDto> {
    return this.roles.remove(session, id, body);
  }
}
