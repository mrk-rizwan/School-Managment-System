import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { StorageModule } from '../../common/storage/storage.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { DiaryEntryRepository } from '../../repositories/diary-entry.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { RemarkRepository } from '../../repositories/remark.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { DocumentsModule } from '../documents/documents.module';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import { DiaryController, DiaryFilesThrottleGuard, RemarksController } from './diary.controller';
import { DiaryEntriesService } from './diary-entries.service';
import { MyChildDiaryController, MyStudentDiaryController } from './my-diary.controller';
import { RemarksService } from './remarks.service';

/**
 * The diary and remarks (Phase 2 slice 13, contracts/slice-13.md): the staff routes, the guardian
 * and student reads under /me/children/:id/* and /me/student/*, attachments and their stored
 * thumbnails. DocumentsModule lends the re-encode limit, so thumbnails and uploads share one.
 */
@Module({
  imports: [MessagingModule, DocumentsModule, StorageModule],
  controllers: [
    DiaryController,
    RemarksController,
    MyChildDiaryController,
    MyStudentDiaryController,
  ],
  providers: [
    SchoolContext,
    SchoolSettingsReader,
    MeReadsThrottleGuard,
    IdempotencyKeyGuard,
    IdempotentRequests,
    DiaryFilesThrottleGuard,
    DiaryEntriesService,
    RemarksService,
    DiaryEntryRepository,
    RemarkRepository,
    SectionRepository,
    ClassRepository,
    AcademicYearRepository,
    SubjectRepository,
    StudentRepository,
    EnrolmentRepository,
    StagedUploadRepository,
    IdempotencyKeyRepository,
    SchoolSettingsRepository,
    OwnSchoolRepository,
    ChangeContextRepository,
    AuditLogRepository,
  ],
})
export class DiaryModule {}
