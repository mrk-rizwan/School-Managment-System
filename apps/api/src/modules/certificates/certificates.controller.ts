import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { SameSitePrintGuard, sendPrintView } from '../../common/print-view';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import {
  CertificateDto,
  CertificateSummaryDto,
  IssueCertificateDto,
  ListCertificatesQueryDto,
  ListStudentCertificatesQueryDto,
} from './certificates.dto';
import { CertificatesService, type CertificateCreateOutcome } from './certificates.service';

// phase-4-academic.md slice 34; contracts/slice-34.md §1. Common to every route: 401, 403
// PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429.
const COMMON = [401, 403, 429];

/** §5: staff print views share one bucket, 20/min and 200/h per user (wave O's prints join it). */
export const PrintThrottleGuard = perUserThrottle('print', 20, 200);

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function created(res: Response, outcome: CertificateCreateOutcome): CertificateDto {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
  return outcome.certificate;
}

@ApiTags('certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  /** The register, with bodies; voided rows listed as such (R293). Sort `-issuedOn` by default. */
  @Get()
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @ApiPaginated(CertificateDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListCertificatesQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<CertificateDto>> {
    return this.certificates.list(session, query);
  }

  @Get(':id')
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @ApiIdParam()
  @ApiOkResponse({ type: CertificateDto })
  @ApiErrors(...COMMON, 404, 422)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CertificateDto> {
    return this.certificates.get(session, id);
  }

  /** R292: the only place the B-Form prints; audited `certificate.printed`, counted. */
  @Get(':id/print')
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @UseGuards(SameSitePrintGuard, PrintThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ description: 'The printable certificate (R292)', content: { 'text/html': { schema: { type: 'string' } } } })
  @ApiErrors(...COMMON, 404, 422)
  async print(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res() res: Response,
  ): Promise<void> {
    sendPrintView(res, await this.certificates.print(session, id));
  }

  /** R289: same number, issue + 1, DUPLICATE. 201, or 200 for a replay of the same key and body. */
  @Post(':id/reissue')
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: CertificateDto })
  @ApiOkResponse({ type: CertificateDto, description: 'Replay of a committed reissue' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async reissue(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CertificateDto> {
    return created(res, await this.certificates.reissue(session, id, body, req.header(IDEMPOTENCY_HEADER)));
  }

  /** R293: a principal only (403 `principal_required`); the number is never reused. */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @ApiIdParam()
  @ApiOkResponse({ type: CertificateDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<CertificateDto> {
    return this.certificates.void(session, id, body);
  }
}

@ApiTags('certificates')
@Controller('students')
export class StudentCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  /** R289-R291: per type; the leaving certificate needs a student who left and dues cleared. */
  @Post(':id/certificates')
  @RequireCapability(Capability.CERTIFICATE_ISSUE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: CertificateDto })
  @ApiOkResponse({ type: CertificateDto, description: 'Replay of a committed issue' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async issue(
    @IdParam() id: bigint,
    @Body() body: IssueCertificateDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CertificateDto> {
    return created(res, await this.certificates.issue(session, id, body, req.header(IDEMPOTENCY_HEADER)));
  }

  /** The student page's panel: summaries without bodies, in the caller's student scope. */
  @Get(':id/certificates')
  @RequireCapability(Capability.CERTIFICATE_ISSUE, Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(CertificateSummaryDto)
  @ApiErrors(...COMMON, 404, 422)
  listForStudent(
    @IdParam() id: bigint,
    @Query() query: ListStudentCertificatesQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<CertificateSummaryDto>> {
    return this.certificates.listForStudent(session, id, query);
  }
}
