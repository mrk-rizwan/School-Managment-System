import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { MessagingModule } from '../../messaging/messaging.module';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AttendanceReportRepository } from '../../repositories/attendance-report.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassSubjectRepository } from '../../repositories/class-subject.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { MarkReadsRepository } from '../../repositories/mark-reads.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { ResultSheetRepository } from '../../repositories/result-sheet.repository';
import { ResultRepository } from '../../repositories/result.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { StudentGuardianRepository } from '../../repositories/student-guardian.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import { ResultApprovalService } from './result-approval.service';
import { ResultComposer } from './result-composer';
import { ResultNotifyJob } from './result-notify.job';
import { ResultSheetsService } from './result-sheets.service';
import {
  ResultSheetReadsThrottleGuard,
  ResultSheetWritesThrottleGuard,
  ResultsController,
} from './results.controller';

/**
 * Result sheets (phase-4-academic.md slice 31, contracts/slice-31.md): create, preview, remarks,
 * submit, return, approve (compose and store), publish, and the result-notify job. The only
 * module that imports the sheet, result and mark-reads repositories (lint, §5.1); it reads the
 * slice-29 set-up repositories. ResultSheetsService is exported for the Approvals inbox (R278),
 * ResultNotifyJob for the worker.
 */
@Module({
  imports: [MessagingModule],
  controllers: [ResultsController],
  providers: [
    SchoolContext,
    SchoolSettingsReader,
    ResultSheetWritesThrottleGuard,
    ResultSheetReadsThrottleGuard,
    ResultSheetsService,
    ResultApprovalService,
    ResultComposer,
    ResultNotifyJob,
    ResultSheetRepository,
    ResultRepository,
    MarkReadsRepository,
    AcademicTermRepository,
    AcademicYearRepository,
    AttendanceReportRepository,
    AuditLogRepository,
    ClassSubjectRepository,
    ClassRepository,
    OwnSchoolRepository,
    ResultSettingsRepository,
    SchoolSettingsRepository,
    SectionRepository,
    StudentGuardianRepository,
    TeacherAssignmentRepository,
  ],
  exports: [ResultSheetsService, ResultNotifyJob],
})
export class ResultsModule {}
