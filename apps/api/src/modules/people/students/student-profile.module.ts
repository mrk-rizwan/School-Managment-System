import { Module } from '@nestjs/common';
import { AcademicYearRepository } from '../../../repositories/academic-year.repository';
import { AttendanceModule } from '../../attendance/attendance.module';
import { DocumentsModule } from '../../documents/documents.module';
import { FinanceReportsModule } from '../../finance-reports/finance-reports.module';
import { ResultsModule } from '../../results/results.module';
import { TransportModule } from '../../transport/transport.module';
import { StudentProfileController } from './student-profile.controller';
import { StudentProfileService } from './student-profile.service';
import { StudentsModule } from './students.module';

/**
 * Phase 5 slice 42 (R334): the student profile, composed of the owning modules' scoped reads —
 * students, attendance, results (with the class ranking), dues (FinanceReportsService.clearance),
 * documents and transport. Its own module so StudentsModule's imports stay as they are; none of
 * these modules imports it. PermissionsService and SchoolClock come from the global modules.
 */
@Module({
  imports: [StudentsModule, AttendanceModule, DocumentsModule, FinanceReportsModule, ResultsModule, TransportModule],
  controllers: [StudentProfileController],
  providers: [StudentProfileService, AcademicYearRepository],
})
export class StudentProfileModule {}
