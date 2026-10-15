import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Capability, type CsvColumn } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, toPage, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { CsvExport, csvCost, pageWindow } from '../../common/report-export';
import { assertRange } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AttendanceReportRepository } from '../../repositories/attendance-report.repository';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { DiscrepanciesQueryDto, DiscrepancyDto } from './discrepancies.dto';

/** At most 92 days (R335), as the other attendance reports. */
export const DISCREPANCY_MAX_DAYS = 92;

/** The attendance report family's CSV budget: 30/min and 300/h per user; a CSV export costs 5 (R336). */
export const AttendanceReportsThrottleGuard = perUserThrottle('attendance-reports', 30, 300, csvCost);

const KIND_LABELS = { mixed_day: 'Present and absent on one day', amended_register: 'Register amended more than once' } as const;

export const DISCREPANCY_COLUMNS: readonly CsvColumn<DiscrepancyDto>[] = [
  { header: 'Date', value: (r) => r.date },
  { header: 'Discrepancy', value: (r) => KIND_LABELS[r.kind] },
  { header: 'Class', value: (r) => r.className },
  { header: 'Section', value: (r) => r.sectionName },
  { header: 'Student', value: (r) => r.studentName },
  { header: 'Period', value: (r) => r.period },
  { header: 'Present periods', value: (r) => r.presentPeriods.join(' ') },
  { header: 'Absent periods', value: (r) => r.absentPeriods.join(' ') },
  { header: 'Amendments', value: (r) => r.amendments },
];

/**
 * GET /attendance-reports/discrepancies (Phase 5 R335; contracts/slice-42.md §2.5):
 * attendance.student.view_all, school-wide; newest day first. A GET: nothing is written.
 */
@ApiTags('attendance')
@Controller('attendance-reports')
export class AttendanceDiscrepanciesController {
  constructor(
    private readonly context: SchoolContext,
    private readonly reports: AttendanceReportRepository,
  ) {}

  @Get('discrepancies')
  @RequireCapability(Capability.ATTENDANCE_STUDENT_VIEW_ALL)
  @UseGuards(AttendanceReportsThrottleGuard)
  @ApiPaginated(DiscrepancyDto)
  @CsvExport({ family: 'attendance_report', report: 'attendance-discrepancies', columns: DISCREPANCY_COLUMNS })
  @ApiErrors(401, 403, 422, 429)
  async discrepancies(@Query() query: DiscrepanciesQueryDto): Promise<Page<DiscrepancyDto>> {
    const from = fromDateString(query.from);
    const to = fromDateString(query.to);
    assertRange(from, to, DISCREPANCY_MAX_DAYS, { field: 'to', from: 'from' });
    const { rows, total } = await this.reports.discrepancies(this.context.schoolId, {
      from,
      to,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...pageWindow(query),
    });
    return toPage(
      rows.map((r) => ({
        kind: r.kind,
        date: toDateString(r.date),
        studentId: r.studentId?.toString() ?? null,
        studentName: r.studentName,
        classId: r.classId.toString(),
        className: r.className,
        sectionId: r.sectionId.toString(),
        sectionName: r.sectionName,
        period: r.period,
        presentPeriods: r.presentPeriods,
        absentPeriods: r.absentPeriods,
        amendments: r.amendments,
      })),
      query,
      total,
    );
  }
}
