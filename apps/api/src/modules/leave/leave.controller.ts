import { ReasonDto } from '../../common/reason.dto';
import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  ApproveLeaveRequestDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreateMyLeaveRequestDto,
  EndLeaveEarlyDto,
  LeaveBalanceDto,
  LeaveBalanceQueryDto,
  LeaveRequestDto,
  LeaveTypeDto,
  ListLeaveRequestsQueryDto,
  ListLeaveTypesQueryDto,
  ListMyLeaveRequestsQueryDto,
  StaffLeaveRequestDto,
} from './leave.dto';
import { LeaveRequestsService, type LeaveRequestCreateOutcome } from './leave-requests.service';
import { LeaveTypesService } from './leave-types.service';

// phase-3-financial.md slice 24; contracts/slice-24.md §1. Common to every route: 401, 403, 429.
const COMMON = [401, 403, 429];

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/** A replay answers 200 with Idempotency-Replayed: true. */
function created(outcome: LeaveRequestCreateOutcome, res: Response): LeaveRequestDto {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
  return outcome.request;
}

/** Leave types: any staff member reads them; school.settings.manage writes (R209). */
@ApiTags('leave')
@Controller('leave-types')
export class LeaveTypesController {
  constructor(private readonly types: LeaveTypesService) {}

  @Get()
  @RequireStaff()
  @ApiPaginated(LeaveTypeDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListLeaveTypesQueryDto): Promise<Page<LeaveTypeDto>> {
    return this.types.list(query);
  }

  @Post()
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiCreatedResponse({ type: LeaveTypeDto })
  @ApiErrors(...COMMON, 409, 422)
  create(@Body() body: CreateLeaveTypeDto, @Query() _query: NoQueryDto): Promise<LeaveTypeDto> {
    return this.types.create(body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveTypeDto })
  @ApiErrors(...COMMON, 404, 422)
  archive(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<LeaveTypeDto> {
    return this.types.archive(id, body);
  }
}

/** A staff member's own leave: the staff id is the session's, never input (§7.1). */
@ApiTags('me')
@Controller('me/staff')
export class MyLeaveController {
  constructor(private readonly requests: LeaveRequestsService) {}

  @Get('leave-balance')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: LeaveBalanceDto })
  @ApiErrors(...COMMON, 422)
  balance(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: LeaveBalanceQueryDto,
  ): Promise<LeaveBalanceDto> {
    return this.requests.balance(this.requests.ownStaffId(session), query.year);
  }

  @Get('leave-requests')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiPaginated(LeaveRequestDto)
  @ApiErrors(...COMMON, 422)
  list(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: ListMyLeaveRequestsQueryDto,
  ): Promise<Page<LeaveRequestDto>> {
    return this.requests.listForStaff(this.requests.ownStaffId(session), query);
  }

  @Get('leave-requests/:id')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 422)
  get(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<LeaveRequestDto> {
    return this.requests.get(id, this.requests.ownStaffId(session));
  }

  @Post('leave-requests')
  @RequireStaff()
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: LeaveRequestDto })
  @ApiOkResponse({ type: LeaveRequestDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: CreateMyLeaveRequestDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaveRequestDto> {
    const staffId = this.requests.ownStaffId(session);
    return created(await this.requests.create(session, staffId, body, false, req.header(IDEMPOTENCY_HEADER)), res);
  }

  @Post('leave-requests/:id/cancel')
  @HttpCode(200)
  @RequireStaff()
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  cancel(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<LeaveRequestDto> {
    return this.requests.cancel(session, id, body);
  }
}

/** The approvers' queue and decisions (staff.leave.approve, school-wide). */
@ApiTags('leave')
@Controller('leave-requests')
export class LeaveRequestsController {
  constructor(private readonly requests: LeaveRequestsService) {}

  @Get()
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @ApiPaginated(LeaveRequestDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListLeaveRequestsQueryDto): Promise<Page<LeaveRequestDto>> {
    return this.requests.list(query);
  }

  @Get(':id')
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<LeaveRequestDto> {
    return this.requests.get(id);
  }

  /** On behalf of another staff member: pending, and decided by someone else (R210). */
  @Post()
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: LeaveRequestDto })
  @ApiOkResponse({ type: LeaveRequestDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: CreateLeaveRequestDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaveRequestDto> {
    const staffId = BigInt(body.staffId);
    return created(await this.requests.create(session, staffId, body, true, req.header(IDEMPOTENCY_HEADER)), res);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  approve(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ApproveLeaveRequestDto,
    @Query() _query: NoQueryDto,
  ): Promise<LeaveRequestDto> {
    return this.requests.approve(session, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<LeaveRequestDto> {
    return this.requests.reject(session, id, body);
  }

  @Post(':id/end-early')
  @HttpCode(200)
  @RequireCapability(Capability.STAFF_LEAVE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveRequestDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  endEarly(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: EndLeaveEarlyDto,
    @Query() _query: NoQueryDto,
  ): Promise<LeaveRequestDto> {
    return this.requests.endEarly(session, id, body);
  }
}

/** Any staff member's balance and requests, for staff.view holders. */
@ApiTags('leave')
@Controller('staff')
export class StaffLeaveController {
  constructor(private readonly requests: LeaveRequestsService) {}

  @Get(':id/leave-balance')
  @RequireCapability(Capability.STAFF_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: LeaveBalanceDto })
  @ApiErrors(...COMMON, 404, 422)
  balance(@IdParam() id: bigint, @Query() query: LeaveBalanceQueryDto): Promise<LeaveBalanceDto> {
    return this.requests.balance(id, query.year);
  }

  /** Without reason and decisionReason, which can be medical (StaffLeaveRequestDto). */
  @Get(':id/leave-requests')
  @RequireCapability(Capability.STAFF_VIEW)
  @ApiIdParam()
  @ApiPaginated(StaffLeaveRequestDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@IdParam() id: bigint, @Query() query: ListMyLeaveRequestsQueryDto): Promise<Page<StaffLeaveRequestDto>> {
    return this.requests.listForStaffView(id, query);
  }
}
