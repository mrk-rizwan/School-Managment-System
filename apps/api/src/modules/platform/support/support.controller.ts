import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../../common/pagination';
import { NoQueryDto } from '../../../common/validation';
import { AuditEntryDto, ListAuditLogQueryDto } from '../../audit/audit.dto';
import { PlatformStepUp } from '../auth/platform-step-up';
import { SupportOpenThrottleGuard, SupportReadsThrottleGuard, SupportSessionGuard } from './support-guards';
import { SupportSessionsService } from './support-sessions.service';
import { SupportViewsService } from './support-views.service';
import {
  CloseSupportSessionDto,
  ListSupportSessionsQueryDto,
  OpenSupportSessionDto,
  SupportChargeDto,
  SupportPaymentDto,
  SupportSchoolSettingsDto,
  SupportSessionDto,
  SupportStudentDto,
  SupportStudentsQueryDto,
  SupportStudentSummaryDto,
} from './support.dto';

// Phase 5 slice 45 (contracts/slice-45.md §1): platform support access, the platform's side. Every
// route is @PlatformSession('full').

@ApiTags('platform support')
@Controller('platform')
export class SupportSessionsController {
  constructor(
    private readonly sessions: SupportSessionsService,
    private readonly stepUp: PlatformStepUp,
  ) {}

  /** R349: a reason, a ticket and a fresh second factor; 409 on an open school or a fourth session. */
  @Post('schools/:id/support-sessions')
  @HttpCode(201)
  @PlatformSession()
  @UseGuards(SupportOpenThrottleGuard)
  @ApiIdParam()
  @ApiCreatedResponse({ type: SupportSessionDto })
  @ApiErrors(401, 403, 404, 409, 422, 429)
  async open(
    @IdParam() id: bigint,
    @Body() body: OpenSupportSessionDto,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<SupportSessionDto> {
    await this.stepUp.verify(session.userId, body.totp);
    return this.sessions.open(session.userId, id, body);
  }

  @Get('support-sessions')
  @PlatformSession()
  @ApiPaginated(SupportSessionDto)
  @ApiErrors(401, 403, 422)
  list(
    @Query() query: ListSupportSessionsQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<Page<SupportSessionDto>> {
    return this.sessions.list(session.userId, query);
  }

  @Get('support-sessions/:id')
  @PlatformSession()
  @ApiIdParam()
  @ApiOkResponse({ type: SupportSessionDto })
  @ApiErrors(401, 403, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<SupportSessionDto> {
    return this.sessions.get(session.userId, id);
  }

  /** The holder only (another admin's session is 404); an ended session is 403. */
  @Post('support-sessions/:id/close')
  @HttpCode(200)
  @PlatformSession()
  @ApiIdParam()
  @ApiOkResponse({ type: SupportSessionDto })
  @ApiErrors(401, 403, 404, 422)
  close(
    @IdParam() id: bigint,
    @Body() body: CloseSupportSessionDto,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<SupportSessionDto> {
    return this.sessions.close(session.userId, id, body.reason);
  }
}

/**
 * The closed set of read views (§1.1 "Support views", R351). Each passes SupportSessionGuard (open,
 * the caller's own: else 404 / 403 SUPPORT_SESSION_ENDED) and the `support-reads` throttle, reads
 * READ ONLY and is written to both audit logs.
 */
@ApiTags('platform support')
@Controller('platform/support-sessions/:id')
@UseGuards(SupportReadsThrottleGuard, SupportSessionGuard)
export class SupportViewsController {
  constructor(private readonly views: SupportViewsService) {}

  @Get('settings')
  @PlatformSession()
  @ApiIdParam()
  @ApiOkResponse({ type: SupportSchoolSettingsDto })
  @ApiErrors(401, 403, 404, 429)
  settings(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<SupportSchoolSettingsDto> {
    return this.views.settings({ platformUserId: session.userId, sessionId: id });
  }

  @Get('students')
  @PlatformSession()
  @ApiIdParam()
  @ApiPaginated(SupportStudentSummaryDto)
  @ApiErrors(401, 403, 404, 422, 429)
  students(
    @IdParam() id: bigint,
    @Query() query: SupportStudentsQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<Page<SupportStudentSummaryDto>> {
    return this.views.students({ platformUserId: session.userId, sessionId: id }, query);
  }

  @Get('students/:studentId')
  @PlatformSession()
  @ApiIdParam()
  @ApiIdParam('studentId')
  @ApiOkResponse({ type: SupportStudentDto })
  @ApiErrors(401, 403, 404, 429)
  student(
    @IdParam() id: bigint,
    @IdParam('studentId') studentId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<SupportStudentDto> {
    return this.views.student({ platformUserId: session.userId, sessionId: id }, studentId);
  }

  @Get('students/:studentId/charges')
  @PlatformSession()
  @ApiIdParam()
  @ApiIdParam('studentId')
  @ApiPaginated(SupportChargeDto)
  @ApiErrors(401, 403, 404, 422, 429)
  charges(
    @IdParam() id: bigint,
    @IdParam('studentId') studentId: bigint,
    @Query() query: PageQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<Page<SupportChargeDto>> {
    return this.views.charges({ platformUserId: session.userId, sessionId: id }, studentId, query);
  }

  @Get('students/:studentId/payments')
  @PlatformSession()
  @ApiIdParam()
  @ApiIdParam('studentId')
  @ApiPaginated(SupportPaymentDto)
  @ApiErrors(401, 403, 404, 422, 429)
  payments(
    @IdParam() id: bigint,
    @IdParam('studentId') studentId: bigint,
    @Query() query: PageQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<Page<SupportPaymentDto>> {
    return this.views.payments({ platformUserId: session.userId, sessionId: id }, studentId, query);
  }

  /** The school's audit log with the audit screen's filters, exclusions and masking (slice 46). */
  @Get('audit-log')
  @PlatformSession()
  @ApiIdParam()
  @ApiPaginated(AuditEntryDto)
  @ApiErrors(401, 403, 404, 422, 429)
  auditLog(
    @IdParam() id: bigint,
    @Query() query: ListAuditLogQueryDto,
    @CurrentPlatformSession() session: PlatformSessionContext,
  ): Promise<Page<AuditEntryDto>> {
    return this.views.auditLog({ platformUserId: session.userId, sessionId: id }, query);
  }
}
