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
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  ApproveDisputeDto,
  AttendanceDisputeDto,
  ListDisputesQueryDto,
  ListMyDisputesQueryDto,
  RaiseDisputeDto,
} from './attendance-disputes.dto';
import { AttendanceDisputesService } from './attendance-disputes.service';

// contracts/slice-44.md §1, §2.5, §2.6 (R346, R347).
const COMMON = [401, 403, 429];

/** phase-5-extended.md §5.1: raise, withdraw, approve and reject share one bucket. */
export const DisputeWritesThrottleGuard = perUserThrottle('dispute-writes', 20, 120);

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/** A staff member's own disputes: the staff id is the session's, never input. */
@ApiTags('me')
@Controller('me/staff/attendance-disputes')
export class MyAttendanceDisputesController {
  constructor(private readonly disputes: AttendanceDisputesService) {}

  @Get()
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiPaginated(AttendanceDisputeDto)
  @ApiErrors(...COMMON, 422)
  list(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: ListMyDisputesQueryDto,
  ): Promise<Page<AttendanceDisputeDto>> {
    return this.disputes.listMine(session, query);
  }

  @Post()
  @RequireStaff()
  @UseGuards(IdempotencyKeyGuard, DisputeWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: AttendanceDisputeDto })
  @ApiOkResponse({ type: AttendanceDisputeDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async raise(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: RaiseDisputeDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttendanceDisputeDto> {
    const outcome = await this.disputes.raise(session, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.dispute;
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequireStaff()
  @UseGuards(DisputeWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: AttendanceDisputeDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  withdraw(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<AttendanceDisputeDto> {
    return this.disputes.withdraw(session, id);
  }
}

/** The deciders' queue (attendance.staff.manage, school-wide; never one's own, R346). */
@ApiTags('staff-attendance')
@Controller('staff-attendance-disputes')
export class AttendanceDisputesController {
  constructor(private readonly disputes: AttendanceDisputesService) {}

  @Get()
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @ApiPaginated(AttendanceDisputeDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListDisputesQueryDto): Promise<Page<AttendanceDisputeDto>> {
    return this.disputes.list(query);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @UseGuards(DisputeWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: AttendanceDisputeDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  approve(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ApproveDisputeDto,
    @Query() _query: NoQueryDto,
  ): Promise<AttendanceDisputeDto> {
    return this.disputes.approve(session, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.ATTENDANCE_STAFF_MANAGE)
  @UseGuards(DisputeWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: AttendanceDisputeDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<AttendanceDisputeDto> {
    return this.disputes.reject(session, id, body);
  }
}
