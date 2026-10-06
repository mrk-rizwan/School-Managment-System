import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import {
  AddDocumentDto,
  ListDocumentsQueryDto,
  StagedUploadDto,
  StudentDocumentDto,
  UploadFileDto,
} from './documents.dto';
import { DocumentsService, type DocumentContent } from './documents.service';
import { SingleFileInterceptor, uploadedFile, UploadThrottleGuard } from './upload-request';
import { UploadsService } from './uploads.service';

// contracts/slice-6.md §6.1-§6.2. Common to every route: 401, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429.
const COMMON = [401, 403, 429];

/**
 * Streams stored content with the §6.2 headers: an attachment the browser must neither sniff nor
 * render with script. Never a presigned URL (R43). Also the diary's attachments and thumbnails
 * (contracts/slice-13.md §4.5), whose body may be bytes made on demand.
 */
export function sendAttachment(
  res: Response,
  body: Readable | Buffer,
  file: { mime: string; sizeBytes: number; filename: string },
): StreamableFile {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  const options = {
    type: file.mime,
    length: file.sizeBytes,
    disposition: `attachment; filename="${file.filename}"`,
  };
  return Buffer.isBuffer(body) ? new StreamableFile(body, options) : new StreamableFile(body, options);
}

const attachment = (res: Response, content: DocumentContent): StreamableFile =>
  sendAttachment(res, content.object.body, content);

/** A binary body of the given types; errors stay JSON (the default response). */
const binaryOf = (...types: string[]) => ({
  content: Object.fromEntries(
    types.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
  ),
});

@ApiTags('documents')
@Controller()
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * The one multipart route (plan §3.9). Guards (access, then throttle) run before the body is
   * read. Open to anyone who may attach a file anywhere (R171: documents, diary, announcements);
   * the staged upload is consumable only by its uploader, and each consuming route keeps its own
   * capability, so staging a file grants nothing else.
   */
  @Post('uploads')
  @RequireCapability(
    Capability.DOCUMENT_UPLOAD,
    Capability.DIARY_WRITE,
    Capability.ANNOUNCEMENT_SEND_SCOPE,
    Capability.ANNOUNCEMENT_SEND_SCHOOL,
    // Phase 3 slice 23: an expense's receipt.
    Capability.EXPENSE_RECORD,
  )
  @UseGuards(UploadThrottleGuard)
  @UseInterceptors(SingleFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadFileDto })
  @ApiCreatedResponse({ type: StagedUploadDto })
  @ApiErrors(...COMMON, 400, 413, 415, 422, 503)
  upload(@Req() req: Request, @Query() _query: NoQueryDto): Promise<StagedUploadDto> {
    return this.uploads.stage(uploadedFile(req));
  }

  @Get('students/:id/documents')
  @RequireCapability(Capability.DOCUMENT_VIEW)
  @ApiIdParam()
  @ApiPaginated(StudentDocumentDto)
  @ApiErrors(...COMMON, 404, 422)
  list(
    @IdParam() id: bigint,
    @Query() query: ListDocumentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<StudentDocumentDto>> {
    return this.documents.list(session, id, query);
  }

  /** 201 for a new document; 200 when this staged upload is already this student's document. */
  @Post('students/:id/documents')
  @RequireCapability(Capability.DOCUMENT_UPLOAD)
  @ApiIdParam()
  @ApiCreatedResponse({ type: StudentDocumentDto })
  @ApiOkResponse({
    type: StudentDocumentDto,
    description: 'Retry of an already committed document',
  })
  @ApiErrors(...COMMON, 404, 422)
  async add(
    @IdParam() id: bigint,
    @Body() body: AddDocumentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StudentDocumentDto> {
    const { created, document } = await this.documents.add(session, id, body);
    if (!created) res.status(200);
    return document;
  }

  @Get('students/:id/photo')
  @RequireCapability(Capability.DOCUMENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png'))
  @ApiErrors(...COMMON, 404)
  async photo(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return attachment(res, await this.documents.photo(session, id));
  }

  @Get('documents/:id/content')
  @RequireCapability(Capability.DOCUMENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async content(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return attachment(res, await this.documents.content(session, id));
  }
}
