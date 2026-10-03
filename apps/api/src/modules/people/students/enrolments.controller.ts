import { Body, Controller, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import {
  CurrentSchoolSession,
  type SchoolSessionContext,
} from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { NoQueryDto } from '../../../common/validation';
import { EnrolmentsService } from './enrolments.service';
import { ChangeClassDto, ChangeSectionDto, EnrolmentDto, UpdateEnrolmentDto } from './students.dto';

// contracts/slice-6.md §5 (R37-R39). All `enrolment.manage`, scoped through the student.
const COMMON = [401, 403, 404, 429];

@ApiTags('students')
@Controller('enrolments')
export class EnrolmentsController {
  constructor(private readonly enrolments: EnrolmentsService) {}

  @Patch(':id')
  @RequireCapability(Capability.ENROLMENT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: EnrolmentDto })
  @ApiErrors(...COMMON, 409, 422)
  update(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: UpdateEnrolmentDto,
    @Query() _query: NoQueryDto,
  ): Promise<EnrolmentDto> {
    return this.enrolments.setRollNo(session, id, body);
  }

  @Post(':id/change-section')
  @HttpCode(200)
  @RequireCapability(Capability.ENROLMENT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: EnrolmentDto })
  @ApiErrors(...COMMON, 409, 422)
  changeSection(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ChangeSectionDto,
    @Query() _query: NoQueryDto,
  ): Promise<EnrolmentDto> {
    return this.enrolments.changeSection(session, id, body);
  }

  /** Returns the new enrolment. */
  @Post(':id/change-class')
  @HttpCode(200)
  @RequireCapability(Capability.ENROLMENT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: EnrolmentDto })
  @ApiErrors(...COMMON, 409, 422)
  changeClass(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ChangeClassDto,
    @Query() _query: NoQueryDto,
  ): Promise<EnrolmentDto> {
    return this.enrolments.changeClass(session, id, body);
  }
}
