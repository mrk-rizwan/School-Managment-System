import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import {
  CurrentSchoolSession,
  type SchoolSessionContext,
} from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../../common/pagination';
import {
  oneIfBodyHasString,
  identityProbeThrottle,
  IdentityProbeThrottleGuard,
} from '../../../common/rate-limit';
import { NoQueryDto } from '../../../common/validation';
import { IssueLoginDto, UserDto } from '../../users/users.dto';
import { EnrolmentsService } from './enrolments.service';
import { GuardianLinksService } from './guardian-links.service';
import { StudentLoginService } from './student-login.service';
import {
  ChangeStatusDto,
  CreateGuardianLinkDto,
  EnrolmentDto,
  GuardianLinkDto,
  ListGuardianLinksQueryDto,
  ListStudentsQueryDto,
  StatusChangeDto,
  StudentDetailDto,
  StudentDto,
  StudentLookupDto,
  StudentLookupResultDto,
  UpdateStudentDto,
} from './students.dto';
import { StudentsService } from './students.service';

// contracts/slice-6.md §3-§4. Common to every route: 401, 403 PERMISSION_DENIED / SCHOOL_SUSPENDED
// / ORIGIN_REJECTED, 429. Scoped routes 404 a student outside the caller's sections (§1).
// Documents, the photo and readmission are slice 6B's routes under the same prefix.
const COMMON = [401, 403, 429];

/** A patch that sets a B-Form can answer STUDENT_BFORM_EXISTS: it spends the probe budget. */
export const BFormPatchThrottleGuard = identityProbeThrottle(oneIfBodyHasString('bForm'));

@ApiTags('students')
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly links: GuardianLinksService,
    private readonly enrolments: EnrolmentsService,
    private readonly logins: StudentLoginService,
  ) {}

  @Get()
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiPaginated(StudentDto)
  @ApiErrors(...COMMON, 422)
  list(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: ListStudentsQueryDto,
  ): Promise<Page<StudentDto>> {
    return this.students.list(session, query);
  }

  /** B-Form in the body, never in the URL. Throttled per user: a B-Form oracle. */
  @Post('lookup')
  @HttpCode(200)
  @RequireCapability(Capability.STUDENT_CREATE)
  @UseGuards(IdentityProbeThrottleGuard)
  @ApiOkResponse({ type: StudentLookupResultDto })
  @ApiErrors(...COMMON, 422)
  lookup(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: StudentLookupDto,
    @Query() _query: NoQueryDto,
  ): Promise<StudentLookupResultDto> {
    return this.students.lookup(session, body);
  }

  @Get(':id')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDetailDto })
  @ApiErrors(...COMMON, 404, 422)
  get(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<StudentDetailDto> {
    return this.students.get(session, id);
  }

  @Patch(':id')
  @RequireCapability(Capability.STUDENT_UPDATE)
  @UseGuards(BFormPatchThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: UpdateStudentDto,
    @Query() _query: NoQueryDto,
  ): Promise<StudentDetailDto> {
    return this.students.update(session, id, body);
  }

  @Post(':id/change-status')
  @HttpCode(200)
  @RequireCapability(Capability.STUDENT_STATUS_CHANGE)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  changeStatus(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ChangeStatusDto,
    @Query() _query: NoQueryDto,
  ): Promise<StudentDetailDto> {
    return this.students.changeStatus(session, id, body);
  }

  @Get(':id/status-changes')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(StatusChangeDto)
  @ApiErrors(...COMMON, 404, 422)
  statusChanges(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
  ): Promise<Page<StatusChangeDto>> {
    return this.students.statusChangeList(session, id, query);
  }

  @Get(':id/enrolments')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(EnrolmentDto)
  @ApiErrors(...COMMON, 404, 422)
  enrolmentList(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
  ): Promise<Page<EnrolmentDto>> {
    return this.enrolments.listForStudent(session, id, query);
  }

  @Get(':id/guardian-links')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(GuardianLinkDto)
  @ApiErrors(...COMMON, 404, 422)
  guardianLinks(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: ListGuardianLinksQueryDto,
  ): Promise<Page<GuardianLinkDto>> {
    return this.links.list(session, id, query);
  }

  @Post(':id/guardian-links')
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: GuardianLinkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  createGuardianLink(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: CreateGuardianLinkDto,
    @Query() _query: NoQueryDto,
  ): Promise<GuardianLinkDto> {
    return this.links.create(session, id, body);
  }

  @Post(':id/issue-login')
  @RequireCapability(Capability.USER_ACCOUNT_MANAGE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: UserDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  issueLogin(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: IssueLoginDto,
    @Query() _query: NoQueryDto,
  ): Promise<UserDto> {
    return this.logins.issueLogin(session, id, body);
  }
}
