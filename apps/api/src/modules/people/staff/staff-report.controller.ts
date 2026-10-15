import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability, type CsvColumn } from '@asms/shared';
import { RequireCapability } from '../../../common/auth/route-access';
import { ApiErrors } from '../../../common/openapi';
import { perUserThrottle } from '../../../common/rate-limit';
import { CsvExport, csvCost } from '../../../common/report-export';
import { StaffReportDto, StaffReportQueryDto, type StaffReportRowDto } from './staff-report.dto';
import { StaffReportService } from './staff-report.service';

/** §5.1 new throttle: the staff reports, 30/min and 300/h per user; a CSV export costs 5 (R336). */
export const StaffReportsThrottleGuard = perUserThrottle('staff-reports', 30, 300, csvCost);

const STANDING_LABELS = {
  none: 'No contract',
  live: 'In force',
  expired_not_ended: 'Expired, not ended',
  ended: 'Ended',
} as const;

/** R336: the staff report's CSV, the tab's columns. */
export const STAFF_REPORT_COLUMNS: readonly CsvColumn<StaffReportRowDto>[] = [
  { header: 'Staff', value: (r) => r.fullName },
  { header: 'Designation', value: (r) => r.designation },
  { header: 'Status', value: (r) => r.status },
  { header: 'Present', value: (r) => r.present },
  { header: 'Late', value: (r) => r.late },
  { header: 'Absent', value: (r) => r.absent },
  { header: 'On leave', value: (r) => r.onLeave },
  { header: 'Attendance percent', value: (r) => r.attendancePercent },
  { header: 'Leave taken (days)', value: (r) => r.leaveTakenDays },
  { header: 'Contract', value: (r) => STANDING_LABELS[r.contractStatus] },
  { header: 'Contract type', value: (r) => r.contractType },
  { header: 'Contract ends', value: (r) => r.contractEndsOn },
  { header: 'Ending within 60 days', value: (r) => r.contractEndingSoon },
];

/** Phase 5 slice 42 (R337): the staff report family. */
@ApiTags('staff')
@Controller('staff-reports')
@RequireCapability(Capability.STAFF_VIEW)
@UseGuards(StaffReportsThrottleGuard)
export class StaffReportsController {
  constructor(private readonly reports: StaffReportService) {}

  @Get('summary')
  @ApiOkResponse({ type: StaffReportDto })
  @CsvExport({ family: 'staff_report', report: 'staff-summary', columns: STAFF_REPORT_COLUMNS })
  @ApiErrors(401, 403, 422, 429)
  summary(@Query() query: StaffReportQueryDto): Promise<StaffReportDto> {
    return this.reports.summary(query);
  }
}
