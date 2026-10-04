import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { sendAttachment } from '../documents/documents.controller';
import {
  CorrectRemarkDto,
  CreateDiaryEntryDto,
  CreateRemarkDto,
  DiaryEntryDto,
  ListDiaryEntriesQueryDto,
  ListRemarksQueryDto,
  RemarkDto,
  UpdateDiaryEntryDto,
} from './diary.dto';
import { DiaryEntriesService } from './diary-entries.service';
import { RemarksService } from './remarks.service';

// contracts/slice-13.md §1.1, §4, §5: the staff routes. Common to every route: 401, 403
// PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429.
const COMMON = [401, 403, 429];

export const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/**
 * The staff attachment and thumbnail reads (contracts/slice-13.md §1.4): 120/min, 2,000/hour per
 * school user, as the `/me` reads, so a client fetching files in a loop is bounded per user and
 * not only by the re-encode limit.
 */
export const DiaryFilesThrottleGuard = perUserThrottle('diary-files', 120, 2000);

/** A binary body of the given types; errors stay JSON. */
export const binaryOf = (...types: string[]) => ({
  content: Object.fromEntries(
    types.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
  ),
});

@ApiTags('diary')
@Controller()
export class DiaryController {
  constructor(private readonly entries: DiaryEntriesService) {}

  @Get('sections/:id/diary-entries')
  @RequireCapability(Capability.DIARY_WRITE)
  @ApiIdParam()
  @ApiPaginated(DiaryEntryDto)
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() id: bigint,
    @Query() query: ListDiaryEntriesQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<DiaryEntryDto>> {
    return this.entries.list(session, id, query);
  }

  /** 201 for a new entry; 200 for a replay of the same key and body (R143). */
  @Post('sections/:id/diary-entries')
  @RequireCapability(Capability.DIARY_WRITE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: DiaryEntryDto })
  @ApiOkResponse({ type: DiaryEntryDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @IdParam() id: bigint,
    @Body() body: CreateDiaryEntryDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DiaryEntryDto> {
    const outcome = await this.entries.create(session, id, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.entry;
  }

  @Get('diary-entries/:id')
  @RequireCapability(Capability.DIARY_WRITE)
  @ApiIdParam()
  @ApiOkResponse({ type: DiaryEntryDto })
  @ApiErrors(...COMMON, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<DiaryEntryDto> {
    return this.entries.get(session, id);
  }

  @Patch('diary-entries/:id')
  @RequireCapability(Capability.DIARY_WRITE)
  @ApiIdParam()
  @ApiOkResponse({ type: DiaryEntryDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateDiaryEntryDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<DiaryEntryDto> {
    return this.entries.update(session, id, body);
  }

  @Get('diary-entries/:id/attachment')
  @RequireCapability(Capability.DIARY_WRITE)
  @UseGuards(DiaryFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async attachment(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachment(session, id, false);
    return sendAttachment(res, file.body, file);
  }

  /** An image attachment at most 320 × 320, stored when attached; a PDF has none (404). */
  @Get('diary-entries/:id/thumbnail')
  @RequireCapability(Capability.DIARY_WRITE)
  @UseGuards(DiaryFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachment(session, id, true);
    return sendAttachment(res, file.body, file);
  }
}

@ApiTags('remarks')
@Controller()
export class RemarksController {
  constructor(private readonly remarks: RemarksService) {}

  /** Every visibility, for anyone who may view the student (R140). */
  @Get('students/:id/remarks')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(RemarkDto)
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() id: bigint,
    @Query() query: ListRemarksQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<RemarkDto>> {
    return this.remarks.list(session, id, query);
  }

  /** 201 for a new remark; 200 for a replay of the same key and body (R143). */
  @Post('students/:id/remarks')
  @RequireCapability(Capability.REMARK_WRITE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: RemarkDto })
  @ApiOkResponse({ type: RemarkDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @IdParam() id: bigint,
    @Body() body: CreateRemarkDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RemarkDto> {
    const outcome = await this.remarks.create(session, id, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.remark;
  }

  /** A new row superseding this one (R141); retry-safe by REMARK_SUPERSEDED. */
  @Post('remarks/:id/correct')
  @HttpCode(201)
  @RequireCapability(Capability.REMARK_WRITE)
  @ApiIdParam()
  @ApiCreatedResponse({ type: RemarkDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  correct(
    @IdParam() id: bigint,
    @Body() body: CorrectRemarkDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<RemarkDto> {
    return this.remarks.correct(session, id, body);
  }
}
