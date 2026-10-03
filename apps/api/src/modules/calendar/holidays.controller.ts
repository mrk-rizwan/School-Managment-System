import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
import {
  CancelHolidayDto,
  CreateHolidayDto,
  HolidayDto,
  ListHolidaysQueryDto,
  UpdateHolidayDto,
} from './calendar.dto';
import { HolidaysService } from './holidays.service';

// contracts/slice-10.md §1, §4. Reads: any active staff (drafts only with holiday.manage);
// writes: holiday.manage.
const COMMON = [401, 403, 429];

@ApiTags('calendar')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @RequireStaff()
  @ApiPaginated(HolidayDto)
  @ApiErrors(...COMMON, 422)
  list(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: ListHolidaysQueryDto,
  ): Promise<Page<HolidayDto>> {
    return this.holidays.list(session, query);
  }

  @Post()
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @ApiCreatedResponse({ type: HolidayDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateHolidayDto, @Query() _query: NoQueryDto): Promise<HolidayDto> {
    return this.holidays.create(body);
  }

  @Get(':id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: HolidayDto })
  @ApiErrors(...COMMON, 404, 422)
  get(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<HolidayDto> {
    return this.holidays.get(session, id);
  }

  @Patch(':id')
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: HolidayDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateHolidayDto,
    @Query() _query: NoQueryDto,
  ): Promise<HolidayDto> {
    return this.holidays.update(id, body);
  }

  /** Sends the holiday notice (R117) unless the holiday is wholly past; retry-safe. */
  @Post(':id/publish')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: HolidayDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  publish(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<HolidayDto> {
    return this.holidays.publish(id);
  }

  /** Final. A published future holiday sends a cancellation to everyone told. */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: HolidayDto })
  @ApiErrors(...COMMON, 404, 422)
  cancel(
    @IdParam() id: bigint,
    @Body() body: CancelHolidayDto,
    @Query() _query: NoQueryDto,
  ): Promise<HolidayDto> {
    return this.holidays.cancel(id, body);
  }
}
