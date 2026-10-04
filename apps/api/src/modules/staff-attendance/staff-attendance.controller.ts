import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import {
  CurrentSchoolSession,
  type SchoolSessionContext,
} from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { AttendanceWritesThrottleGuard } from '../attendance/attendance-throttles';
import { CalendarRangeQueryDto } from '../calendar/calendar.dto';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  MyStaffAttendanceDto,
  StaffAmendDto,
  StaffAttendanceDto,
  StaffDayDto,
  StaffDayQueryDto,
  StaffMarkDto,
  StaffSubmitDto,
  StaffSubmitResultDto,
} from './staff-attendance.dto';
import { StaffAttendanceService } from './staff-attendance.service';

// contracts/slice-12.md §1, §4 (R133-R136). Writes and the day sheet: attendance.staff.manage;
// anyone's history: staff.view; one's own history: any active staff member.
const COMMON = [401, 403, 429];

@ApiTags('staff-attendance')
@Controller('staff-attendance')
export class StaffAttendanceController {
  constructor(private readonly service: StaffAttendanceService) {}

  @Get()
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @ApiPaginated(StaffDayDto)
  @ApiErrors(...COMMON, 422)
  day(@Query() query: StaffDayQueryDto): Promise<Page<StaffDayDto>> {
    return this.service.day(query);
  }

  /** Whole payload refused when it names the caller (R134); always 200 (decision 8). */
  @Post('submit')
  @HttpCode(200)
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @UseGuards(AttendanceWritesThrottleGuard)
  @ApiOkResponse({ type: StaffSubmitResultDto })
  @ApiErrors(...COMMON, 409, 422)
  submit(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: StaffSubmitDto,
    @Query() _query: NoQueryDto,
  ): Promise<StaffSubmitResultDto> {
    return this.service.submit(session, body);
  }

  @Post(':id/amend')
  @HttpCode(200)
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @UseGuards(AttendanceWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffMarkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  amend(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: StaffAmendDto,
    @Query() _query: NoQueryDto,
  ): Promise<StaffMarkDto> {
    return this.service.amend(session, id, body);
  }
}

/** Anyone's history, for staff.view holders (R135). */
@ApiTags('staff-attendance')
@Controller('staff')
export class StaffMemberAttendanceController {
  constructor(private readonly service: StaffAttendanceService) {}

  @Get(':id/attendance')
  @RequireCapability(Capability.STAFF_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffAttendanceDto })
  @ApiErrors(...COMMON, 404, 422)
  history(
    @IdParam() id: bigint,
    @Query() query: CalendarRangeQueryDto,
  ): Promise<StaffAttendanceDto> {
    return this.service.history(id, query);
  }
}

/** The caller's own history, without the office's note or the marker (R135, decision 6). */
@ApiTags('me')
@Controller('me')
export class MyStaffAttendanceController {
  constructor(private readonly service: StaffAttendanceService) {}

  @Get('staff/attendance')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: MyStaffAttendanceDto })
  @ApiErrors(...COMMON, 422)
  mine(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: CalendarRangeQueryDto,
  ): Promise<MyStaffAttendanceDto> {
    return this.service.myHistory(session, query);
  }
}
