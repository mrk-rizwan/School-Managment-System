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
import { GuardianLinksService } from './guardian-links.service';
import { GuardianLinkDto, UpdateGuardianLinkDto } from './students.dto';
import { ReasonDto } from '../../../common/reason.dto';

// contracts/slice-6.md §4 (R28-R30). All `guardian.manage`, scoped through the student.
const COMMON = [401, 403, 404, 429];

@ApiTags('students')
@Controller('guardian-links')
export class GuardianLinksController {
  constructor(private readonly links: GuardianLinksService) {}

  @Patch(':id')
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: GuardianLinkDto })
  @ApiErrors(...COMMON, 409, 422)
  update(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: UpdateGuardianLinkDto,
    @Query() _query: NoQueryDto,
  ): Promise<GuardianLinkDto> {
    return this.links.update(session, id, body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequireCapability(Capability.GUARDIAN_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: GuardianLinkDto })
  @ApiErrors(...COMMON, 409, 422)
  end(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<GuardianLinkDto> {
    return this.links.end(session, id, body);
  }
}
