import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { SchoolCounterRepository } from '../../repositories/school-counter.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import { AcademicYearsController } from './academic-years.controller';
import { AcademicYearsService } from './academic-years.service';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';

/** Academic years, classes, sections and subjects (contracts/slice-3.md). */
@Module({
  controllers: [AcademicYearsController, ClassesController, SectionsController, SubjectsController],
  providers: [
    SchoolContext,
    AcademicYearsService,
    ClassesService,
    SectionsService,
    SubjectsService,
    AcademicYearRepository,
    ClassRepository,
    SectionRepository,
    SubjectRepository,
    AuditLogRepository,
    EnrolmentRepository,
    SchoolCounterRepository,
  ],
})
export class AcademicsModule {}
