import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedOnly, RequireStaff } from '../../common/auth/route-access';
import { ApiErrors } from '../../common/openapi';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { CalendarRangeQueryDto, MyCalendarDto, TeachingDaysDto } from './calendar.dto';
import { CalendarReadsService } from './calendar-reads.service';

// contracts/slice-10.md §5. Bounded objects, not pages; informational (R116), nothing stored.

@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly reads: CalendarReadsService) {}

  @Get('teaching-days')
  @RequireStaff()
  @ApiOkResponse({ type: TeachingDaysDto })
  @ApiErrors(401, 403, 422, 429)
  teachingDays(@Query() query: CalendarRangeQueryDto): Promise<TeachingDaysDto> {
    return this.reads.teachingDays(query);
  }
}

/** The published calendar of the caller's own school, for any signed-in person (§5.2, R166). */
@ApiTags('me')
@Controller('me')
export class MyCalendarController {
  constructor(private readonly reads: CalendarReadsService) {}

  @Get('calendar')
  @AuthenticatedOnly()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: MyCalendarDto })
  @ApiErrors(401, 403, 422, 429)
  myCalendar(@Query() query: CalendarRangeQueryDto): Promise<MyCalendarDto> {
    return this.reads.myCalendar(query);
  }
}
