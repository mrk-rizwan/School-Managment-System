import { Injectable } from '@nestjs/common';
import { teachingDays } from '@asms/shared';
import { SchoolContext } from '../../common/school-context';
import { parseRange as parseDateRange, toDateString } from '../academics/academics.shared';
import type { CalendarRangeQueryDto, MyCalendarDto, TeachingDaysDto } from './calendar.dto';
import { CalendarService } from './calendar.service';

/** At most 366 days inclusive (§5.1). */
const MAX_RANGE_DAYS = 365;

/** dateTo ≥ dateFrom and within 366 days inclusive; 422 on dateTo. */
export const parseRange = (query: CalendarRangeQueryDto): { from: Date; to: Date } =>
  parseDateRange(query.dateFrom, query.dateTo, MAX_RANGE_DAYS);

/** GET /calendar/teaching-days and GET /me/calendar (contracts/slice-10.md §5). */
@Injectable()
export class CalendarReadsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly calendar: CalendarService,
  ) {}

  async teachingDays(query: CalendarRangeQueryDto): Promise<TeachingDaysDto> {
    const { from, to } = parseRange(query);
    const range = await this.calendar.calendar(this.context.schoolId, from, to);
    return {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      teachingDays: teachingDays(query.dateFrom, query.dateTo, range.value),
      weeklyOffDays: range.weeklyOffDays,
      holidays: range.holidays.map((h) => ({
        id: h.id.toString(),
        startsOn: toDateString(h.startsOn),
        endsOn: toDateString(h.endsOn),
        name: h.name,
        kind: h.kind,
        appliesToStaff: h.appliesToStaff,
      })),
    };
  }

  /** Published holidays only, with no id, description, actor or reason. */
  async myCalendar(query: CalendarRangeQueryDto): Promise<MyCalendarDto> {
    const { from, to } = parseRange(query);
    const range = await this.calendar.calendar(this.context.schoolId, from, to);
    return {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      weeklyOffDays: range.weeklyOffDays,
      holidays: range.holidays.map((h) => ({
        startsOn: toDateString(h.startsOn),
        endsOn: toDateString(h.endsOn),
        name: h.name,
        kind: h.kind,
        appliesToStaff: h.appliesToStaff,
      })),
    };
  }
}
