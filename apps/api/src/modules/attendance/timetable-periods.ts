import { Injectable } from '@nestjs/common';
import { assignedOn, spanHolds, TimetableReadsRepository } from '../../repositories/timetable-reads.repository';
import type { SchoolId } from '../../tenancy/school-id';

// Phase 5 slice 37 (contracts/slice-37.md §3.1, §3.2; R305): the timetabled periods of
// section-days, read through TimetableReadsRepository (attendance's only way to the timetable).

export interface TimetabledPeriod {
  period: number;
  subjectName: string;
  /** The slot teacher's name, or the substitute's where a live substitution names one. */
  teacherName: string;
  /**
   * False when the slot's teacher holds no live assignment for the subject and section on the
   * date and no substitute takes it: "no assigned teacher" (R303, R305).
   */
  assigned: boolean;
}

@Injectable()
export class TimetablePeriods {
  constructor(private readonly timetable: TimetableReadsRepository) {}

  /**
   * Per section with a version live on `date`, its slots of the date's weekday in period order.
   * A section absent from the map has no live version, or a live version with no slot on that
   * weekday (wave R review): Phase 2 rules apply to it that day. Five statements at most, whatever
   * the number of sections.
   */
  async on(
    schoolId: SchoolId,
    sections: readonly { sectionId: bigint; classId: bigint }[],
    date: Date,
  ): Promise<Map<bigint, TimetabledPeriod[]>> {
    const out = new Map<bigint, TimetabledPeriod[]>();
    if (sections.length === 0) return out;
    const sectionIds = sections.map((s) => s.sectionId);
    const versions = (await this.timetable.versionsBetween(schoolId, sectionIds, date, date)).filter((v) =>
      spanHolds(v, date),
    );
    if (versions.length === 0) return out;
    const slots = await this.timetable.slotsOfVersions(schoolId, versions, date.getUTCDay());
    const subs = await this.timetable.substitutionsBetween(schoolId, { sectionIds, from: date, to: date });
    const assignments = await this.timetable.subjectAssignments(
      schoolId,
      versions.map((v) => v.classId),
      date,
      date,
    );
    for (const slot of slots) {
      if (!out.has(slot.sectionId)) out.set(slot.sectionId, []);
      const sub = subs.find((s) => s.sectionId === slot.sectionId && s.period === slot.period);
      out.get(slot.sectionId)?.push({
        period: slot.period,
        subjectName: slot.subjectName,
        teacherName: sub?.staffName ?? slot.staffName,
        assigned: sub !== undefined || assignedOn(assignments, slot, date),
      });
    }
    return out;
  }
}
