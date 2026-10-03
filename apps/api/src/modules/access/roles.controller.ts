import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { CustomRolesService } from './custom-roles.service';
import { GrantsService } from './grants.service';
import {
  CreateCustomRoleDto,
  CreateGrantDto,
  CustomRoleDto,
  GrantDto,
  ListCustomRolesQueryDto,
  ReasonDto,
  UpdateCustomRoleDto,
  UserPermissionsDto,
  UserPermissionsQueryDto,
} from './roles.dto';

// contracts/slice-7.md. Common to every route: 401, 403 PERMISSION_DENIED / SCHOOL_SUSPENDED /
// ORIGIN_REJECTED, 429. No route here is section-scoped. Every write needs role.manage (R48, R55).
const COMMON = [401, 403, 429];

@ApiTags('custom-roles')
@Controller('custom-roles')
export class CustomRolesController {
  constructor(private readonly roles: CustomRolesService) {}

  @Get()
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE)
  @ApiPaginated(CustomRoleDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListCustomRolesQueryDto): Promise<Page<CustomRoleDto>> {
    return this.roles.list(query);
  }

  @Post()
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiCreatedResponse({ type: CustomRoleDto })
  @ApiErrors(...COMMON, 409, 422)
  create(
    @Body() body: CreateCustomRoleDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CustomRoleDto> {
    return this.roles.create(session, body);
  }

  @Get(':id')
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: CustomRoleDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<CustomRoleDto> {
    return this.roles.get(id);
  }

  @Patch(':id')
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: CustomRoleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateCustomRoleDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CustomRoleDto> {
    return this.roles.update(session, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: CustomRoleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archive(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CustomRoleDto> {
    return this.roles.archive(session, id, body);
  }
}

/** Per-user grants and revokes and the permissions view (contract §4, §5). */
@ApiTags('users')
@Controller()
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get('users/:id/permissions')
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: UserPermissionsDto })
  @ApiErrors(...COMMON, 404, 422)
  view(@IdParam() id: bigint, @Query() query: UserPermissionsQueryDto): Promise<UserPermissionsDto> {
    return this.grants.view(id, query);
  }

  @Post('users/:id/grants')
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: GrantDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  create(
    @IdParam() id: bigint,
    @Body() body: CreateGrantDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<GrantDto> {
    return this.grants.create(session, id, body);
  }

  @Post('grants/:id/end')
  @HttpCode(200)
  @RequireCapability(Capability.ROLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: GrantDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  end(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<GrantDto> {
    return this.grants.end(session, id, body);
  }
}
