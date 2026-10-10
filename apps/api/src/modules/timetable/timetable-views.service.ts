import { Injectable } from '@nestjs/common';
import { isTeachingDay } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import {
  spanHolds,
  TimetableReadsRepository,
  type SlotView,
  type SubstitutionView,
  type VersionSpan,
} from '../../repositories/timetable-reads.repository';
import { TimetableRepository } from '../../repositories/timetable.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import type {
  MyStaffTimetableDto,
  MyTimetableDto,
  SectionTimetableDto,
  TimetableGridDto,
  TimetableGridQueryDto,
} from './timetable.dto';
import { toSlotDto, weekdayOf, weekOf } from './timetable.shared';
import { TimetableService } from './timetable.service';

// contracts/slice-37.md §2.6-§2.8 (R303, R308, R309): the reads. Every staff member reads any
// section's week; a family reads its child's section through names only; the grid is the
// principal's. A week is Monday to Sunday; each day shows the version live on it.

/** The version of `sectionId` live on `d`, among `versions`. */
const liveOn = (versions: readonly VersionSpan[], sectionId: bigint, d: Date): VersionSpan | undefined =>
  versions.find((v) => v.sectionId === sectionId && spanHolds(v, d));

const sameDay = (a: Date, b: Date): boolean => a.getTime() === b.getTime();

@Injectable()
export class TimetableViewsService {
  constructor(
    private readonly reads: TimetableReadsRepository,
    private readonly timetable: TimetableRepository,
    private readonly service: TimetableService,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly clock: SchoolClock,
  ) {}

  /** §2.6, R309: the section's week, each day with its own version. */
  async sectionWeek(session: SchoolSessionContext, sectionId: bigint, date: string | undefined): Promise<SectionTimetableDto> {
    const { schoolId } = session;
    const section = await this.timetable.findSection(schoolId, sectionId);
    if (!section) throw notFound();
    const { days, monday, sunday } = weekOf(await this.dayOrToday(schoolId, date));
    const { periodsPerDay } = await this.settings.read(schoolId);
    const { value: calendar } = await this.calendar.calendar(schoolId, monday, sunday);
    const versions = await this.reads.versionsBetween(schoolId, [sectionId], monday, sunday);
    const slots = await this.reads.slotsOfVersions(schoolId, versions);
    const assignments = await this.reads.subjectAssignments(schoolId, [section.classId], monday, sunday);
    const substitutions = await this.service.substitutionDtos(
      schoolId,
      await this.subRecords(schoolId, [sectionId], monday, sunday),
    );
    return {
      section: {
        id: section.id.toString(),
        name: section.name,
        classId: section.classId.toString(),
        className: section.className,
        academicYearId: section.academicYearId.toString(),
      },
      weekOf: toDateString(monday),
      periodsPerDay,
      days: days.map((d) => {
        const version = liveOn(versions, sectionId, d);
        return {
          date: toDateString(d),
          weekday: weekdayOf(d),
          teachingDay: isTeachingDay(toDateString(d), calendar),
          versionId: version?.id.toString() ?? null,
          slots:
            version === undefined
              ? []
              : slots
                  .filter((s) => s.versionId === version.id && s.weekday === weekdayOf(d))
                  .map((s) => toSlotDto(s, assignments, d)),
          substitutions: substitutions.filter((s) => s.date === toDateString(d)),
        };
      }),
    };
  }

  /** §2.7, R308: the family view of a child (guardian) or of the student's own enrolment. */
  async family(session: SchoolSessionContext, studentId: bigint | null, date: string | undefined): Promise<MyTimetableDto> {
    const { schoolId } = session;
    const scope = scopeOf(session);
    const id = studentId ?? (scope.kind === 'students' ? scope.ids[0] : undefined);
    if (id === undefined || scope.kind !== 'students' || !scope.ids.includes(id)) throw notFound();
    const { days, monday, sunday } = weekOf(await this.dayOrToday(schoolId, date));
    const { periodsPerDay } = await this.settings.read(schoolId);
    const { value: calendar } = await this.calendar.calendar(schoolId, monday, sunday);
    const enrolment = await this.reads.enrolmentSectionBetween(schoolId, scope, id, monday, sunday);
    const versions = enrolment === null ? [] : await this.reads.versionsBetween(schoolId, [enrolment.sectionId], monday, sunday);
    const slots = await this.reads.slotsOfVersions(schoolId, versions);
    const subs =
      enrolment === null
        ? []
        : await this.reads.substitutionsBetween(schoolId, { sectionIds: [enrolment.sectionId], from: monday, to: sunday });
    return {
      studentId: id.toString(),
      sectionName: enrolment?.sectionName ?? null,
      className: enrolment?.className ?? null,
      weekOf: toDateString(monday),
      periodsPerDay,
      days: days.map((d) => {
        const teachingDay = isTeachingDay(toDateString(d), calendar);
        const version = enrolment === null ? undefined : liveOn(versions, enrolment.sectionId, d);
        return {
          date: toDateString(d),
          weekday: weekdayOf(d),
          teachingDay,
          periods:
            version === undefined || !teachingDay
              ? []
              : slots
                  .filter((s) => s.versionId === version.id && s.weekday === weekdayOf(d))
                  .map((s) => ({
                    period: s.period,
                    subjectName: s.subjectName,
                    teacherName: subOf(subs, s.sectionId, d, s.period)?.staffName ?? s.staffName,
                    room: s.room,
                  })),
        };
      }),
    };
  }

