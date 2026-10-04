import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiExtraModels, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { AttendanceReadsService } from './attendance-reads.service';
import { AttendanceWritesThrottleGuard } from './attendance-throttles';
import {
  AbsenteeRowDto,
  AbsenteesQueryDto,
  AmendMarkDto,
  AttendanceMarkDto,
  DailySummaryDto,
  DailySummaryQueryDto,
  LateQueryDto,
  ListRegistersQueryDto,
  MarkChangeDto,
  MarkChangesQueryDto,
  PercentageQueryDto,
  PercentageRowDto,
  RecordArrivalDto,
  RegisterQueryDto,
  RegisterSubmitMinimalResultDto,
  RegisterSubmitResultDto,
  RegisterViewDto,
  SectionDayDto,
  StudentAttendanceDto,
  StudentAttendanceQueryDto,
  SubmitRegisterDto,
  minimalSubmitResult,
  prefersMinimal,
} from './attendance.dto';
import { MarksService } from './marks.service';
import { RegistersService } from './registers.service';

// contracts/slice-11.md §1.1. A row outside the caller's scope is 404; the one 403 after the scope
// check is a subject teacher in daily mode. Writes share one per-user bucket (§1.5).

const { ATTENDANCE_STUDENT_MARK: MARK, ATTENDANCE_STUDENT_VIEW_ALL: VIEW_ALL, STUDENT_VIEW } = Capability;
const COMMON = [401, 403, 426, 429];

@ApiTags('attendance')
@Controller()
export class AttendanceController {
  constructor(
    private readonly registers: RegistersService,
    private readonly marks: MarksService,
    private readonly reads: AttendanceReadsService,
  ) {}

  /** §4.1: the register of a section-day-period, or the empty one to fill in. */
  @Get('sections/:id/register')
  @RequireCapability(MARK, VIEW_ALL)
  @ApiIdParam()
  @ApiOkResponse({ type: RegisterViewDto })
  @ApiErrors(...COMMON, 404, 422)
  register(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: RegisterQueryDto,
  ): Promise<RegisterViewDto> {
    return this.registers.view(session, id, query);
  }

  /**
   * §4.2: 201 when this request created the register, 200 otherwise (a replay included). With
   * `Prefer: return=minimal` each mark is only `{ id, enrolmentId, outcome }` and the answer says
   * `Preference-Applied: return=minimal` (slice-16 R160: the app's daily data budget).
   */
  @Post('sections/:id/submit-register')
  @RequireCapability(MARK)
  @UseGuards(AttendanceWritesThrottleGuard)
  @ApiIdParam()
  @ApiHeader({
    name: 'Prefer',
    required: false,
    description:
      'return=minimal: each mark is answered as { id, enrolmentId, outcome } (RegisterSubmitMinimalResultDto), with Preference-Applied: return=minimal. Absent: the full RegisterSubmitResultDto.',
  })
  @ApiExtraModels(RegisterSubmitMinimalResultDto)
  @ApiCreatedResponse({ type: RegisterSubmitResultDto, description: 'RegisterSubmitMinimalResultDto with Prefer: return=minimal' })
  @ApiOkResponse({ type: RegisterSubmitResultDto, description: 'RegisterSubmitMinimalResultDto with Prefer: return=minimal' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async submit(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: SubmitRegisterDto,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterSubmitResultDto | RegisterSubmitMinimalResultDto> {
    const result = await this.registers.submit(session, id, body);
    res.status(result.created ? 201 : 200);
    res.vary('Prefer');
    // A header, not a body field: read from the request rather than a decorated parameter, which
    // must be a validated DTO (asms/no-brand-in-request).
    if (!prefersMinimal(res.req.get('prefer'))) return result;
    res.setHeader('Preference-Applied', 'return=minimal');
    return minimalSubmitResult(result);
  }

  /** §4.3: one mark, with a reason; online-only in the app. */
  @Post('attendance-marks/:id/amend')
  @HttpCode(200)
  @RequireCapability(MARK)
  @UseGuards(AttendanceWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: AttendanceMarkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  amend(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Body() body: AmendMarkDto,
    @Query() _query: NoQueryDto,
  ): Promise<AttendanceMarkDto> {
    return this.marks.amend(session, id, body);
  }

  /** §4.5: a mark's change rows (staff only; reasons are never shown to parents). */
  @Get('attendance-marks/:id/changes')
  @RequireCapability(MARK, VIEW_ALL)
  @ApiIdParam()
  @ApiPaginated(MarkChangeDto)
  @ApiErrors(...COMMON, 404, 422)
  changes(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: MarkChangesQueryDto,
  ): Promise<Page<MarkChangeDto>> {
    return this.marks.changes(session, id, query);
  }

  /** §4.4 (R168): the gate records a late arrival on the day's first absent mark. */
  @Post('attendance-arrivals')
  @HttpCode(200)
  @RequireCapability(MARK)
  @UseGuards(AttendanceWritesThrottleGuard)
  @ApiOkResponse({ type: AttendanceMarkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  arrival(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Body() body: RecordArrivalDto,
    @Query() _query: NoQueryDto,
  ): Promise<AttendanceMarkDto> {
    return this.marks.arrival(session, body);
  }

  /** §10.1 (R129): the registers console, live; the principal's tile is `recorded=false`. */
  @Get('attendance-registers')
  @RequireCapability(VIEW_ALL, MARK)
  @ApiPaginated(SectionDayDto)
  @ApiErrors(...COMMON, 422)
  list(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: ListRegistersQueryDto,
  ): Promise<Page<SectionDayDto>> {
    return this.reads.registersOn(session, query);
  }

  /** §10.2 (R131): section summaries in a range of at most 92 days. */
  @Get('attendance-reports/daily-summary')
  @RequireCapability(VIEW_ALL, MARK)
  @ApiPaginated(DailySummaryDto)
  @ApiErrors(...COMMON, 422)
  dailySummary(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: DailySummaryQueryDto,
  ): Promise<Page<DailySummaryDto>> {
    return this.reads.dailySummary(session, query);
  }

  /** §10.3: derived absent, partial and on-leave days of a date. */
  @Get('attendance-reports/absentees')
  @RequireCapability(VIEW_ALL)
  @ApiPaginated(AbsenteeRowDto)
  @ApiErrors(...COMMON, 422)
  absentees(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: AbsenteesQueryDto,
  ): Promise<Page<AbsenteeRowDto>> {
    return this.reads.absentees(session, query);
  }

  /** §10.3: derived late days of a date. */
  @Get('attendance-reports/late')
  @RequireCapability(VIEW_ALL)
  @ApiPaginated(AbsenteeRowDto)
  @ApiErrors(...COMMON, 422)
  late(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: LateQueryDto,
  ): Promise<Page<AbsenteeRowDto>> {
    return this.reads.late(session, query);
  }

  /** §10.5 (R128): the percentage report ("who is below 75 %"). */
  @Get('attendance-reports/percentage')
  @RequireCapability(VIEW_ALL)
  @ApiPaginated(PercentageRowDto)
  @ApiErrors(...COMMON, 422)
  percentage(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() query: PercentageQueryDto,
  ): Promise<Page<PercentageRowDto>> {
    return this.reads.percentage(session.schoolId, query);
  }

  /** §10.4: a student's days and percentage, in today's student.view scope. */
  @Get('students/:id/attendance')
  @RequireCapability(STUDENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentAttendanceDto })
  @ApiErrors(...COMMON, 404, 422)
  studentAttendance(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() query: StudentAttendanceQueryDto,
  ): Promise<StudentAttendanceDto> {
    return this.reads.forStaff(session, id, query);
  }
}
