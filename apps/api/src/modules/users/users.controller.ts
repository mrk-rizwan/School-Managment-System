import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { AllowWhenSuspended, RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { ListUsersQueryDto, OfficeResetDto, ReasonDto, UserDto } from './users.dto';
import { UsersService } from './users.service';

/** contracts/slice-2.md §5. */
@ApiTags('users')
@Controller('users')
@RequireCapability(Capability.USER_ACCOUNT_MANAGE)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiPaginated(UserDto)
  @ApiErrors(401, 403, 422)
  list(
    @Query() query: ListUsersQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<UserDto>> {
    return this.users.list(session.schoolId, query);
  }

  @Get(':id')
  @ApiIdParam()
  @ApiOkResponse({ type: UserDto })
  @ApiErrors(401, 403, 404, 422)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserDto> {
    return this.users.get(session.schoolId, id);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @AllowWhenSuspended()
  @ApiIdParam()
  @ApiOkResponse({ type: UserDto })
  @ApiErrors(401, 403, 404, 409, 422)
  reset(
    @IdParam() id: bigint,
    @Body() body: OfficeResetDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserDto> {
    return this.users.officeReset(session, id, body);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @AllowWhenSuspended()
  @ApiIdParam()
  @ApiOkResponse({ type: UserDto })
  @ApiErrors(401, 403, 404, 409, 422)
  disable(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserDto> {
    return this.users.disable(session, id, body);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ApiIdParam()
  @ApiOkResponse({ type: UserDto })
  @ApiErrors(401, 403, 404, 409, 422)
  enable(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<UserDto> {
    return this.users.enable(session, id, body);
  }
}
