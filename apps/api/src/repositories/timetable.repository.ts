import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AcademicYearStatus, AttendanceMode } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { staffNames, userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// Phase 5 slice 37 (contracts/slice-37.md §2): the timetable module's writes and its manager
// reads. Importable only from src/modules/timetable/** (lint); attendance and leave read through
// TimetableReadsRepository. Versions and slots are never edited (rule 33): a supersede updates
// the predecessor's effective_to, then inserts the version, then its slots (the slot guard copies
// the version's range and void onto each); a void sets voided_at, then restores the predecessor.

export interface TimetableSection {
  id: bigint;
  name: string;
  deletedAt: Date | null;
  classId: bigint;
  className: string;
  attendanceMode: AttendanceMode;
  academicYearId: bigint;
  yearStartsOn: Date;
  yearEndsOn: Date;
  yearStatus: AcademicYearStatus;
}

export interface VersionRecord {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdBy: bigint;
  createdAt: Date;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
}

export interface NewSlot {
  weekday: number;
  period: number;
  classSubjectId: bigint;
  staffId: bigint;
  room: string | null;
}

/** A slot of another section for the clash check, with its section. */
export interface OtherSlotRow {
  id: bigint;
  sectionId: bigint;
  weekday: number;
  period: number;
  staffId: bigint;
  room: string | null;
}

export type VersionStatusFilter = 'live' | 'future' | 'past' | 'voided';

export interface SubstitutionRecord {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  date: Date;
  period: number;
  staffId: bigint;
  reason: string;
  createdBy: bigint;
  createdAt: Date;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
}

const VERSION_SELECT = {
  id: true,
  sectionId: true,
  classId: true,
  academicYearId: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdBy: true,
  createdAt: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
} as const satisfies Prisma.TimetableVersionSelect;

const SUBSTITUTION_SELECT = {
  id: true,
  sectionId: true,
  classId: true,
  date: true,
  period: true,
  staffId: true,
  reason: true,
  createdBy: true,
  createdAt: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
} as const satisfies Prisma.TimetableSubstitutionSelect;

/** The version-list filter on its status against `today`. */
function statusWhere(status: VersionStatusFilter, today: Date): Prisma.TimetableVersionWhereInput {
  switch (status) {
    case 'voided':
      return { voidedAt: { not: null } };
    case 'future':
      return { voidedAt: null, effectiveFrom: { gt: today } };
    case 'past':
      return { voidedAt: null, effectiveTo: { lt: today } };
    case 'live':
      return {
        voidedAt: null,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      };
  }
}

@Injectable()
export class TimetableRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ------------------------------------------------------------------------------ the section

  /** The section with its class and year; archived sections included (deletedAt set). */
  async findSection(schoolId: SchoolId, sectionId: bigint): Promise<TimetableSection | null> {
    const section = await this.txHost.tx.section.findFirst({
      where: { schoolId, id: sectionId },
      select: { id: true, name: true, deletedAt: true, classId: true },
    });
    if (!section) return null;
    const klass = await this.txHost.tx.class.findFirst({
      where: { schoolId, id: section.classId },
      select: { name: true, attendanceMode: true, academicYearId: true },
    });
    if (!klass) return null;
    const year = await this.txHost.tx.academicYear.findFirst({
      where: { schoolId, id: klass.academicYearId },
      select: { startsOn: true, endsOn: true, status: true },
    });
    if (!year) return null;
    return {
      ...section,
      className: klass.name,
      attendanceMode: klass.attendanceMode,
      academicYearId: klass.academicYearId,
      yearStartsOn: year.startsOn,
      yearEndsOn: year.endsOn,
      yearStatus: year.status,
    };
  }

  /** The year's live sections with class names, class then section name order (the grid). */
  async sectionsOfYear(
    schoolId: SchoolId,
    academicYearId: bigint,
  ): Promise<{ id: bigint; name: string; classId: bigint; className: string }[]> {
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, academicYearId },
      select: { id: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    if (classes.length === 0) return [];
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, classId: { in: classes.map((c) => c.id) }, deletedAt: null },
      select: { id: true, name: true, classId: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return classes.flatMap((c) =>
      sections.filter((s) => s.classId === c.id).map((s) => ({ ...s, className: c.name })),
    );
  }

  /** The class's live (unarchived) class-subjects among `ids`, with their subject. */
  liveClassSubjects(
    schoolId: SchoolId,
    classId: bigint,
    ids: readonly bigint[],
  ): Promise<{ id: bigint; subjectId: bigint }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.txHost.tx.classSubject.findMany({
      where: { schoolId, classId, archivedAt: null, id: { in: [...new Set(ids)] } },
      select: { id: true, subjectId: true },
    });
  }

  /** The active staff among `ids`. */
  async activeStaffIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<Set<bigint>> {
    if (ids.length === 0) return new Set();
    const rows = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] }, status: 'active' },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  // ------------------------------------------------------------------------------ versions

  findVersion(schoolId: SchoolId, id: bigint): Promise<VersionRecord | null> {
    return this.txHost.tx.timetableVersion.findFirst({ where: { schoolId, id }, select: VERSION_SELECT });
  }

  async listVersions(
    schoolId: SchoolId,
    query: {
      sectionId?: bigint;
      academicYearId?: bigint;
      status?: VersionStatusFilter;
      today: Date;
      sort: 'effectiveFrom' | '-effectiveFrom';
      skip: number;
      take: number;
    },
  ): Promise<{ rows: VersionRecord[]; total: number }> {
    const where: Prisma.TimetableVersionWhereInput = {
      schoolId,
      ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.status === undefined ? {} : statusWhere(query.status, query.today)),
    };
    const direction = query.sort === 'effectiveFrom' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.timetableVersion.findMany({
      where,
      select: VERSION_SELECT,
      orderBy: [{ effectiveFrom: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.timetableVersion.count({ where });
    return { rows, total };
  }

  /** Slot counts per version (one statement). */
  async slotCounts(schoolId: SchoolId, versionIds: readonly bigint[]): Promise<Map<bigint, number>> {
    if (versionIds.length === 0) return new Map();
    const rows = await this.txHost.tx.timetableSlot.groupBy({
      by: ['versionId'],
      where: { schoolId, versionId: { in: [...new Set(versionIds)] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.versionId, r._count._all]));
  }

  /** The section's non-voided version starting on or after `from` (a later version exists). */
  laterVersion(schoolId: SchoolId, sectionId: bigint, from: Date): Promise<VersionRecord | null> {
    return this.txHost.tx.timetableVersion.findFirst({
      where: { schoolId, sectionId, voidedAt: null, effectiveFrom: { gte: from } },
      select: VERSION_SELECT,
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  /** The section's version live on `d`, locked (FOR UPDATE through an update of nothing). */
  async lockLiveOn(schoolId: SchoolId, sectionId: bigint, d: Date): Promise<VersionRecord | null> {
    const row = await this.txHost.tx.timetableVersion.findFirst({
      where: {
        schoolId,
        sectionId,
        voidedAt: null,
        effectiveFrom: { lte: d },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }],
      },
      select: VERSION_SELECT,
    });
    if (!row) return null;
    return (await this.lockUnchanged(schoolId, row)) ? row : null;
  }

  /** The non-voided version of the section ending the day before `from` (a void's predecessor). */
  predecessorOf(schoolId: SchoolId, sectionId: bigint, dayBefore: Date): Promise<VersionRecord | null> {
    return this.txHost.tx.timetableVersion.findFirst({
      where: { schoolId, sectionId, voidedAt: null, effectiveTo: dayBefore },
      select: VERSION_SELECT,
    });
  }

  /** Locks the row if unchanged since read (its effective_to and void); false: read again. */
  async lockUnchanged(schoolId: SchoolId, row: VersionRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.timetableVersion.updateMany({
      where: { schoolId, id: row.id, effectiveTo: row.effectiveTo, voidedAt: row.voidedAt },
      data: { voidedAt: row.voidedAt },
    });
    return count === 1;
  }

  /** Sets a version's effective_to (closing it, or restoring it after a void); its slots follow. */
  async setEffectiveTo(schoolId: SchoolId, id: bigint, effectiveTo: Date | null): Promise<void> {
    await this.txHost.tx.timetableVersion.update({
      where: { schoolId_id: { schoolId, id } },
      data: { effectiveTo },
    });
  }

  createVersion(
    schoolId: SchoolId,
    data: { sectionId: bigint; classId: bigint; academicYearId: bigint; effectiveFrom: Date; createdBy: bigint },
  ): Promise<VersionRecord> {
    return this.txHost.tx.timetableVersion.create({ data: { schoolId, ...data }, select: VERSION_SELECT });
  }

  /** The version's slots in one statement (range and void copied by the slot guard). */
  async createSlots(schoolId: SchoolId, version: VersionRecord, slots: readonly NewSlot[]): Promise<void> {
    await this.txHost.tx.timetableSlot.createMany({
      data: slots.map((s) => ({
        schoolId,
        versionId: version.id,
        classId: version.classId,
        weekday: s.weekday,
        period: s.period,
        classSubjectId: s.classSubjectId,
        staffId: s.staffId,
        room: s.room,
        // Overwritten by timetable_slots_guard from the version.
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
      })),
    });
  }

  /** A version's slots as inputs (the copy source). */
  slotInputsOf(schoolId: SchoolId, versionId: bigint): Promise<NewSlot[]> {
    return this.txHost.tx.timetableSlot.findMany({
      where: { schoolId, versionId },
      select: { weekday: true, period: true, classSubjectId: true, staffId: true, room: true },
      orderBy: [{ weekday: 'asc' }, { period: 'asc' }],
    });
  }

  async voidVersion(schoolId: SchoolId, id: bigint, by: bigint, reason: string, at: Date): Promise<void> {
    await this.txHost.tx.timetableVersion.update({
      where: { schoolId_id: { schoolId, id } },
      data: { voidedAt: at, voidedBy: by, voidReason: reason },
    });
  }

  /**
   * Other sections' non-voided slots whose range meets [from, to] (to null: open-ended), for the
   * clash check (R302). Two statements.
   */
  async otherSlotsMeeting(
    schoolId: SchoolId,
    sectionId: bigint,
    from: Date,
    to: Date | null,
  ): Promise<OtherSlotRow[]> {
    const rows = await this.txHost.tx.timetableSlot.findMany({
      where: {
        schoolId,
        voidedAt: null,
        ...(to === null ? {} : { effectiveFrom: { lte: to } }),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      select: { id: true, versionId: true, weekday: true, period: true, staffId: true, room: true },
    });
    if (rows.length === 0) return [];
    const versions = await this.txHost.tx.timetableVersion.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.versionId))] } },
      select: { id: true, sectionId: true },
    });
    const sectionOf = new Map(versions.map((v) => [v.id, v.sectionId]));
    return rows.flatMap((r) => {
      const of = sectionOf.get(r.versionId);
      return of === undefined || of === sectionId
        ? []
        : [{ id: r.id, sectionId: of, weekday: r.weekday, period: r.period, staffId: r.staffId, room: r.room }];
    });
  }

  // ------------------------------------------------------------------------------ substitutions

  findSubstitution(schoolId: SchoolId, id: bigint): Promise<SubstitutionRecord | null> {
    return this.txHost.tx.timetableSubstitution.findFirst({ where: { schoolId, id }, select: SUBSTITUTION_SELECT });
  }

  /** A live substitution for the section-date-period, or naming the staff member at date-period. */
  liveSubstitutionClash(
    schoolId: SchoolId,
    input: { sectionId: bigint; staffId: bigint; date: Date; period: number },
  ): Promise<SubstitutionRecord | null> {
    return this.txHost.tx.timetableSubstitution.findFirst({
      where: {
        schoolId,
        voidedAt: null,
        date: input.date,
        period: input.period,
        OR: [{ sectionId: input.sectionId }, { staffId: input.staffId }],
      },
      select: SUBSTITUTION_SELECT,
    });
  }

  /** The section's live substitutions dated in [from, to] (to null: open-ended), oldest first. */
  async liveSubstitutionIds(schoolId: SchoolId, sectionId: bigint, from: Date, to: Date | null): Promise<bigint[]> {
    const rows = await this.txHost.tx.timetableSubstitution.findMany({
      where: { schoolId, sectionId, voidedAt: null, date: { gte: from, ...(to === null ? {} : { lte: to }) } },
      select: { id: true },
      orderBy: [{ date: 'asc' }, { period: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    return rows.map((r) => r.id);
  }

  createSubstitution(
    schoolId: SchoolId,
    data: { sectionId: bigint; classId: bigint; date: Date; period: number; staffId: bigint; reason: string; createdBy: bigint },
  ): Promise<SubstitutionRecord> {
    return this.txHost.tx.timetableSubstitution.create({ data: { schoolId, ...data }, select: SUBSTITUTION_SELECT });
  }

  /** Voids the row if still live; false when another request voided it first. */
  async voidSubstitution(schoolId: SchoolId, id: bigint, by: bigint, reason: string, at: Date): Promise<boolean> {
    const { count } = await this.txHost.tx.timetableSubstitution.updateMany({
      where: { schoolId, id, voidedAt: null },
      data: { voidedAt: at, voidedBy: by, voidReason: reason },
    });
    return count === 1;
  }

  async listSubstitutions(
    schoolId: SchoolId,
    query: {
      sectionId?: bigint;
      staffId?: bigint;
      from?: Date;
      to?: Date;
      includeVoided: boolean;
      sort: 'date' | '-date';
      skip: number;
      take: number;
    },
  ): Promise<{ rows: SubstitutionRecord[]; total: number }> {
    const where: Prisma.TimetableSubstitutionWhereInput = {
      schoolId,
      ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.includeVoided ? {} : { voidedAt: null }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            date: {
              ...(query.from === undefined ? {} : { gte: query.from }),
              ...(query.to === undefined ? {} : { lte: query.to }),
            },
          }),
    };
    const direction = query.sort === 'date' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.timetableSubstitution.findMany({
      where,
      select: SUBSTITUTION_SELECT,
      orderBy: [{ date: direction }, { period: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.timetableSubstitution.count({ where });
    return { rows, total };
  }

  // ------------------------------------------------------------------------------ names

  staffNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<(id: bigint) => string | undefined> {
    return staffNames(this.txHost.tx, schoolId, ids);
  }

  userNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    return userNames(this.txHost.tx, schoolId, ids);
  }
}
