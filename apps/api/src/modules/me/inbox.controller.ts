import { Controller, Get, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthenticatedOnly } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { InboxItemDto, InboxQueryDto } from '../announcements/announcements.dto';
import { binaryOf } from '../diary/diary.controller';
import { sendAttachment } from '../documents/documents.controller';
import { InboxService } from './inbox.service';
import { MeReadsThrottleGuard } from './me-throttles';

// contracts/slice-14.md §7: any live session (directly under /me/, plan §4.3), `me-reads`
// throttle (R166). An item not addressed to one of the caller's persons is 404.
const COMMON = [401, 403, 429];

@ApiTags('me')
@Controller('me/inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @AuthenticatedOnly()
  @UseGuards(MeReadsThrottleGuard)
  @ApiPaginated(InboxItemDto)
  @ApiErrors(...COMMON, 422)
  list(
    @Query() query: InboxQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<InboxItemDto>> {
    return this.inbox.list(session, query);
  }

  /** A push deep-link (`/inbox/[messageId]`) when the list cache is stale (decision 18). */
  @Get(':id')
  @AuthenticatedOnly()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: InboxItemDto })
  @ApiErrors(...COMMON, 404)
  get(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<InboxItemDto> {
    return this.inbox.get(session, id);
  }

  @Get(':id/attachment')
  @AuthenticatedOnly()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async attachment(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.inbox.attachment(session, id, false);
    return sendAttachment(res, file.body, file);
  }

  /** An image attachment at most 320 × 320; a PDF has none (404). */
  @Get(':id/thumbnail')
  @AuthenticatedOnly()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.inbox.attachment(session, id, true);
    return sendAttachment(res, file.body, file);
  }
}
