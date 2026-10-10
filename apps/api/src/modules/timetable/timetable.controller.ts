import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability, RequireCapacity, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  CreateSubstitutionDto,
  CreateTimetableVersionDto,
  ListSubstitutionsQueryDto,
  ListTimetableVersionsQueryDto,
  MyStaffTimetableDto,
  MyStaffTimetableQueryDto,
  MyTimetableDto,
  SectionTimetableDto,
  TimetableGridDto,
  TimetableGridQueryDto,
  TimetableSubstitutionDto,
  TimetableVersionDetailDto,
  TimetableVersionDto,
  TimetableWeekQueryDto,
} from './timetable.dto';
import { TimetableViewsService } from './timetable-views.service';
import { TimetableService } from './timetable.service';

// phase-5-extended.md slice 37; contracts/slice-37.md §1. Common to every route: 401, 403
// PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429.
const COMMON = [401, 403, 429];

/** §1: the timetable writes, 30/min and 300/h per user (phase-5-extended.md §5.1). */
export const TimetableWritesThrottleGuard = perUserThrottle('timetable-writes', 30, 300);

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function created<T>(res: Response, outcome: { replayed: boolean }, value: T): T {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
  return value;
}

@ApiTags('timetable')
@Controller('sections')
export class SectionTimetableController {
  constructor(
    private readonly timetable: TimetableService,
    private readonly views: TimetableViewsService,
  ) {}

  /** §2.6 (R309): any staff member reads any section's week. */
  @Get(':id/timetable')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: SectionTimetableDto })
  @ApiErrors(...COMMON, 404, 422)
  week(
    @IdParam() id: bigint,
    @Query() query: TimetableWeekQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<SectionTimetableDto> {
    return this.views.sectionWeek(session, id, query.date);
  }

  /** §2.2 (R301-R303): a whole-week version from a date; supersedes the live one. */
  @Post(':id/timetable-versions')
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @UseGuards(IdempotencyKeyGuard, TimetableWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: TimetableVersionDetailDto })
  @ApiOkResponse({ type: TimetableVersionDetailDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async createVersion(
    @IdParam() id: bigint,
    @Body() body: CreateTimetableVersionDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TimetableVersionDetailDto> {
    const outcome = await this.timetable.createVersion(id, body, req.header(IDEMPOTENCY_HEADER));
    return created(res, outcome, outcome.version);
  }

  /** §2.4 (R306): one date and period, a named substitute. */
  @Post(':id/timetable-substitutions')
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @UseGuards(IdempotencyKeyGuard, TimetableWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: TimetableSubstitutionDto })
  @ApiOkResponse({ type: TimetableSubstitutionDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async createSubstitution(
    @IdParam() id: bigint,
    @Body() body: CreateSubstitutionDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TimetableSubstitutionDto> {
    const outcome = await this.timetable.createSubstitution(id, body, req.header(IDEMPOTENCY_HEADER));
    return created(res, outcome, outcome.substitution);
  }
}

@ApiTags('timetable')
@Controller('timetable-versions')
export class TimetableVersionsController {
  constructor(private readonly timetable: TimetableService) {}

  @Get()
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @ApiPaginated(TimetableVersionDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListTimetableVersionsQueryDto): Promise<Page<TimetableVersionDto>> {
    return this.timetable.listVersions(query);
  }

  @Get(':id')
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: TimetableVersionDetailDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<TimetableVersionDetailDto> {
    return this.timetable.getVersion(id);
  }

  /** §2.3 (R301): a future version only; restores its predecessor. */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @UseGuards(TimetableWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TimetableVersionDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<TimetableVersionDetailDto> {
    return this.timetable.voidVersion(id, body);
  }
}

@ApiTags('timetable')
@Controller('timetable-substitutions')
export class TimetableSubstitutionsController {
  constructor(private readonly timetable: TimetableService) {}

  @Get()
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @ApiPaginated(TimetableSubstitutionDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListSubstitutionsQueryDto): Promise<Page<TimetableSubstitutionDto>> {
    return this.timetable.listSubstitutions(query);
  }

  /** A repeat answers 200 unchanged and writes nothing. */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @UseGuards(TimetableWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TimetableSubstitutionDto })
  @ApiErrors(...COMMON, 404, 422)
  void(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<TimetableSubstitutionDto> {
    return this.timetable.voidSubstitution(id, body);
  }
}

@ApiTags('timetable')
@Controller('timetable')
export class TimetableGridController {
  constructor(private readonly views: TimetableViewsService) {}

  /** §2.8: the principal's grid — the year's sections × periods of one weekday. */
  @Get('grid')
  @RequireCapability(Capability.TIMETABLE_MANAGE)
  @ApiOkResponse({ type: TimetableGridDto })
  @ApiErrors(...COMMON, 422)
  grid(
    @Query() query: TimetableGridQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<TimetableGridDto> {
    return this.views.grid(session.schoolId, query);
  }
}

/** The family and own-week reads (R308): every /me/* read takes the me-reads bucket. */
@ApiTags('me')
@Controller('me')
@UseGuards(MeReadsThrottleGuard)
export class MyTimetableController {
  constructor(private readonly views: TimetableViewsService) {}

  @Get('children/:id/timetable')
  @RequireCapacity('guardian')
  @ApiIdParam()
  @ApiOkResponse({ type: MyTimetableDto })
  @ApiErrors(...COMMON, 404, 422)
  child(
    @IdParam() id: bigint,
    @Query() query: TimetableWeekQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyTimetableDto> {
    return this.views.family(session, id, query.date);
  }

  @Get('student/timetable')
  @RequireCapacity('student')
  @ApiOkResponse({ type: MyTimetableDto })
  @ApiErrors(...COMMON, 422)
  own(@Query() query: TimetableWeekQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<MyTimetableDto> {
    return this.views.family(session, null, query.date);
  }

  @Get('staff/timetable')
  @RequireStaff()
  @ApiOkResponse({ type: MyStaffTimetableDto })
  @ApiErrors(...COMMON, 422)
  staff(
    @Query() query: MyStaffTimetableQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyStaffTimetableDto> {
    return this.views.staffWeek(session, query.weekOf);
  }
}
