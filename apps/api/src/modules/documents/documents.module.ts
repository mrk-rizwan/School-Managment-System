import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { StorageModule } from '../../common/storage/storage.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../repositories/student-document.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { AttachmentFiles } from './attachment-files.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STAGED_UPLOAD_SWEEP_PROVIDERS, StagedUploadSweep } from './staged-upload.sweep';
import { SingleFileInterceptor, UploadThrottleGuard } from './upload-request';
import { reencodeLimitProvider, UploadsService } from './uploads.service';
import {
  DocumentReportsThrottleGuard,
  DocumentVerificationController,
  MyDocumentsController,
} from './verification.controller';
import { DocumentVerificationService } from './verification.service';

/**
 * Uploads, student documents and the staged-upload sweep (contracts/slice-6.md §6.1-§6.2). The
 * sweep is exported for the worker, which runs it as a repeatable job (src/jobs, slice 9). Since
 * Phase 5 slice 40 also their verification (contracts/slice-40.md).
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController, DocumentVerificationController, MyDocumentsController],
  providers: [
    SchoolContext,
    // Phase 5 slice 42: the incomplete-admissions report's throttle (its CSV costs 5).
    DocumentReportsThrottleGuard,
    AttachmentFiles,
    DocumentsService,
    DocumentVerificationService,
    UploadsService,
    reencodeLimitProvider,
    ...STAGED_UPLOAD_SWEEP_PROVIDERS,
    SingleFileInterceptor,
    UploadThrottleGuard,
    MeReadsThrottleGuard,
    AuditLogRepository,
    SchoolSettingsRepository,
    StagedUploadRepository,
    StudentDocumentRepository,
    StudentRepository,
  ],
  // The re-encode limit is shared with the attachments' on-demand thumbnails
  // (contracts/slice-13.md §1.4: one limit of 4 per process); AttachmentFiles serves the diary's
  // and announcements' attachments. DocumentVerificationService: the student list's documents
  // badge and the Approvals' Documents section (slice 40).
  exports: [StagedUploadSweep, reencodeLimitProvider.provide, AttachmentFiles, DocumentVerificationService],
})
export class DocumentsModule {}
