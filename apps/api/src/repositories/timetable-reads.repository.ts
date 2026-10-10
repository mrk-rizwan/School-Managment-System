import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import { staffNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// Phase 5 slice 37 (contracts/slice-37.md; phase-5-extended.md §2 boundaries): the read side of
// the timetable. The attendance module (R304, R305, SectionDayDto.periods) and the leave module
// (R307) read the timetable only through this repository; the timetable module's views use it
// too. Read-only: no method writes. Dates are DATE values (UTC midnight); a version or slot is
// live on `d` when not voided and effective_from <= d <= coalesce(effective_to, infinity).

export interface VersionSpan {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface SlotView {
  id: bigint;
  versionId: bigint;
  /** The version's section (slots carry the class only). */
  sectionId: bigint;
  classId: bigint;
  weekday: number;
  period: number;
  classSubjectId: bigint;
  subjectId: bigint;
  subjectName: string;
  staffId: bigint;
  staffName: string;
  room: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface SubstitutionView {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  date: Date;
  period: number;
  staffId: bigint;
  staffName: string;
  reason: string;
  createdBy: bigint;
  createdAt: Date;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
}

/** A subject_teacher assignment, for "no assigned teacher" (R303). */
export interface SubjectAssignmentSpan {
  staffId: bigint;
  classId: bigint;
  /** Null: every section of the class (R54). */
  sectionId: bigint | null;
  subjectId: bigint;
  startsOn: Date;
  endsOn: Date | null;
}

const ADMISSION = Symbol('substitute-admission');

/**
 * Wave R review (security MEDIUM-1): the proof that a live substitution names a staff member for
 * one section, date and period. Only periodAccess below constructs one (the constructor needs a
 * module-private token, and the private member makes the type nominal, so an object literal does
 * not satisfy it). PermissionsService.rowScopeWith takes it instead of a bare section id, so the
 * register scope can be widened only to a section the lookup confirmed.
 */
export class SubstituteAdmission {
  readonly kind = 'substitute' as const;
  private readonly proof = ADMISSION;

  constructor(
    token: typeof ADMISSION,
    readonly sectionId: bigint,
    readonly date: Date,
    readonly period: number,
    readonly staffId: bigint,
  ) {
    if (token !== ADMISSION || this.proof !== ADMISSION) throw new Error('SubstituteAdmission is issued by TimetableReadsRepository only');
  }
}

/** R304: who may write one section-date-period by the timetable. */
export interface PeriodAccess {
  /** The section has a version live on the date. */
  live: boolean;
  /** The live version's slot teacher at that weekday and period; null when untimetabled. */
  slotStaffId: bigint | null;
  /** A live substitution names the caller for that section, date and period: its proof, else null. */
  substitute: SubstituteAdmission | null;
}

const VERSION_SELECT = {
  id: true,
  sectionId: true,
  classId: true,
  academicYearId: true,
  effectiveFrom: true,
  effectiveTo: true,
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

const SLOT_SELECT = {
  id: true,
  versionId: true,
  classId: true,
  weekday: true,
  period: true,
  classSubjectId: true,
  staffId: true,
  room: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const satisfies Prisma.TimetableSlotSelect;

type SlotRow = Prisma.TimetableSlotGetPayload<{ select: typeof SLOT_SELECT }>;

/** A non-voided range meeting [from, to]. */
const overlapping = (from: Date, to: Date) => ({
  voidedAt: null,
  effectiveFrom: { lte: to },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
});

/** True when the span holds `d`. */
export const spanHolds = (span: { effectiveFrom: Date; effectiveTo: Date | null }, d: Date): boolean =>
  span.effectiveFrom <= d && (span.effectiveTo === null || span.effectiveTo >= d);

/** True when the assignment teaches the subject in the section on `d` (R303). */
export function assignedOn(
  assignments: readonly SubjectAssignmentSpan[],
  slot: { staffId: bigint; classId: bigint; sectionId: bigint; subjectId: bigint },
  d: Date,
): boolean {
  return assignments.some(
    (a) =>
      a.staffId === slot.staffId &&
      a.classId === slot.classId &&
      a.subjectId === slot.subjectId &&
      (a.sectionId === null || a.sectionId === slot.sectionId) &&
      a.startsOn <= d &&
      (a.endsOn === null || a.endsOn >= d),
  );
}

@Injectable()
export class TimetableReadsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The sections' non-voided versions meeting [from, to], oldest first. */
  versionsBetween(schoolId: SchoolId, sectionIds: readonly bigint[], from: Date, to: Date): Promise<VersionSpan[]> {
    if (sectionIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.timetableVersion.findMany({
      where: { schoolId, sectionId: { in: [...new Set(sectionIds)] }, ...overlapping(from, to) },
      select: VERSION_SELECT,
      orderBy: [{ sectionId: 'asc' }, { effectiveFrom: 'asc' }],
    });
  }

  /** Every non-voided version of the school live on `d` (the grid, R305). */
  versionsLiveOn(schoolId: SchoolId, d: Date): Promise<VersionSpan[]> {
    return this.txHost.tx.timetableVersion.findMany({
      where: { schoolId, ...overlapping(d, d) },
      select: VERSION_SELECT,
      orderBy: { sectionId: 'asc' },
    });
  }

  /** The versions by id, any state. */
  versionsByIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<VersionSpan[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.txHost.tx.timetableVersion.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: VERSION_SELECT,
    });
  }

  /** The versions' slots (optionally one weekday), with subject and teacher names; weekday, period order. */
  async slotsOfVersions(schoolId: SchoolId, versions: readonly VersionSpan[], weekday?: number): Promise<SlotView[]> {
    if (versions.length === 0) return [];
    const rows = await this.txHost.tx.timetableSlot.findMany({
      where: {
        schoolId,
        versionId: { in: versions.map((v) => v.id) },
        ...(weekday === undefined ? {} : { weekday }),
      },
      select: SLOT_SELECT,
      orderBy: [{ weekday: 'asc' }, { period: 'asc' }, { id: 'asc' }],
    });
    const sectionOf = new Map(versions.map((v) => [v.id, v.sectionId]));
    return this.withNames(schoolId, rows, (versionId) => sectionOf.get(versionId));
  }

  /** One staff member's non-voided slots meeting [from, to], in any section. */
  async staffSlotsBetween(schoolId: SchoolId, staffId: bigint, from: Date, to: Date): Promise<SlotView[]> {
    const rows = await this.txHost.tx.timetableSlot.findMany({
      where: { schoolId, staffId, ...overlapping(from, to) },
      select: SLOT_SELECT,
      orderBy: [{ weekday: 'asc' }, { period: 'asc' }, { id: 'asc' }],
    });
    const versions = await this.versionsByIds(schoolId, rows.map((r) => r.versionId));
    const sectionOf = new Map(versions.map((v) => [v.id, v.sectionId]));
    return this.withNames(schoolId, rows, (versionId) => sectionOf.get(versionId));
  }

  /** Several staff members' non-voided slots meeting [from, to] (R307, a page of leave requests). */
  async staffSlotsOf(schoolId: SchoolId, staffIds: readonly bigint[], from: Date, to: Date): Promise<SlotView[]> {
    if (staffIds.length === 0) return [];
    const rows = await this.txHost.tx.timetableSlot.findMany({
      where: { schoolId, staffId: { in: [...new Set(staffIds)] }, ...overlapping(from, to) },
      select: SLOT_SELECT,
      orderBy: [{ weekday: 'asc' }, { period: 'asc' }, { id: 'asc' }],
    });
    const versions = await this.versionsByIds(schoolId, rows.map((r) => r.versionId));
    const sectionOf = new Map(versions.map((v) => [v.id, v.sectionId]));
    return this.withNames(schoolId, rows, (versionId) => sectionOf.get(versionId));
  }

  /** Live substitutions on [from, to], by section and/or substitute; date, period order. */
  async substitutionsBetween(
    schoolId: SchoolId,
    filter: { sectionIds?: readonly bigint[]; staffIds?: readonly bigint[]; from: Date; to: Date },
  ): Promise<SubstitutionView[]> {
    if (filter.sectionIds?.length === 0 || filter.staffIds?.length === 0) return [];
    const rows = await this.txHost.tx.timetableSubstitution.findMany({
      where: {
        schoolId,
        voidedAt: null,
        date: { gte: filter.from, lte: filter.to },
        ...(filter.sectionIds === undefined ? {} : { sectionId: { in: [...new Set(filter.sectionIds)] } }),
        ...(filter.staffIds === undefined ? {} : { staffId: { in: [...new Set(filter.staffIds)] } }),
      },
      select: SUBSTITUTION_SELECT,
      orderBy: [{ date: 'asc' }, { period: 'asc' }, { id: 'asc' }],
    });
    const name = await staffNames(this.txHost.tx, schoolId, rows.map((r) => r.staffId));
    return rows.map((r) => ({ ...r, staffName: name(r.staffId) ?? '' }));
  }

  /**
   * R304, R306: the section's version live on `date` and its slot teacher at the date's weekday
   * and period, and whether a live substitution names `staffId` there. Three short statements.
   */
  async periodAccess(
    schoolId: SchoolId,
    input: { sectionId: bigint; date: Date; period: number; staffId: bigint | null },
  ): Promise<PeriodAccess> {
    const { sectionId, date, period, staffId } = input;
    const substitute =
      staffId !== null &&
      (await this.txHost.tx.timetableSubstitution.count({
        where: { schoolId, sectionId, date, period, staffId, voidedAt: null },
      })) > 0
        ? new SubstituteAdmission(ADMISSION, sectionId, date, period, staffId)
        : null;
    const version = await this.txHost.tx.timetableVersion.findFirst({
      where: { schoolId, sectionId, ...overlapping(date, date) },
      select: { id: true },
    });
    if (!version) return { live: false, slotStaffId: null, substitute };
    const slot = await this.txHost.tx.timetableSlot.findFirst({
      where: { schoolId, versionId: version.id, weekday: date.getUTCDay(), period },
      select: { staffId: true },
    });
    return { live: true, slotStaffId: slot?.staffId ?? null, substitute };
  }

  /** subject_teacher assignments of the classes meeting [from, to], not voided (R303). */
  subjectAssignments(
    schoolId: SchoolId,
    classIds: readonly bigint[],
    from: Date,
    to: Date,
  ): Promise<SubjectAssignmentSpan[]> {
    if (classIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.teacherAssignment
      .findMany({
        where: {
          schoolId,
          classId: { in: [...new Set(classIds)] },
          role: 'subject_teacher',
          voidedAt: null,
          startsOn: { lte: to },
          OR: [{ endsOn: null }, { endsOn: { gte: from } }],
        },
        select: { staffId: true, classId: true, sectionId: true, subjectId: true, startsOn: true, endsOn: true },
      })
      .then((rows) =>
        rows.flatMap((r) => (r.subjectId === null ? [] : [{ ...r, subjectId: r.subjectId }])),
      );
  }

  /**
   * R308: the student's enrolment in force on some day of [from, to] (the latest started), with
   * its section and class names, in the caller's capacity scope; null when none.
   */
  async enrolmentSectionBetween(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    from: Date,
    to: Date,
  ): Promise<{ sectionId: bigint; sectionName: string; classId: bigint; className: string } | null> {
    const row = await this.txHost.tx.enrolment.findFirst({
      where: {
        schoolId,
        studentId,
        startedOn: { lte: to },
        OR: [{ endedOn: null }, { endedOn: { gte: from } }],
        student: { is: studentInScope(scope) },
      },
      select: { sectionId: true, classId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    if (!row) return null;
    const section = await this.txHost.tx.section.findFirst({
      where: { schoolId, id: row.sectionId },
      select: { name: true },
    });
    const klass = await this.txHost.tx.class.findFirst({
      where: { schoolId, id: row.classId },
      select: { name: true },
    });
    return {
      sectionId: row.sectionId,
      sectionName: section?.name ?? '',
      classId: row.classId,
      className: klass?.name ?? '',
    };
  }

  /** Section and class names by section id (one statement each). */
  async sectionLabels(
    schoolId: SchoolId,
    sectionIds: readonly bigint[],
  ): Promise<Map<bigint, { sectionName: string; classId: bigint; className: string }>> {
    if (sectionIds.length === 0) return new Map();
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: [...new Set(sectionIds)] } },
      select: { id: true, name: true, classId: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: [...new Set(sections.map((s) => s.classId))] } },
      select: { id: true, name: true },
    });
    const className = new Map(classes.map((c) => [c.id, c.name]));
    return new Map(
      sections.map((s) => [s.id, { sectionName: s.name, classId: s.classId, className: className.get(s.classId) ?? '' }]),
    );
  }

  /** Subject and teacher names onto slot rows: two statements, none when empty. */
  private async withNames(
    schoolId: SchoolId,
    rows: readonly SlotRow[],
    sectionOf: (versionId: bigint) => bigint | undefined,
  ): Promise<SlotView[]> {
    if (rows.length === 0) return [];
    const classSubjects = await this.txHost.tx.classSubject.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.classSubjectId))] } },
      select: { id: true, subjectId: true },
    });
    const subjectOf = new Map(classSubjects.map((c) => [c.id, c.subjectId]));
    const subjects = await this.txHost.tx.subject.findMany({
      where: { schoolId, id: { in: [...new Set(classSubjects.map((c) => c.subjectId))] } },
      select: { id: true, name: true },
    });
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const teacher = await staffNames(this.txHost.tx, schoolId, rows.map((r) => r.staffId));
    return rows.flatMap((r) => {
      const sectionId = sectionOf(r.versionId);
      const subjectId = subjectOf.get(r.classSubjectId);
      if (sectionId === undefined || subjectId === undefined) return [];
      return [
        {
          ...r,
          sectionId,
          subjectId,
          subjectName: subjectName.get(subjectId) ?? '',
          staffName: teacher(r.staffId) ?? '',
        },
      ];
    });
  }
}

