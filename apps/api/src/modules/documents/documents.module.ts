import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { StorageModule } from '../../common/storage/storage.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../repositories/student-document.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STAGED_UPLOAD_SWEEP_PROVIDERS } from './staged-upload.sweep';
import { SingleFileInterceptor, UploadThrottleGuard } from './upload-request';
import { reencodeLimitProvider, UploadsService } from './uploads.service';

/**
 * Uploads, student documents and the staged-upload sweep (contracts/slice-6.md §6.1-§6.2). The
 * scheduler is registered once, in AppModule; the sweep is its first job.
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
  providers: [
    SchoolContext,
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
})
export class DocumentsModule {}
