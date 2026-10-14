import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability, RequireCapacity, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { PaymentDto } from '../payments/payments.dto';
import {
  AddEventDutyDto,
  CreateEventDto,
  CreateEventPaymentDto,
  EventDto,
  EventDutyDto,
  EventReportDto,
  EventRosterDto,
  EventRosterQueryDto,
  ListEventsQueryDto,
  MyEventDto,
  RecordEventParticipationDto,
  UpdateEventDto,
} from './events.dto';
import { EventActivityService } from './event-activity.service';
import { EventsService } from './events.service';
import { EventWritesThrottleGuard } from './events.throttle';

// Phase 5 slice 38 (phase-5-extended.md §5 slice 38; contracts/slice-38.md §1). Common to every
// route: 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429.
const COMMON = [401, 403, 429];

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function created<T>(res: Response, outcome: { replayed: boolean }, value: T): T {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
  return value;
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly activity: EventActivityService,
  ) {}

  /** Staff; drafts only for holiday.manage holders; `mine` for the teacher's phone (§2.9). */
  @Get()
  @RequireStaff()
  @ApiPaginated(EventDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListEventsQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<Page<EventDto>> {
    return this.events.list(session, query);
  }

  @Get(':id')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: EventDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<EventDto> {
    return this.events.get(session, id);
  }

  /** §2.1 (R310): a draft; a charge needs the campaign keys too. */
  @Post()
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(IdempotencyKeyGuard, EventWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: EventDto })
  @ApiOkResponse({ type: EventDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateEventDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventDto> {
    const outcome = await this.events.create(session, body, req.header(IDEMPOTENCY_HEADER));
    return created(res, outcome, outcome.event);
  }

  /** §2.2 (R316): a draft only. */
  @Patch(':id')
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateEventDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventDto> {
    return this.events.update(session, id, body);
  }

  /** §2.3 (rule 34). */
  @Post(':id/duties')
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiCreatedResponse({ type: EventDutyDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  addDuty(
    @IdParam() id: bigint,
    @Body() body: AddEventDutyDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventDutyDto> {
    return this.events.addDuty(session, id, body);
  }

  /** §2.4 (R310): the invitation and, when charged, the campaign, both after commit. */
  @Post(':id/publish')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  publish(@IdParam() id: bigint, @Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<EventDto> {
    return this.events.publish(session, id);
  }

  /** §2.5 (R313): charges voided or credited (the principal when any has money). */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  cancel(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventDto> {
    return this.events.cancel(session, id, body);
  }

  /** Freezes participation (R312). */
  @Post(':id/complete')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventDto })
  @ApiErrors(...COMMON, 404, 409)
  complete(@IdParam() id: bigint, @Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<EventDto> {
    return this.events.complete(session, id);
  }

  /** §2.6: holders, duty holders and the sections' class teachers (theirs); anyone else 404. */
  @Get(':id/participation')
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: EventRosterDto })
  @ApiErrors(...COMMON, 404, 422)
  roster(
    @IdParam() id: bigint,
    @Query() query: EventRosterQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventRosterDto> {
    return this.activity.roster(session, id, query);
  }

  /** §2.6 (R312): duty holders and class teachers, published only; naturally idempotent. */
  @Post(':id/record-participation')
  @HttpCode(200)
  @RequireStaff()
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventRosterDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  record(
    @IdParam() id: bigint,
    @Body() body: RecordEventParticipationDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<EventRosterDto> {
    return this.activity.record(session, id, body);
  }

  /** §2.7 (R317): a live collection duty on this event, or payment.record; cash only. */
  @Post(':id/payments')
  @RequireStaff()
  @UseGuards(IdempotencyKeyGuard, EventWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: PaymentDto })
  @ApiOkResponse({ type: PaymentDto, description: 'Replay of a committed payment' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async recordPayment(
    @IdParam() id: bigint,
    @Body() body: CreateEventPaymentDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PaymentDto> {
    const outcome = await this.activity.recordPayment(session, id, body, req.header(IDEMPOTENCY_HEADER));
    return created(res, outcome, outcome.payment);
  }

  /** A collector's own rows; payment.record holders every row. */
  @Get(':id/payments')
  @RequireStaff()
  @ApiIdParam()
  @ApiPaginated(PaymentDto)
  @ApiErrors(...COMMON, 404, 422)
  payments(
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<PaymentDto>> {
    return this.activity.listPayments(session, id, query);
  }

  /** §2.8 (R314): live totals. */
  @Get(':id/report')
  @RequireCapability(Capability.FINANCE_REPORT_VIEW, Capability.HOLIDAY_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: EventReportDto })
  @ApiErrors(...COMMON, 404, 409)
  report(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<EventReportDto> {
    return this.activity.report(id);
  }
}

@ApiTags('events')
@Controller('event-duties')
export class EventDutiesController {
  constructor(private readonly events: EventsService) {}

  /** A repeat answers 200 unchanged and writes nothing. */
  @Post(':id/end')
  @HttpCode(200)
  @RequireCapability(Capability.HOLIDAY_MANAGE)
  @UseGuards(EventWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: EventDutyDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  end(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<EventDutyDto> {
    return this.events.endDuty(id, body);
  }
}

/** The family reads (R315): every /me/* read takes the me-reads bucket. */
@ApiTags('me')
@Controller('me')
@UseGuards(MeReadsThrottleGuard)
export class MyEventsController {
  constructor(private readonly activity: EventActivityService) {}

  @Get('children/:id/events')
  @RequireCapacity('guardian')
  @ApiIdParam()
  @ApiPaginated(MyEventDto)
  @ApiErrors(...COMMON, 404, 422)
  child(
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyEventDto>> {
    return this.activity.family(session, id, query);
  }

  @Get('student/events')
  @RequireCapacity('student')
  @ApiPaginated(MyEventDto)
  @ApiErrors(...COMMON, 422)
  own(@Query() query: PageQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<Page<MyEventDto>> {
    return this.activity.family(session, null, query);
  }
}
