import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import { StudentProfileDto } from './student-profile.dto';
import { StudentProfileService } from './student-profile.service';

/** Phase 5 slice 42 (R334): the one-page student profile the web prints. */
@ApiTags('students')
@Controller('students')
export class StudentProfileController {
  constructor(private readonly profiles: StudentProfileService) {}

  /** Scoped student.view: a student outside the caller's scope is 404 (R338). */
  @Get(':id/profile')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentProfileDto })
  @ApiErrors(401, 403, 404, 422, 429)
  profile(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StudentProfileDto> {
    return this.profiles.profile(session, id);
  }
}
