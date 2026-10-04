import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { AttendanceReadsService } from './attendance-reads.service';
import { StudentAttendanceDto, StudentAttendanceQueryDto } from './attendance.dto';

// contracts/slice-11.md §1.4, §10.4 (R130, R164, R165): a guardian's linked children and a
// student's own attendance. The guard binds the capacity scope (contracts/slice-13.md §1.2); a
// child outside it is 404. The same DTO as the staff route: no note, teacher or alert state.
const COMMON = [401, 403, 429];

@ApiTags('me')
@Controller('me')
@UseGuards(MeReadsThrottleGuard)
export class MyAttendanceController {
  constructor(private readonly reads: AttendanceReadsService) {}

  @Get('children/:id/attendance')
  @RequireCapacity('guardian')
  @ApiIdParam()
  @ApiOkResponse({ type: StudentAttendanceDto })
  @ApiErrors(...COMMON, 404, 422)
  child(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    return this.reads.forCapacity(session, id, query);
  }

  @Get('student/attendance')
  @RequireCapacity('student')
  @ApiOkResponse({ type: StudentAttendanceDto })
  @ApiErrors(...COMMON, 422)
  own(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    return this.reads.forCapacity(session, null, query);
  }
}
