import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { StorageModule } from '../../common/storage/storage.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../repositories/student-document.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { AttachmentFiles } from './attachment-files.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STAGED_UPLOAD_SWEEP_PROVIDERS, StagedUploadSweep } from './staged-upload.sweep';
import { SingleFileInterceptor, UploadThrottleGuard } from './upload-request';
import { reencodeLimitProvider, UploadsService } from './uploads.service';

/**
 * Uploads, student documents and the staged-upload sweep (contracts/slice-6.md §6.1-§6.2). The
 * sweep is exported for the worker, which runs it as a repeatable job (src/jobs, slice 9).
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
  providers: [
    SchoolContext,
    AttachmentFiles,
    DocumentsService,
    UploadsService,
    reencodeLimitProvider,
    ...STAGED_UPLOAD_SWEEP_PROVIDERS,
    SingleFileInterceptor,
    UploadThrottleGuard,
    AuditLogRepository,
    StagedUploadRepository,
    StudentDocumentRepository,
    StudentRepository,
  ],
  // The re-encode limit is shared with the attachments' on-demand thumbnails
  // (contracts/slice-13.md §1.4: one limit of 4 per process); AttachmentFiles serves the diary's
  // and announcements' attachments.
  exports: [StagedUploadSweep, reencodeLimitProvider.provide, AttachmentFiles],
})
export class DocumentsModule {}
