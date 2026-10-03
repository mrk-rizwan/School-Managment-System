import { Body, Controller, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import {
  CurrentSchoolSession,
  type SchoolSessionContext,
} from '../../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { identityProbeThrottle, type RequestCost } from '../../../common/rate-limit';
import { NoQueryDto } from '../../../common/validation';
import { StudentDetailDto } from '../students/students.dto';
import { AdmissionResultDto, CreateAdmissionDto, ReadmitDto } from './admissions.dto';
import { AdmissionsService } from './admissions.service';
import { ReadmissionService } from './readmission.service';

// contracts/slice-6.md §3.7 and §6.3. Both `student.create`, school-wide. Common to every route:
// 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429.
const COMMON = [401, 403, 429];

/** `value[key]` when `value` is a plain object: guards read the raw body, before validation. */
const member = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (Reflect.get(value, key) as unknown)
    : undefined;

/** The most guardians an admission takes (CreateAdmissionDto); a longer list is a 422 anyway. */
const MAX_GUARDIANS = 4;

/**
 * An admission can answer STUDENT_BFORM_EXISTS or GUARDIAN_CNIC_EXISTS for every identity number
 * it carries, so it spends one probe per number: the student's B-Form and each new guardian's
 * CNIC (F3, slice-6.md §3.4). Never less than one, as before, so a bare admission still counts.
 */
export const admissionProbeCost: RequestCost = (req) => {
  const body: unknown = req.body;
  let numbers = typeof member(member(body, 'student'), 'bForm') === 'string' ? 1 : 0;
  const guardians = member(body, 'guardians');
  if (Array.isArray(guardians)) {
    for (const guardian of guardians.slice(0, MAX_GUARDIANS)) {
      if (typeof member(member(guardian, 'newGuardian'), 'cnic') === 'string') numbers++;
    }
  }
  return Math.max(1, numbers);
};

export const AdmissionProbeThrottleGuard = identityProbeThrottle(admissionProbeCost);

@ApiTags('admissions')
@Controller()
export class AdmissionsController {
  constructor(
    private readonly admissions: AdmissionsService,
    private readonly readmissions: ReadmissionService,
  ) {}

  /**
   * The whole wizard in one request. A replay of a committed admission (same key, same body)
   * returns its stored status with `Idempotency-Replayed: true` and writes nothing (R33). It can
   * answer STUDENT_BFORM_EXISTS or GUARDIAN_CNIC_EXISTS, so it spends the per-user
   * identity-probe budget the lookups spend, once per identity number in the body.
   */
  @Post('admissions')
  @RequireCapability(Capability.STUDENT_CREATE)
  @UseGuards(AdmissionProbeThrottleGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '16-64 of A-Z a-z 0-9 _ -, generated once when the wizard opens',
  })
  @ApiCreatedResponse({ type: AdmissionResultDto })
  @ApiErrors(...COMMON, 409, 422)
  async admit(
    @Body() body: CreateAdmissionDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdmissionResultDto> {
    const outcome = await this.admissions.admit(session, body, req.header('Idempotency-Key'));
    res.status(outcome.status);
    if (outcome.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return outcome.result;
  }

  @Post('students/:id/readmit')
  @HttpCode(200)
  @RequireCapability(Capability.STUDENT_CREATE)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  readmit(
    @IdParam() id: bigint,
    @Body() body: ReadmitDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StudentDetailDto> {
    return this.readmissions.readmit(session, id, body);
  }
}
