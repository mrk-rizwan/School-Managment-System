import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../../common/auth/school-session';
import { notFound } from '../../../common/errors/api-exception';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../../common/idempotency';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { perUserThrottle } from '../../../common/rate-limit';
import { NoQueryDto } from '../../../common/validation';
import { binaryOf, IDEMPOTENCY_HEADER_DOC } from '../../diary/diary.controller';
import type { AttachedFile } from '../../documents/attachment-files.service';
import { sendAttachment } from '../../documents/documents.controller';
import { MeReadsThrottleGuard } from '../../me/me-throttles';
import {
  CreateStaffContractDto,
  EndStaffContractDto,
  ListEndingContractsQueryDto,
  ListStaffContractsQueryDto,
  MyStaffContractDto,
  StaffContractDto,
} from './staff-contracts.dto';
import { StaffContractsService } from './staff-contracts.service';

// Phase 5 slice 39 (contracts/slice-39.md §1). Common to every route: 401, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 426 (bearer), 429. Every staff-side route needs staff.contract.manage
// (principal by default); the owner reads their own through /me/staff/contract.
const COMMON = [401, 403, 429];

/** Contract writes: 30/min, 300/hour per user. */
export const StaffContractWritesThrottleGuard = perUserThrottle('staff-contract-writes', 30, 300);
/** Scan reads (each audited): 60/min, 600/hour per user. */
export const StaffContractFilesThrottleGuard = perUserThrottle('staff-contract-files', 60, 600);

const PDF_OR_IMAGE = binaryOf('image/jpeg', 'image/png', 'application/pdf');

/** R43, R321: streamed, never a URL; `nosniff`, `CSP sandbox`, `no-store`. */
function stream(res: Response, file: AttachedFile): StreamableFile {
  res.setHeader('Cache-Control', 'no-store');
  return sendAttachment(res, file.body, file);
}

@ApiTags('staff')
@Controller()
export class StaffContractsController {
  constructor(private readonly contracts: StaffContractsService) {}

  @Get('staff/:id/contracts')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @ApiIdParam()
  @ApiPaginated(StaffContractDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@IdParam() id: bigint, @Query() query: ListStaffContractsQueryDto): Promise<Page<StaffContractDto>> {
    return this.contracts.listForStaff(id, query);
  }

  /** 201; 200 for a replay of the same key and body (R318). */
  @Post('staff/:id/contracts')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @UseGuards(IdempotencyKeyGuard, StaffContractWritesThrottleGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: StaffContractDto })
  @ApiOkResponse({ type: StaffContractDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @IdParam() id: bigint,
    @Body() body: CreateStaffContractDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffContractDto> {
    const outcome = await this.contracts.create(id, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.contract;
  }

  /** Live contracts ending on or before `endsBy`, expired ones included (the dashboard tile). */
  @Get('staff-contracts')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @ApiPaginated(StaffContractDto)
  @ApiErrors(...COMMON, 422)
  listEnding(@Query() query: ListEndingContractsQueryDto): Promise<Page<StaffContractDto>> {
    return this.contracts.listEnding(query);
  }

  /** 201 with the next contract: the current ends on its last day, reason `renewed`. */
  @Post('staff-contracts/:id/renew')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @UseGuards(StaffContractWritesThrottleGuard)
  @ApiIdParam()
  @ApiCreatedResponse({ type: StaffContractDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  renew(@IdParam() id: bigint, @Body() body: CreateStaffContractDto, @Query() _query: NoQueryDto): Promise<StaffContractDto> {
    return this.contracts.renew(id, body);
  }

  @Post('staff-contracts/:id/end')
  @HttpCode(200)
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @UseGuards(StaffContractWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: StaffContractDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  end(@IdParam() id: bigint, @Body() body: EndStaffContractDto, @Query() _query: NoQueryDto): Promise<StaffContractDto> {
    return this.contracts.end(id, body);
  }

  @Get('staff-contracts/:id/document')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @UseGuards(StaffContractFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(PDF_OR_IMAGE)
  @ApiErrors(...COMMON, 404)
  async document(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return stream(res, await this.contracts.document({ contractId: id }));
  }
}

/** The staff member's own contract: the staff id is the session's, never input (R321). */
@ApiTags('me')
@Controller('me/staff')
export class MyStaffContractController {
  constructor(private readonly contracts: StaffContractsService) {}

  @Get('contract')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: MyStaffContractDto })
  @ApiErrors(...COMMON)
  mine(@CurrentSchoolSession() session: SchoolSessionContext, @Query() _query: NoQueryDto): Promise<MyStaffContractDto> {
    return this.contracts.mine(ownStaffId(session));
  }

  /** The scan of the caller's own live contract; 404 when there is none. */
  @Get('contract/document')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard, StaffContractFilesThrottleGuard)
  @ApiOkResponse(PDF_OR_IMAGE)
  @ApiErrors(...COMMON, 404)
  async document(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return stream(res, await this.contracts.document({ ownStaffId: ownStaffId(session) }));
  }
}

const ownStaffId = (session: SchoolSessionContext): bigint => {
  const staffId = session.access.staffId;
  if (staffId === null) throw notFound();
  return staffId;
};
