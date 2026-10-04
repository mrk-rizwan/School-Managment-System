import { Controller, Get, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { sendAttachment } from '../documents/documents.controller';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { binaryOf } from './diary.controller';
import { DiaryRangeQueryDto, MyDiaryEntryDto, MyRemarkDto, MyRemarksQueryDto } from './diary.dto';
import { DiaryEntriesService } from './diary-entries.service';
import { RemarksService } from './remarks.service';

// contracts/slice-13.md §1.2, §6: the guardian (/me/children/:id/*) and student (/me/student/*)
// reads. The guard binds the capacity scope; a child outside it is 404, the same as an absent
// one. R165 on every response: the author by name only, nothing about another student or
// guardian. Throttled per user (R166).
const COMMON = [401, 403, 429];

@ApiTags('me')
@Controller('me/children/:id')
@RequireCapacity('guardian')
@UseGuards(MeReadsThrottleGuard)
export class MyChildDiaryController {
  constructor(
    private readonly entries: DiaryEntriesService,
    private readonly remarks: RemarksService,
  ) {}

  @Get('diary-entries')
  @ApiIdParam()
  @ApiPaginated(MyDiaryEntryDto)
  @ApiErrors(...COMMON, 404, 422)
  diary(
    @IdParam() id: bigint,
    @Query() query: DiaryRangeQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyDiaryEntryDto>> {
    return this.entries.listForStudent(session, id, query);
  }

  @Get('diary-entries/:entryId/attachment')
  @ApiIdParam()
  @ApiIdParam('entryId')
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async attachment(
    @IdParam() id: bigint,
    @IdParam('entryId') entryId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachmentForStudent(session, id, entryId, false);
    return sendAttachment(res, file.body, file);
  }

  @Get('diary-entries/:entryId/thumbnail')
  @ApiIdParam()
  @ApiIdParam('entryId')
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @IdParam('entryId') entryId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachmentForStudent(session, id, entryId, true);
    return sendAttachment(res, file.body, file);
  }

  /** `guardian` and `student` visibilities only, filtered in the query (R140). */
  @Get('remarks')
  @ApiIdParam()
  @ApiPaginated(MyRemarkDto)
  @ApiErrors(...COMMON, 404, 422)
  remarksOf(
    @IdParam() id: bigint,
    @Query() query: MyRemarksQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyRemarkDto>> {
    return this.remarks.listForCapacity(session, 'guardian', id, query);
  }
}

@ApiTags('me')
@Controller('me/student')
@RequireCapacity('student')
@UseGuards(MeReadsThrottleGuard)
export class MyStudentDiaryController {
  constructor(
    private readonly entries: DiaryEntriesService,
    private readonly remarks: RemarksService,
  ) {}

  @Get('diary-entries')
  @ApiPaginated(MyDiaryEntryDto)
  @ApiErrors(...COMMON, 422)
  diary(
    @Query() query: DiaryRangeQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyDiaryEntryDto>> {
    return this.entries.listForStudent(session, ownId(session), query);
  }

  @Get('diary-entries/:entryId/attachment')
  @ApiIdParam('entryId')
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async attachment(
    @IdParam('entryId') entryId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachmentForStudent(session, ownId(session), entryId, false);
    return sendAttachment(res, file.body, file);
  }

  @Get('diary-entries/:entryId/thumbnail')
  @ApiIdParam('entryId')
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam('entryId') entryId: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.entries.attachmentForStudent(session, ownId(session), entryId, true);
    return sendAttachment(res, file.body, file);
  }

  /** `student` visibility only, filtered in the query (R140). */
  @Get('remarks')
  @ApiPaginated(MyRemarkDto)
  @ApiErrors(...COMMON, 422)
  remarksOf(
    @Query() query: MyRemarksQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<MyRemarkDto>> {
    return this.remarks.listForCapacity(session, 'student', ownId(session), query);
  }
}

/** The caller's own student id: the student capacity requires it (contracts/slice-13.md §1.2). */
function ownId(session: SchoolSessionContext): bigint {
  return session.access.studentId ?? 0n;
}
