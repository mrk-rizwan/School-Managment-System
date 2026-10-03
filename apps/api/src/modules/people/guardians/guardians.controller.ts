import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import {
  CurrentSchoolSession,
  scopeOf,
  type SchoolSessionContext,
} from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { CnicProbeThrottleGuard, IdentityProbeThrottleGuard } from '../../../common/rate-limit';
import { NoQueryDto } from '../../../common/validation';
import { IssueLoginDto, UserDto } from '../../users/users.dto';
import { GuardianLoginService } from './guardian-login.service';
import {
  CreateGuardianDto,
  GuardianDetailDto,
  GuardianDto,
  GuardianLookupDto,
  GuardianLookupResultDto,
  GuardianStudentDto,
  ListGuardiansQueryDto,
  ListGuardianStudentsQueryDto,
  UpdateGuardianDto,
} from './guardians.dto';
import { GuardiansService } from './guardians.service';

// contracts/slice-5.md. Common to every route: 401, 403 PERMISSION_DENIED / SCHOOL_SUSPENDED /
// ORIGIN_REJECTED, 429.
const COMMON = [401, 403, 429];

@ApiTags('guardians')
@Controller('guardians')
export class GuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly logins: GuardianLoginService,
  ) {}

  @Get()
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiPaginated(GuardianDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListGuardiansQueryDto): Promise<Page<GuardianDto>> {
    return this.guardians.list(query);
  }

  @Post()
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @UseGuards(CnicProbeThrottleGuard)
  @ApiCreatedResponse({ type: GuardianDetailDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateGuardianDto, @Query() _query: NoQueryDto): Promise<GuardianDetailDto> {
    return this.guardians.create(body);
  }

  /** CNIC or phone in the body, never in the URL (§3.6). Throttled per user: a CNIC oracle. */
  @Post('lookup')
  @HttpCode(200)
  @RequireCapability(Capability.STUDENT_CREATE, Capability.GUARDIAN_MANAGE)
  @UseGuards(IdentityProbeThrottleGuard)
  @ApiOkResponse({ type: GuardianLookupResultDto })
  @ApiErrors(...COMMON, 422)
  lookup(
    @Body() body: GuardianLookupDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<GuardianLookupResultDto> {
    return this.guardians.lookup(scopeOf(session), body);
  }

  @Get(':id')
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: GuardianDetailDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<GuardianDetailDto> {
    return this.guardians.get(id);
  }

  @Get(':id/students')
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiIdParam()
  @ApiPaginated(GuardianStudentDto)
  @ApiErrors(...COMMON, 404, 422)
  students(
    @IdParam() id: bigint,
    @Query() query: ListGuardianStudentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<GuardianStudentDto>> {
    return this.guardians.students(scopeOf(session), id, query);
  }

  @Patch(':id')
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @UseGuards(CnicProbeThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: GuardianDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateGuardianDto,
    @Query() _query: NoQueryDto,
  ): Promise<GuardianDetailDto> {
    return this.guardians.update(id, body);
  }

  @Post(':id/issue-login')
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: UserDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  issueLogin(
    @IdParam() id: bigint,
    @Body() body: IssueLoginDto,
    @Query() _query: NoQueryDto,
  ): Promise<UserDto> {
    return this.logins.issueLogin(id, body);
  }
}
