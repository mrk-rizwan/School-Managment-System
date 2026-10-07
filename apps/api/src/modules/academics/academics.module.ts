import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassSubjectRepository } from '../../repositories/class-subject.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { SchoolCounterRepository } from '../../repositories/school-counter.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import { AcademicYearsController } from './academic-years.controller';
import { AcademicYearsService } from './academic-years.service';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { ResultSettingsService } from './result-settings.service';
import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { TermsController } from './terms.controller';
import { TermsService } from './terms.service';

/**
 * Academic years, classes, sections and subjects (contracts/slice-3.md); since Phase 4 the terms,
 * result settings and class subject lists (contracts/slice-29.md).
 */
@Module({
  controllers: [AcademicYearsController, ClassesController, SectionsController, SubjectsController, TermsController],
  providers: [
    SchoolContext,
    AcademicYearsService,
    ClassesService,
    SectionsService,
    SubjectsService,
    TermsService,
    ResultSettingsService,
    AcademicYearRepository,
    AcademicTermRepository,
    ResultSettingsRepository,
    ClassSubjectRepository,
    ClassRepository,
    SectionRepository,
    SubjectRepository,
    AuditLogRepository,
    EnrolmentRepository,
    SchoolCounterRepository,
  ],
})
export class AcademicsModule {}
