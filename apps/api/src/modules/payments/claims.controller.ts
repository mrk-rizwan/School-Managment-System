import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { enforceRateLimits, perUserThrottle } from '../../common/rate-limit';
import { SchoolContext } from '../../common/school-context';
import { NoQueryDto } from '../../common/validation';
import { binaryOf } from '../diary/diary.controller';
import type { AttachedFile } from '../documents/attachment-files.service';
import { sendAttachment } from '../documents/documents.controller';
import { StagedUploadDto, UploadFileDto } from '../documents/documents.dto';
import { SingleFileInterceptor, uploadedFile, UploadThrottleGuard } from '../documents/upload-request';
import { UploadsService } from '../documents/uploads.service';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  ClaimDto,
  ClaimImageDto,
  CreateClaimDto,
  ListClaimsQueryDto,
  MyClaimDto,
  MyDuesDto,
  MyDuesQueryDto,
  MyReceiptDto,
  MyReceiptsQueryDto,
  RejectClaimDto,
  VerifiedClaimDto,
  VerifyClaimDto,
  WithdrawClaimDto,
} from './claims.dto';
import { ClaimsService } from './claims.service';
import { MyFeesService } from './my-fees.service';

// phase-3-financial.md slice 21 (contracts/slice-21.md §1). Common to every route: 401
// AUTH_REQUIRED, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429. The guardian routes live under
// /me (R78: a parent session reaches nothing else); a child outside the capacity scope is 404.
const COMMON = [401, 403, 429];

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -: the outbox item id on the phone, or generated once when the form opens; a replay answers 200 with Idempotency-Replayed: true',
} as const;

const SLIP = binaryOf('image/jpeg', 'image/png', 'application/pdf');

/**
 * A slip image opens in the browser (inline) rather than downloading to disk; a PDF stays an
 * attachment, because a browser's PDF viewer does not run under the `sandbox` CSP the file carries.
 */
const sendSlip = (res: Response, file: AttachedFile): StreamableFile =>
  sendAttachment(res, file.body, file, file.mime.startsWith('image/') ? 'inline' : 'attachment');

/** A guardian's claim writes (create, the slip, withdraw): 20 a minute, 120 an hour per user (the daily cap of R199 is counted in the database). */
export const ClaimWritesThrottleGuard = perUserThrottle('claim-writes', 20, 120);

/** The guardian's daily upload cap (§1.1 "Claim limits", R199). */
export const GUARDIAN_UPLOADS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60_000;

/**
 * R199: a guardian stages at most GUARDIAN_UPLOADS_PER_DAY files in 24 hours (counted in Redis,
 * per school user), on top of the upload route's per-minute and per-hour limits.
 */
@Injectable()
export class GuardianUploadDayGuard implements CanActivate {
  private readonly logger = new Logger('guardian-upload-day-throttle');

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly context: SchoolContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { schoolId, userId } = this.context.actor();
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [{ name: 'guardian-upload-day', key: `${schoolId}:${userId}`, limit: GUARDIAN_UPLOADS_PER_DAY, ttlMs: DAY_MS }],
      this.logger,
    );
    return true;
  }
}

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function replayed(res: Response, outcome: { replayed: boolean }): void {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
}

