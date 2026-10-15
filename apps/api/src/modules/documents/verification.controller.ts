import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability, type CsvColumn } from '@asms/shared';
import { RequireCapability, RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { CsvExport, csvCost } from '../../common/report-export';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { StudentDocumentDto } from './documents.dto';
import {
  DocumentChecklistDto,
  IncompleteAdmissionDto,
  IncompleteAdmissionsQueryDto,
  ListDocumentQueueQueryDto,
  MyDocumentChecklistDto,
  QueuedDocumentDto,
} from './verification.dto';
import { DocumentVerificationService } from './verification.service';

// Phase 5 slice 40 (contracts/slice-40.md §1). Common to every route: 401, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 429.
const COMMON = [401, 403, 429];

/**
 * Phase 5 slice 42 (R336): the incomplete-admissions report's own family budget, 30/min and 300/h
 * per user; a CSV export costs 5.
 */
export const DocumentReportsThrottleGuard = perUserThrottle('document-reports', 30, 300, csvCost);

/** R336: the incomplete-admissions CSV, the tab's columns (types joined with spaces). */
export const INCOMPLETE_ADMISSION_COLUMNS: readonly CsvColumn<IncompleteAdmissionDto>[] = [
  { header: 'Student', value: (r) => r.fullName },
  { header: 'Admission no', value: (r) => r.admissionNo },
  { header: 'Admitted on', value: (r) => r.admittedOn },
  { header: 'Class', value: (r) => r.className },
  { header: 'Section', value: (r) => r.sectionName },
  { header: 'Missing', value: (r) => r.missing.join(' ') },
  { header: 'Awaiting verification', value: (r) => r.awaiting.join(' ') },
  { header: 'Rejected', value: (r) => r.rejected.join(' ') },
];

/** The verification queue, the decisions and the incomplete-admissions report (document.verify). */
@ApiTags('documents')
@Controller()
export class DocumentVerificationController {
  constructor(private readonly verification: DocumentVerificationService) {}

  @Get('documents')
  @RequireCapability(Capability.DOCUMENT_VERIFY)
  @ApiPaginated(QueuedDocumentDto)
  @ApiErrors(...COMMON, 422)
  queue(
    @Query() query: ListDocumentQueueQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<QueuedDocumentDto>> {
    return this.verification.queue(session, query);
  }

  @Get('documents/incomplete-admissions')
  @RequireCapability(Capability.DOCUMENT_VERIFY)
  @UseGuards(DocumentReportsThrottleGuard)
  @ApiPaginated(IncompleteAdmissionDto)
  @CsvExport({ family: 'document_report', report: 'incomplete-admissions', columns: INCOMPLETE_ADMISSION_COLUMNS })
  @ApiErrors(...COMMON, 422)
  incompleteAdmissions(
    @Query() query: IncompleteAdmissionsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<IncompleteAdmissionDto>> {
    return this.verification.incompleteAdmissions(session, query);
  }

  @Post('documents/:id/verify')
  @HttpCode(200)
  @RequireCapability(Capability.DOCUMENT_VERIFY)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDocumentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  verify(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StudentDocumentDto> {
    return this.verification.verify(session, id);
  }

  @Post('documents/:id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.DOCUMENT_VERIFY)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentDocumentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StudentDocumentDto> {
    return this.verification.reject(session, id, body.reason);
  }

  /** R323: anyone who sees a student's documents sees the checklist. */
  @Get('students/:id/document-checklist')
  @RequireCapability(Capability.DOCUMENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: DocumentChecklistDto })
  @ApiErrors(...COMMON, 404)
  checklist(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<DocumentChecklistDto> {
    return this.verification.checklist(session, id);
  }
}

/** The family's checklist (R322): status and fixed text only; every /me/* read takes me-reads. */
@ApiTags('me')
@Controller('me')
@UseGuards(MeReadsThrottleGuard)
export class MyDocumentsController {
  constructor(private readonly verification: DocumentVerificationService) {}

  @Get('children/:id/documents')
  @RequireCapacity('guardian')
  @ApiIdParam()
  @ApiOkResponse({ type: MyDocumentChecklistDto })
  @ApiErrors(...COMMON, 404)
  child(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MyDocumentChecklistDto> {
    return this.verification.family(session, id);
  }

  @Get('student/documents')
  @RequireCapacity('student')
  @ApiOkResponse({ type: MyDocumentChecklistDto })
  @ApiErrors(...COMMON)
  own(@Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<MyDocumentChecklistDto> {
    return this.verification.family(session, null);
  }
}