  /** The caller's own week across sections: their slots, their substitutions (§1). */
  async staffWeek(session: SchoolSessionContext, weekOfDate: string | undefined): Promise<MyStaffTimetableDto> {
    const { schoolId } = session;
    const { days, monday, sunday } = weekOf(await this.dayOrToday(schoolId, weekOfDate));
    const { periodsPerDay } = await this.settings.read(schoolId);
    const { value: calendar } = await this.calendar.calendar(schoolId, monday, sunday);
    const staffId = session.access.staffId;
    const mine: SlotView[] = staffId === null ? [] : await this.reads.staffSlotsBetween(schoolId, staffId, monday, sunday);
    const taking: SubstitutionView[] =
      staffId === null ? [] : await this.reads.substitutionsBetween(schoolId, { staffIds: [staffId], from: monday, to: sunday });
    const takenFromMe = await this.reads.substitutionsBetween(schoolId, {
      sectionIds: mine.map((s) => s.sectionId),
      from: monday,
      to: sunday,
    });
    // The slots the substitutions I take replace (subject and room), and every label.
    const takingVersions = await this.reads.versionsBetween(schoolId, taking.map((t) => t.sectionId), monday, sunday);
    const takingSlots = await this.reads.slotsOfVersions(schoolId, takingVersions);
    const labels = await this.reads.sectionLabels(schoolId, [...mine.map((s) => s.sectionId), ...taking.map((t) => t.sectionId)]);
    const label = (sectionId: bigint) => labels.get(sectionId);
    return {
      weekOf: toDateString(monday),
      periodsPerDay,
      days: days.map((d) => {
        const weekday = weekdayOf(d);
        const fromSlots = mine
          .filter((s) => s.weekday === weekday && spanHolds(s, d))
          .map((s) => ({
            period: s.period,
            sectionId: s.sectionId.toString(),
            sectionName: label(s.sectionId)?.sectionName ?? '',
            classId: s.classId.toString(),
            className: label(s.sectionId)?.className ?? '',
            subjectName: s.subjectName,
            room: s.room,
            kind: 'slot' as const,
            substitutedByName: subOf(takenFromMe, s.sectionId, d, s.period)?.staffName ?? null,
          }));
        const fromSubs = taking
          .filter((t) => sameDay(t.date, d))
          .map((t) => {
            const version = liveOn(takingVersions, t.sectionId, d);
            const slot = takingSlots.find(
              (s) => s.versionId === version?.id && s.weekday === weekday && s.period === t.period,
            );
            return {
              period: t.period,
              sectionId: t.sectionId.toString(),
              sectionName: label(t.sectionId)?.sectionName ?? '',
              classId: t.classId.toString(),
              className: label(t.sectionId)?.className ?? '',
              subjectName: slot?.subjectName ?? null,
              room: slot?.room ?? null,
              kind: 'substitution' as const,
              substitutedByName: null,
            };
          });
        return {
          date: toDateString(d),
          weekday,
          teachingDay: isTeachingDay(toDateString(d), calendar),
          periods: [...fromSlots, ...fromSubs].sort((a, b) => a.period - b.period),
        };
      }),
    };
  }

  /** §2.8: the year's sections, each with its version live on `date` and that weekday's cells. */
  async grid(schoolId: SchoolId, query: TimetableGridQueryDto): Promise<TimetableGridDto> {
    const date = await this.dayOrToday(schoolId, query.date);
    const weekday = query.weekday ?? weekdayOf(date);
    const academicYearId = BigInt(query.academicYearId);
    const settings = await this.settings.read(schoolId);
    const sections = await this.timetable.sectionsOfYear(schoolId, academicYearId);
    const sectionIds = sections.map((s) => s.id);
    const versions = (await this.reads.versionsBetween(schoolId, sectionIds, date, date)).filter((v) => spanHolds(v, date));
    const slots = await this.reads.slotsOfVersions(schoolId, versions, weekday);
    const assignments = await this.reads.subjectAssignments(schoolId, [...new Set(sections.map((s) => s.classId))], date, date);
    return {
      academicYearId: academicYearId.toString(),
      date: toDateString(date),
      weekday,
      periodsPerDay: settings.periodsPerDay,
      weeklyOffDays: settings.weeklyOffDays,
      sections: sections.map((s) => {
        const version = liveOn(versions, s.id, date);
        return {
          sectionId: s.id.toString(),
          sectionName: s.name,
          classId: s.classId.toString(),
          className: s.className,
          versionId: version?.id.toString() ?? null,
          cells:
            version === undefined
              ? []
              : slots.filter((slot) => slot.versionId === version.id).map((slot) => toSlotDto(slot, assignments, date)),
        };
      }),
    };
  }

  private async dayOrToday(schoolId: SchoolId, date: string | undefined): Promise<Date> {
    return date === undefined ? this.clock.today(schoolId) : fromDateString(date);
  }

  /** Raw live substitution rows for the DTO mapper. */
  private async subRecords(schoolId: SchoolId, sectionIds: readonly bigint[], from: Date, to: Date) {
    const rows = await this.reads.substitutionsBetween(schoolId, { sectionIds, from, to });
    return rows.map(({ staffName: _name, ...row }) => row);
  }
}

/** The live substitution of a section's period on a day. */
function subOf(
  subs: readonly SubstitutionView[],
  sectionId: bigint,
  d: Date,
  period: number,
): SubstitutionView | undefined {
  return subs.find((t) => t.sectionId === sectionId && t.period === period && sameDay(t.date, d));
}