/** The office's queue (payment.verify, not an office default: the principal grants it, §3.1). */
@ApiTags('payments')
@Controller('payment-claims')
@RequireCapability(Capability.PAYMENT_VERIFY)
export class PaymentClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  @ApiPaginated(ClaimDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListClaimsQueryDto): Promise<Page<ClaimDto>> {
    return this.claims.list(query);
  }

  @Get(':id')
  @ApiIdParam()
  @ApiOkResponse({ type: ClaimDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ClaimDto> {
    return this.claims.get(id);
  }

  @Get(':id/image')
  @ApiIdParam()
  @ApiOkResponse(SLIP)
  @ApiErrors(...COMMON, 404)
  async image(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.claims.image(id, false);
    return sendSlip(res, file);
  }

  @Get(':id/thumbnail')
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.claims.image(id, true);
    return sendSlip(res, file);
  }

  /** R196: the payment exactly as the counter records it; never by the family (R197). */
  @Post(':id/verify')
  @HttpCode(200)
  @ApiIdParam()
  @ApiOkResponse({ type: VerifiedClaimDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  verify(@IdParam() id: bigint, @Body() body: VerifyClaimDto, @Query() _query: NoQueryDto): Promise<VerifiedClaimDto> {
    return this.claims.verify(id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiIdParam()
  @ApiOkResponse({ type: ClaimDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(@IdParam() id: bigint, @Body() body: RejectClaimDto, @Query() _query: NoQueryDto): Promise<ClaimDto> {
    return this.claims.reject(id, body);
  }
}

/** A child's dues and deposit claims (R198): every live login link of the child; 404 otherwise. */
@ApiTags('me')
@Controller('me/children/:id')
@RequireCapacity('guardian')
export class MyChildFeesController {
  constructor(
    private readonly fees: MyFeesService,
    private readonly claims: ClaimsService,
  ) {}

  @Get('dues')
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: MyDuesDto })
  @ApiErrors(...COMMON, 404, 422)
  dues(
    @IdParam() id: bigint,
    @Query() query: MyDuesQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyDuesDto> {
    return this.fees.dues(session, id, query);
  }

  @Get('payment-claims')
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiPaginated(MyClaimDto)
  @ApiErrors(...COMMON, 404, 422)
  listClaims(
    @IdParam() id: bigint,
    @Query() query: PageQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyClaimDto>> {
    return this.claims.listMine(session, id, query);
  }

  @Post('payment-claims')
  @UseGuards(ClaimWritesThrottleGuard, IdempotencyKeyGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: MyClaimDto })
  @ApiOkResponse({ type: MyClaimDto, description: 'Replay of a committed claim' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async createClaim(
    @IdParam() id: bigint,
    @Body() body: CreateClaimDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MyClaimDto> {
    const outcome = await this.claims.create(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.claim;
  }

  @Get('payment-claims/:claimId')
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiIdParam('claimId')
  @ApiOkResponse({ type: MyClaimDto })
  @ApiErrors(...COMMON, 404, 422)
  getClaim(
    @IdParam() id: bigint,
    @IdParam('claimId') claimId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyClaimDto> {
    return this.claims.getMine(session, id, claimId);
  }

  /** R243: the slip, once; the same upload again answers 200 (the phone's lane retries safely). */
  @Patch('payment-claims/:claimId')
  @UseGuards(ClaimWritesThrottleGuard)
  @ApiIdParam()
  @ApiIdParam('claimId')
  @ApiOkResponse({ type: MyClaimDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  attachImage(
    @IdParam() id: bigint,
    @IdParam('claimId') claimId: bigint,
    @Body() body: ClaimImageDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyClaimDto> {
    return this.claims.attachImage(session, id, claimId, body);
  }

  @Post('payment-claims/:claimId/withdraw')
  @HttpCode(200)
  @UseGuards(ClaimWritesThrottleGuard)
  @ApiIdParam()
  @ApiIdParam('claimId')
  @ApiOkResponse({ type: MyClaimDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  withdraw(
    @IdParam() id: bigint,
    @IdParam('claimId') claimId: bigint,
    @Body() body: WithdrawClaimDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyClaimDto> {
    return this.claims.withdraw(session, id, claimId, body);
  }

  /** The submitter's user only; another linked guardian is 404 (R198). */
  @Get('payment-claims/:claimId/image')
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiIdParam('claimId')
  @ApiOkResponse(SLIP)
  @ApiErrors(...COMMON, 404)
  async image(
    @IdParam() id: bigint,
    @IdParam('claimId') claimId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.claims.myImage(session, id, claimId, false);
    return sendSlip(res, file);
  }

  @Get('payment-claims/:claimId/thumbnail')
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiIdParam('claimId')
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @IdParam('claimId') claimId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.claims.myImage(session, id, claimId, true);
    return sendSlip(res, file);
  }
}

/** The family's receipts: their own children's lines only, and the rest as one total (R198). */
@ApiTags('me')
@Controller('me/receipts')
@RequireCapacity('guardian')
@UseGuards(MeReadsThrottleGuard)
export class MyReceiptsController {
  constructor(private readonly fees: MyFeesService) {}

  @Get()
  @ApiPaginated(MyReceiptDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@Query() query: MyReceiptsQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<Page<MyReceiptDto>> {
    return this.fees.receiptsOf(session, query);
  }

  @Get(':id')
  @ApiIdParam()
  @ApiOkResponse({ type: MyReceiptDto })
  @ApiErrors(...COMMON, 404, 422)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyReceiptDto> {
    return this.fees.receipt(session, id);
  }
}

/**
 * R199: the guardian's upload (a deposit slip), as POST /uploads for staff: 5 MB, jpg/png/pdf,
 * re-encoded, consumable only by its uploader. Under /me so a parent session still reaches nothing
 * outside /me (R78); the per-minute and per-hour upload limits plus a daily cap.
 */
@ApiTags('me')
@Controller('me/uploads')
@RequireCapacity('guardian')
export class MyUploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @UseGuards(UploadThrottleGuard, GuardianUploadDayGuard)
  @UseInterceptors(SingleFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadFileDto })
  @ApiCreatedResponse({ type: StagedUploadDto })
  @ApiErrors(...COMMON, 400, 413, 415, 422, 503)
  upload(@Req() req: Request, @Query() _query: NoQueryDto): Promise<StagedUploadDto> {
    return this.uploads.stage(uploadedFile(req));
  }
}
