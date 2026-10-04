import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
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
import { binaryOf, IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { sendAttachment } from '../documents/documents.controller';
import {
  AnnouncementDto,
  AudiencePreviewDto,
  CancelAnnouncementDto,
  CreateAnnouncementDto,
  DeliverySummaryDto,
  ListAnnouncementsQueryDto,
  PreviewAudienceDto,
  UpdateAnnouncementDto,
} from './announcements.dto';
import { AnnouncementsService } from './announcements.service';

// contracts/slice-14.md §1, §3-§5. Every route is any-of the two announcement keys; the row rule
// is the service's (§1.1). Common: 401, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 426, 429.
const COMMON = [401, 403, 429];

/** §1.3: preview walks the school, 30/min and 300/hour per school user. */
export const AnnouncementPreviewThrottleGuard = perUserThrottle('announcement-preview', 30, 300);
/** §1.3: the sender's attachment reads, as slice 13's `diary-files`. */
export const AnnouncementFilesThrottleGuard = perUserThrottle('announcement-files', 120, 2000);

const SEND = [Capability.ANNOUNCEMENT_SEND_SCHOOL, Capability.ANNOUNCEMENT_SEND_SCOPE] as const;

@ApiTags('announcements')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequireCapability(...SEND)
  @ApiPaginated(AnnouncementDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: ListAnnouncementsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<AnnouncementDto>> {
    return this.announcements.list(session, query);
  }

  /** 201 for a new draft; 200 for a replay of the same key and body (R143). Sends nothing. */
  @Post()
  @RequireCapability(...SEND)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: AnnouncementDto })
  @ApiOkResponse({ type: AnnouncementDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateAnnouncementDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AnnouncementDto> {
    const outcome = await this.announcements.create(session, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.announcement;
  }

  /** The people an audience reaches today and the SMS it would cost (§4.6). Writes nothing. */
  @Post('preview-audience')
  @HttpCode(200)
  @RequireCapability(...SEND)
  @UseGuards(AnnouncementPreviewThrottleGuard)
  @ApiOkResponse({ type: AudiencePreviewDto })
  @ApiErrors(...COMMON, 409, 422)
  preview(
    @Body() body: PreviewAudienceDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AudiencePreviewDto> {
    return this.announcements.preview(session, body);
  }

  @Get(':id')
  @RequireCapability(...SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: AnnouncementDto })
  @ApiErrors(...COMMON, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AnnouncementDto> {
    return this.announcements.get(session, id);
  }

  @Patch(':id')
  @RequireCapability(...SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: AnnouncementDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateAnnouncementDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AnnouncementDto> {
    return this.announcements.update(session, id, body);
  }

  /** Send now (answers `sent`) or schedule (`scheduled`); a retry is 200 unchanged (§5.5). */
  @Post(':id/send')
  @HttpCode(200)
  @RequireCapability(...SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: AnnouncementDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  send(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AnnouncementDto> {
    return this.announcements.send(session, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireCapability(...SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: AnnouncementDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  cancel(
    @IdParam() id: bigint,
    @Body() body: CancelAnnouncementDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AnnouncementDto> {
    return this.announcements.cancel(session, id, body);
  }

  /** Computed live from the delivery rows (R150). */
  @Get(':id/delivery')
  @RequireCapability(...SEND)
  @ApiIdParam()
  @ApiOkResponse({ type: DeliverySummaryDto })
  @ApiErrors(...COMMON, 404)
  delivery(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<DeliverySummaryDto> {
    return this.announcements.delivery(session, id);
  }

  @Get(':id/attachment')
  @RequireCapability(...SEND)
  @UseGuards(AnnouncementFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async attachment(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.announcements.attachment(session, id, false);
    return sendAttachment(res, file.body, file);
  }

  /** An image attachment at most 320 × 320; a PDF has none (404). */
  @Get(':id/thumbnail')
  @RequireCapability(...SEND)
  @UseGuards(AnnouncementFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.announcements.attachment(session, id, true);
    return sendAttachment(res, file.body, file);
  }
}
