import { Injectable } from '@nestjs/common';
import { ErrorCode, teachingDays } from '@asms/shared';
import { fieldRefused } from '../../common/errors/api-exception';
import { SchoolContext } from '../../common/school-context';
import { fromDateString, toDateString } from '../academics/academics.shared';
import type { CalendarRangeQueryDto, MyCalendarDto, TeachingDaysDto } from './calendar.dto';
import { CalendarService } from './calendar.service';

/** At most 366 days inclusive (§5.1). */
const MAX_RANGE_DAYS = 365;
const DAY_MS = 86_400_000;

/** dateTo ≥ dateFrom and within 366 days inclusive; 422 on dateTo. */
function parseRange(query: CalendarRangeQueryDto): { from: Date; to: Date } {
  const from = fromDateString(query.dateFrom);
  const to = fromDateString(query.dateTo);
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days < 0 || days > MAX_RANGE_DAYS) {
    throw fieldRefused(
      'dateTo',
      ErrorCode.INVALID_VALUE,
      `dateTo must be on or after dateFrom and at most ${MAX_RANGE_DAYS} days after it`,
    );
  }
  return { from, to };
}

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
      })),
    };
  }
}
