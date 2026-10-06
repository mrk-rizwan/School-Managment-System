import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { ApprovalsDto } from './approvals.dto';
import { ApprovalsService } from './approvals.service';

/**
 * The Approvals tab and page (phase-3-financial.md slice 27, R227; contracts/slice-27.md). Any
 * active staff member may ask; the answer holds only the sections whose key they hold, so a staff
 * member with none of the four gets `{}`, never 403. It writes nothing.
 */
@ApiTags('approvals')
@Controller('me/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: ApprovalsDto })
  @ApiErrors(401, 403, 429)
  get(@Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<ApprovalsDto> {
    return this.approvals.forCaller(session);
  }
}
