import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AssessmentRepository } from '../../repositories/assessment.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassSubjectRepository } from '../../repositories/class-subject.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { MarkRepository } from '../../repositories/mark.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { AssessmentsController, MarksWritesThrottleGuard } from './assessments.controller';
import { AssessmentsService } from './assessments.service';
import { MarksService } from './marks.service';

/**
 * Assessments and marks (phase-4-academic.md slice 30, contracts/slice-30.md): class tests, the
 * term's exams, the marks grid with per-row outcomes, excusals. The only module that imports the
 * assessment and mark repositories (lint, §5.1); it reads the slice-29 set-up repositories.
 */
@Module({
  imports: [MessagingModule],
  controllers: [AssessmentsController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    MarksWritesThrottleGuard,
    AssessmentsService,
    MarksService,
    AssessmentRepository,
    MarkRepository,
    AcademicTermRepository,
    AcademicYearRepository,
    ClassSubjectRepository,
    ClassRepository,
    SectionRepository,
    ResultSettingsRepository,
    SchoolSettingsRepository,
    IdempotencyKeyRepository,
    AuditLogRepository,
  ],
})
export class AssessmentsModule {}
