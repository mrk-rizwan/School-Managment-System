import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { fieldRefused } from '../../../common/errors/api-exception';
import { pageWindow } from '../../../common/report-export';
import { addDays, assertRange, SchoolClock } from '../../../common/school-clock';
import { SchoolContext } from '../../../common/school-context';
import { StaffReportRepository, type LatestContract } from '../../../repositories/staff-report.repository';
import { fromDateString, toDateString } from '../../academics/academics.shared';
import {
  CONTRACT_ENDING_SOON_DAYS,
  type StaffContractStanding,
  type StaffReportDto,
  type StaffReportQueryDto,
} from './staff-report.dto';

/** A staff report window is at most a year. */
export const STAFF_REPORT_MAX_DAYS = 366;

/** One decimal, half-up: (present + late) ÷ (present + late + absent); null when nothing counts. */
export function staffAttendancePercent(counts: { present: number; late: number; absent: number }): number | null {
  const attended = counts.present + counts.late;
  const counted = attended + counts.absent;
  if (counted === 0) return null;
  return Math.round((attended * 1000) / counted) / 10;
}

/** The newest contract's standing on `today` (R337: "expired, not ended" is its own state). */
export function contractStanding(contract: LatestContract | undefined, today: Date): StaffContractStanding {
  if (contract === undefined) return 'none';
  if (contract.endedAt !== null) return 'ended';
  if (contract.endsOn !== null && contract.endsOn < today) return 'expired_not_ended';
  return 'live';
}

/**
 * GET /staff-reports/summary (Phase 5 rule 38, R337; contracts/slice-42.md §2.4): one row per
 * member employed in the window (not left before it), by name: attendance counts and percentage
 * from staff_attendance, approved leave taken, and the newest contract's standing with the
 * ending-soon flag. staff.view; school-wide. A GET: nothing is written.
 */
@Injectable()
export class StaffReportService {
  constructor(
    private readonly context: SchoolContext,
    private readonly reports: StaffReportRepository,
    private readonly clock: SchoolClock,
  ) {}

  async summary(query: StaffReportQueryDto): Promise<StaffReportDto> {
    const schoolId = this.context.schoolId;
    const today = await this.clock.today(schoolId);
    const to = query.to === undefined ? today : fromDateString(query.to);
    const from = query.from === undefined ? new Date(Date.UTC(to.getUTCFullYear(), 0, 1)) : fromDateString(query.from);
    if (query.to === undefined && query.from !== undefined && from > to) {
      throw fieldRefused('from', ErrorCode.INVALID_VALUE, 'from must be on or before today when to is not given');
    }
    assertRange(from, to, STAFF_REPORT_MAX_DAYS, { field: 'to', from: 'from' });
    const { rows, total } = await this.reports.members(
      schoolId,
      { from, ...(query.staffName === undefined ? {} : { staffName: query.staffName }) },
      pageWindow(query),
    );
    const ids = rows.map((r) => r.id);
    const attendance = await this.reports.attendance(schoolId, ids, from, to);
    const leave = await this.reports.leaveTaken(schoolId, ids, from, to);
    const contracts = await this.reports.latestContracts(schoolId, ids);
    const soon = addDays(today, CONTRACT_ENDING_SOON_DAYS);
    return {
      from: toDateString(from),
      to: toDateString(to),
      data: rows.map((member) => {
        const counts = attendance.get(member.id) ?? { present: 0, absent: 0, late: 0, onLeave: 0 };
        const contract = contracts.get(member.id);
        const standing = contractStanding(contract, today);
        return {
          staffId: member.id.toString(),
          fullName: member.fullName,
          designation: member.designation,
          status: member.status,
          ...counts,
          attendancePercent: staffAttendancePercent(counts),
          leaveTakenDays: leave.get(member.id) ?? 0,
          contractStatus: standing,
          contractType: contract?.type ?? null,
          contractEndsOn: contract?.endsOn == null ? null : toDateString(contract.endsOn),
          contractEndingSoon: standing === 'live' && contract?.endsOn != null && contract.endsOn <= soon,
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
    };
  }
}
