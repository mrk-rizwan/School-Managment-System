import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { DutyKind, EventStatus, EventType, ParticipationStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { Prisma } from './generated/prisma/client';
import { staffNames, userNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// Phase 5 slice 38 (contracts/slice-38.md): events, their sections, duties and participation, and
// the reads the events module needs around them (the roster, the campaign's money totals for the
// report, the event's payments, the family list). Importable only from src/modules/events/**
// (lint). Money is never written here: campaigns, charges and payments are written through their
// own services. The duty scope (rule 32) is checked by the service, which passes the event id it
// has checked.

export interface EventSectionRow {
  sectionId: bigint;
  sectionName: string;
  classId: bigint;
  className: string;
}

export interface EventDutyRecord {
  id: bigint;
  eventId: bigint;
  staffId: bigint;
  staffName: string;
  duty: DutyKind;
  note: string | null;
  createdAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export interface EventRecord {
  id: bigint;
  academicYearId: bigint;
  academicYearName: string;
  type: EventType;
  title: string;
  startsAt: Date;
  endsAt: Date;
  venue: string;
  details: string | null;
  chargeAmount: number | null;
  chargeDueOn: Date | null;
  status: EventStatus;
  campaignId: bigint | null;
  campaignStatus: string | null;
  announcementId: bigint | null;
  cancelAnnouncementId: bigint | null;
  createdBy: bigint;
  createdByName: string;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  updatedAt: Date;
  sections: EventSectionRow[];
}

export interface EventContent {
  type: EventType;
  title: string;
  startsAt: Date;
  endsAt: Date;
  venue: string;
  details: string | null;
  chargeAmount: number | null;
  chargeDueOn: Date | null;
}

export interface EventListQuery {
  academicYearId?: bigint;
  type?: EventType;
  status?: EventStatus;
  /** The statuses the caller may see (drafts only for holiday.manage). */
  visible: readonly EventStatus[];
  startsFrom?: Date;
  startsTo?: Date;
  /** Only these events (the `mine` filter). */
  ids?: readonly bigint[];
  sort: '-startsAt' | 'startsAt';
  skip: number;
  take: number;
}

/** The status row read under a lock. */
export interface LockedEvent {
  id: bigint;
  status: EventStatus;
  academicYearId: bigint;
  campaignId: bigint | null;
  announcementId: bigint | null;
  startsAt: Date;
}

export interface RosterRow {
  studentId: bigint;
  enrolmentId: bigint;
  fullName: string;
  admissionNo: string;
  rollNo: number | null;
  sectionId: bigint;
  sectionName: string;
  className: string;
  participation: ParticipationStatus | null;
  recordedAt: Date | null;
  charge: { chargeId: bigint; amount: number; allocated: number; credited: number; status: string } | null;
}

export interface CampaignTotals {
  chargeCount: number;
  charged: number;
  credited: number;
  collected: number;
}

export interface FamilyEventRow {
  id: bigint;
  type: EventType;
  title: string;
  startsAt: Date;
  endsAt: Date;
  venue: string;
  details: string | null;
  status: EventStatus;
  campaignId: bigint | null;
}

const EVENT_SELECT = {
  id: true,
  academicYearId: true,
  type: true,
  title: true,
  startsAt: true,
  endsAt: true,
  venue: true,
  details: true,
  chargeAmount: true,
  chargeDueOn: true,
  status: true,
  campaignId: true,
  announcementId: true,
  cancelAnnouncementId: true,
  createdBy: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  updatedAt: true,
} satisfies Prisma.EventSelect;

type EventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>;

const distinct = (ids: readonly bigint[]): bigint[] => [...new Set(ids)];

@Injectable()
export class EventRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // --------------------------------------------------------------------------------- events

  async list(schoolId: SchoolId, query: EventListQuery): Promise<{ rows: EventRecord[]; total: number }> {
    const statuses = query.status === undefined ? [...query.visible] : query.visible.filter((s) => s === query.status);
    const where: Prisma.EventWhereInput = {
      schoolId,
      status: { in: statuses },
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.ids === undefined ? {} : { id: { in: [...query.ids] } }),
      ...(query.startsFrom === undefined && query.startsTo === undefined
        ? {}
        : {
            startsAt: {
              ...(query.startsFrom === undefined ? {} : { gte: query.startsFrom }),
              ...(query.startsTo === undefined ? {} : { lt: query.startsTo }),
            },
          }),
    };
    const direction = query.sort === 'startsAt' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.event.findMany({
      where,
      select: EVENT_SELECT,
      orderBy: [{ startsAt: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.event.count({ where });
    return { rows: await this.named(schoolId, rows), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<EventRecord | null> {
    const row = await this.txHost.tx.event.findFirst({ where: { schoolId, id }, select: EVENT_SELECT });
    if (!row) return null;
    const [named] = await this.named(schoolId, [row]);
    return named ?? null;
  }

  /** The event's status row under FOR UPDATE (publish, cancel, complete, edit). */
  async lockForUpdate(schoolId: SchoolId, id: bigint): Promise<LockedEvent | null> {
    const rows = await this.txHost.tx.$queryRaw<LockedEvent[]>`
      SELECT id, status::text AS status, academic_year_id AS "academicYearId", campaign_id AS "campaignId",
             announcement_id AS "announcementId", starts_at AS "startsAt"
        FROM events
       WHERE school_id = ${schoolId} AND id = ${id}
         FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** The event's status row under FOR SHARE (a payment or participation waits for a status change). */
  async lockForShare(schoolId: SchoolId, id: bigint): Promise<LockedEvent | null> {
    const rows = await this.txHost.tx.$queryRaw<LockedEvent[]>`
      SELECT id, status::text AS status, academic_year_id AS "academicYearId", campaign_id AS "campaignId",
             announcement_id AS "announcementId", starts_at AS "startsAt"
        FROM events
       WHERE school_id = ${schoolId} AND id = ${id}
         FOR SHARE`;
    return rows[0] ?? null;
  }

  async create(schoolId: SchoolId, academicYearId: bigint, content: EventContent, createdBy: bigint): Promise<bigint> {
    const { id } = await this.txHost.tx.event.create({
      data: { schoolId, academicYearId, ...content, createdBy },
      select: { id: true },
    });
    return id;
  }

  /** A draft's content (the caller holds the lock). */
  async updateDraft(schoolId: SchoolId, id: bigint, content: Partial<EventContent>): Promise<number> {
    if (Object.keys(content).length === 0) return 1;
    const { count } = await this.txHost.tx.event.updateMany({ where: { schoolId, id, status: 'draft' }, data: content });
    return count;
  }

  /** A draft's sections, replaced whole (event_sections_draft_only allows the delete while draft). */
  async replaceSections(
    schoolId: SchoolId,
    eventId: bigint,
    academicYearId: bigint,
    sections: readonly { sectionId: bigint; classId: bigint }[],
  ): Promise<void> {
    await this.txHost.tx.eventSection.deleteMany({ where: { schoolId, eventId } });
    if (sections.length === 0) return;
    await this.txHost.tx.eventSection.createMany({
      data: sections.map((s) => ({ schoolId, eventId, academicYearId, sectionId: s.sectionId, classId: s.classId })),
    });
  }

  /** draft → published, with the invitation and the campaign, in one UPDATE (R310). */
  async publish(schoolId: SchoolId, id: bigint, links: { announcementId: bigint; campaignId: bigint | null }): Promise<number> {
    const { count } = await this.txHost.tx.event.updateMany({
      where: { schoolId, id, status: 'draft' },
      data: { status: 'published', announcementId: links.announcementId, campaignId: links.campaignId },
    });
    return count;
  }

  async cancel(
    schoolId: SchoolId,
    id: bigint,
    from: EventStatus,
    stamps: { by: bigint; reason: string; at: Date; cancelAnnouncementId: bigint | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.event.updateMany({
      where: { schoolId, id, status: from },
      data: {
        status: 'cancelled',
        cancelledAt: stamps.at,
        cancelledBy: stamps.by,
        cancelReason: stamps.reason,
        cancelAnnouncementId: stamps.cancelAnnouncementId,
      },
    });
    return count;
  }

  async complete(schoolId: SchoolId, id: bigint, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.event.updateMany({
      where: { schoolId, id, status: 'published' },
      data: { status: 'completed', completedAt: at },
    });
    return count;
  }

  // ------------------------------------------------------------------------ set-up reads

  async year(
    schoolId: SchoolId,
    id: bigint,
  ): Promise<{ id: bigint; name: string; status: string; startsOn: Date; endsOn: Date } | null> {
    return this.txHost.tx.academicYear.findFirst({
      where: { schoolId, id },
      select: { id: true, name: true, status: true, startsOn: true, endsOn: true },
    });
  }

  /** The live (not archived) sections among `ids` of the year, with their class. */
  async liveSectionsOfYear(
    schoolId: SchoolId,
    academicYearId: bigint,
    ids: readonly bigint[],
  ): Promise<{ id: bigint; classId: bigint }[]> {
    if (ids.length === 0) return [];
    return this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: distinct(ids) }, deletedAt: null, class: { schoolId, academicYearId } },
      select: { id: true, classId: true },
    });
  }

  /** The school's live head of category `event`, the oldest first (the seeded Event head). */
  async eventHead(schoolId: SchoolId): Promise<{ id: bigint } | null> {
    return this.txHost.tx.feeHead.findFirst({
      where: { schoolId, category: 'event', status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }

  async activeStaff(schoolId: SchoolId, staffId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.staff.findFirst({ where: { schoolId, id: staffId, status: 'active' }, select: { id: true } });
    return row !== null;
  }

  // -------------------------------------------------------------------------------- duties

  async findDuty(schoolId: SchoolId, id: bigint): Promise<EventDutyRecord | null> {
    const [row] = await this.dutiesWhere(schoolId, { schoolId, id });
    return row ?? null;
  }

  async liveDuty(schoolId: SchoolId, eventId: bigint, staffId: bigint, duty: DutyKind): Promise<bigint | null> {
    const row = await this.txHost.tx.eventDuty.findFirst({
      where: { schoolId, eventId, staffId, duty, endedAt: null },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async createDuty(
    schoolId: SchoolId,
    data: { eventId: bigint; staffId: bigint; duty: DutyKind; note: string | null; createdBy: bigint },
  ): Promise<bigint> {
    const { id } = await this.txHost.tx.eventDuty.create({ data: { schoolId, ...data }, select: { id: true } });
    return id;
  }

  async endDuty(schoolId: SchoolId, id: bigint, stamps: { by: bigint; reason: string; at: Date }): Promise<number> {
    const { count } = await this.txHost.tx.eventDuty.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endedAt: stamps.at, endedBy: stamps.by, endReason: stamps.reason },
    });
    return count;
  }

  /** The member's live duties on draft or published events (a leaving member's, B8). */
  async liveDutiesOfStaff(schoolId: SchoolId, staffId: bigint): Promise<{ id: bigint; eventId: bigint; duty: DutyKind }[]> {
    return this.txHost.tx.eventDuty.findMany({
      where: { schoolId, staffId, endedAt: null, event: { is: { schoolId, status: { in: ['draft', 'published'] } } } },
      select: { id: true, eventId: true, duty: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Every duty (live and ended) of these events, oldest first; `staffId` narrows to one member's. */
  dutiesOf(schoolId: SchoolId, eventIds: readonly bigint[], staffId?: bigint): Promise<EventDutyRecord[]> {
    if (eventIds.length === 0) return Promise.resolve([]);
    return this.dutiesWhere(schoolId, {
      schoolId,
      eventId: { in: distinct(eventIds) },
      ...(staffId === undefined ? {} : { staffId }),
    });
  }

  /** The kinds of the member's live duties on the event (rule 32: the duty scope). */
  async liveDutyKinds(schoolId: SchoolId, eventId: bigint, staffId: bigint): Promise<DutyKind[]> {
    const rows = await this.txHost.tx.eventDuty.findMany({
      where: { schoolId, eventId, staffId, endedAt: null },
      select: { duty: true },
    });
    return rows.map((r) => r.duty);
  }

  /** Whether the member ever held (live or ended) a collection duty on the event. */
  async everCollected(schoolId: SchoolId, eventId: bigint, staffId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.eventDuty.findFirst({
      where: { schoolId, eventId, staffId, duty: 'collection' },
      select: { id: true },
    });
    return row !== null;
  }

  private async dutiesWhere(schoolId: SchoolId, where: Prisma.EventDutyWhereInput): Promise<EventDutyRecord[]> {
    const rows = await this.txHost.tx.eventDuty.findMany({
      where,
      select: {
        id: true,
        eventId: true,
        staffId: true,
        duty: true,
        note: true,
        createdAt: true,
        endedAt: true,
        endReason: true,
      },
      orderBy: { id: 'asc' },
    });
    const name = await staffNames(this.txHost.tx, schoolId, rows.map((r) => r.staffId));
    return rows.map((r) => ({ ...r, staffName: name(r.staffId) ?? '' }));
  }

  // --------------------------------------------------------------------------------- scope

  /**
   * The sections among `sectionIds` the member is class teacher or cover of on `on` (rule 32: a
   * class teacher records their own section's roster).
   */
  async classTeacherSections(
    schoolId: SchoolId,
    staffId: bigint,
    sectionIds: readonly bigint[],
    on: Date,
  ): Promise<bigint[]> {
    if (sectionIds.length === 0) return [];
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: {
        schoolId,
        staffId,
        role: { in: ['class_teacher', 'cover'] },
        sectionId: { in: distinct(sectionIds) },
        voidedAt: null,
        startsOn: { lte: on },
        OR: [{ endsOn: null }, { endsOn: { gte: on } }],
      },
      select: { sectionId: true },
    });
    return distinct(rows.flatMap((r) => (r.sectionId === null ? [] : [r.sectionId])));
  }

  /**
   * §2.9: published or completed events on which the member holds a live duty, or one of whose
   * sections they are class teacher or cover of on `today`.
   */
  async mineIds(schoolId: SchoolId, staffId: bigint, today: Date): Promise<bigint[]> {
    const duties = await this.txHost.tx.eventDuty.findMany({
      where: { schoolId, staffId, endedAt: null },
      select: { eventId: true },
    });
    const assignments = await this.txHost.tx.teacherAssignment.findMany({
      where: {
        schoolId,
        staffId,
        role: { in: ['class_teacher', 'cover'] },
        sectionId: { not: null },
        voidedAt: null,
        startsOn: { lte: today },
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      select: { sectionId: true },
    });
    const sectionIds = distinct(assignments.flatMap((a) => (a.sectionId === null ? [] : [a.sectionId])));
    const bySection =
      sectionIds.length === 0
        ? []
        : await this.txHost.tx.eventSection.findMany({
            where: { schoolId, sectionId: { in: sectionIds } },
            select: { eventId: true },
          });
    return distinct([...duties.map((d) => d.eventId), ...bySection.map((s) => s.eventId)]);
  }

  // -------------------------------------------------------------------------------- roster

  /**
   * §1.1, §2.6: the enrolments live in the event's sections on `on` ∪ the students holding a
   * non-voided charge of the campaign (their charge's enrolment), narrowed to `sectionIds` when
   * given; one row per student (the section enrolment first). Class, section, roll and name order.
   */
  async roster(
    schoolId: SchoolId,
    event: { id: bigint; academicYearId: bigint; campaignId: bigint | null; sectionIds: readonly bigint[] },
    on: Date,
    sectionIds: readonly bigint[] | null,
  ): Promise<RosterRow[]> {
    const sections = sectionIds === null ? [...event.sectionIds] : event.sectionIds.filter((id) => sectionIds.includes(id));
    const live =
      sections.length === 0
        ? []
        : await this.txHost.tx.enrolment.findMany({
            where: {
              schoolId,
              academicYearId: event.academicYearId,
              sectionId: { in: sections },
              startedOn: { lte: on },
              OR: [{ endedOn: null }, { endedOn: { gte: on } }],
            },
            select: { id: true, studentId: true, sectionId: true, rollNo: true },
            orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
          });
    const charges =
      event.campaignId === null
        ? []
        : await this.txHost.tx.charge.findMany({
            where: { schoolId, campaignId: event.campaignId, kind: 'campaign', status: { not: 'voided' } },
            select: {
              id: true,
              studentId: true,
              enrolmentId: true,
              amount: true,
              allocatedAmount: true,
              creditedAmount: true,
              status: true,
            },
            orderBy: { id: 'asc' },
          });
    const chargeByStudent = new Map(charges.map((c) => [c.studentId, c]));
    const enrolmentOf = new Map<bigint, { id: bigint; sectionId: bigint; rollNo: number | null }>();
    for (const e of live) if (!enrolmentOf.has(e.studentId)) enrolmentOf.set(e.studentId, e);
    // Charged students outside the live sections: their charge's enrolment, if in scope.
    const missing = charges.filter((c) => !enrolmentOf.has(c.studentId));
    if (missing.length > 0) {
      const rows = await this.txHost.tx.enrolment.findMany({
        where: { schoolId, id: { in: missing.map((c) => c.enrolmentId) } },
        select: { id: true, studentId: true, sectionId: true, rollNo: true },
      });
      for (const e of rows) {
        if (sectionIds !== null && !sectionIds.includes(e.sectionId)) continue;
        if (!enrolmentOf.has(e.studentId)) enrolmentOf.set(e.studentId, e);
      }
    }
    const studentIds = [...enrolmentOf.keys()];
    if (studentIds.length === 0) return [];
    const students = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: studentIds } },
      select: { id: true, fullName: true, admissionNo: true },
    });
    const student = new Map(students.map((s) => [s.id, s]));
    const sectionRows = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: distinct([...enrolmentOf.values()].map((e) => e.sectionId)) } },
      select: { id: true, name: true, class: { select: { name: true } } },
    });
    const section = new Map(sectionRows.map((s) => [s.id, s]));
    const marks = await this.txHost.tx.eventParticipation.findMany({
      where: { schoolId, eventId: event.id, studentId: { in: studentIds } },
      select: { studentId: true, status: true, recordedAt: true },
    });
    const mark = new Map(marks.map((m) => [m.studentId, m]));
    const rows: RosterRow[] = [...enrolmentOf.entries()].map(([studentId, e]) => {
      const c = chargeByStudent.get(studentId);
      const s = section.get(e.sectionId);
      const m = mark.get(studentId);
      return {
        studentId,
        enrolmentId: e.id,
        fullName: student.get(studentId)?.fullName ?? '',
        admissionNo: student.get(studentId)?.admissionNo ?? '',
        rollNo: e.rollNo,
        sectionId: e.sectionId,
        sectionName: s?.name ?? '',
        className: s?.class.name ?? '',
        participation: m?.status ?? null,
        recordedAt: m?.recordedAt ?? null,
        charge: c
          ? { chargeId: c.id, amount: c.amount, allocated: c.allocatedAmount, credited: c.creditedAmount, status: c.status }
          : null,
      };
    });
    return rows.sort(
      (a, b) =>
        a.className.localeCompare(b.className) ||
        a.sectionName.localeCompare(b.sectionName) ||
        (a.rollNo ?? Number.MAX_SAFE_INTEGER) - (b.rollNo ?? Number.MAX_SAFE_INTEGER) ||
        a.fullName.localeCompare(b.fullName) ||
        (a.studentId < b.studentId ? -1 : 1),
    );
  }

  /**
   * R312: one row per student, edited in place; returns how many rows were written (an unchanged
   * status is not rewritten).
   */
  async recordParticipation(
    schoolId: SchoolId,
    event: { id: bigint; academicYearId: bigint },
    rows: readonly { studentId: bigint; enrolmentId: bigint; status: ParticipationStatus }[],
    recordedBy: bigint,
    at: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const existing = await this.txHost.tx.eventParticipation.findMany({
      where: { schoolId, eventId: event.id, studentId: { in: rows.map((r) => r.studentId) } },
      select: { studentId: true, status: true },
    });
    const current = new Map(existing.map((r) => [r.studentId, r.status]));
    let changed = 0;
    for (const row of rows) {
      const was = current.get(row.studentId);
      if (was === row.status) continue;
      changed += 1;
      if (was === undefined) {
        await this.txHost.tx.eventParticipation.create({
          data: {
            schoolId,
            eventId: event.id,
            academicYearId: event.academicYearId,
            studentId: row.studentId,
            enrolmentId: row.enrolmentId,
            status: row.status,
            recordedBy,
            recordedAt: at,
          },
          select: { id: true },
        });
      } else {
        await this.txHost.tx.eventParticipation.updateMany({
          where: { schoolId, eventId: event.id, studentId: row.studentId },
          data: { status: row.status, recordedBy, recordedAt: at },
        });
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------------- report

  /** R314: the campaign's live charges and the live allocations to them. */
  async campaignTotals(schoolId: SchoolId, campaignId: bigint): Promise<CampaignTotals> {
    const charges = await this.txHost.tx.charge.aggregate({
      where: { schoolId, campaignId, kind: 'campaign', status: { not: 'voided' } },
      _count: { _all: true },
      _sum: { amount: true, creditedAmount: true },
    });
    const allocations = await this.txHost.tx.paymentAllocation.aggregate({
      where: { schoolId, reversedAt: null, charge: { schoolId, campaignId } },
      _sum: { amount: true },
    });
    return {
      chargeCount: charges._count._all,
      charged: charges._sum.amount ?? 0,
      credited: charges._sum.creditedAmount ?? 0,
      collected: allocations._sum.amount ?? 0,
    };
  }

  /** R314: the `recorded | approved` expenses tagged to the event. */
  async expenseTotals(schoolId: SchoolId, eventId: bigint): Promise<{ count: number; total: number }> {
    const row = await this.txHost.tx.expense.aggregate({
      where: { schoolId, eventId, status: { in: ['recorded', 'approved'] } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return { count: row._count._all, total: row._sum.amount ?? 0 };
  }

  // -------------------------------------------------------------------------------- family

  /**
   * R315, §2.10: published and completed events whose sections include the section of one of
   * the child's enrolments live on the event's date (school time), or whose campaign holds a
   * non-voided charge of the child (the roster's own union, so a child moved out of a
   * participating section after publish still sees the event and its charge), newest first. The
   * child must be in the capacity scope; outside it nothing is read.
   */
  async familyEvents(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    timezone: string,
    page: { skip: number; take: number },
  ): Promise<{ rows: FamilyEventRow[]; total: number }> {
    if (scope.kind !== 'students' || !scope.ids.includes(studentId)) return { rows: [], total: 0 };
    const match = Prisma.sql`
      FROM events e
     WHERE e.school_id = ${schoolId}
       AND e.status IN ('published', 'completed')
       AND (EXISTS (
         SELECT 1 FROM event_sections es
           JOIN enrolments en ON en.school_id = es.school_id AND en.section_id = es.section_id
          WHERE es.school_id = ${schoolId} AND es.event_id = e.id
            AND en.student_id = ${studentId}
            AND en.started_on <= (e.starts_at AT TIME ZONE ${timezone})::date
            AND (en.ended_on IS NULL OR en.ended_on >= (e.starts_at AT TIME ZONE ${timezone})::date))
        OR (e.campaign_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM charges c
          WHERE c.school_id = ${schoolId} AND c.campaign_id = e.campaign_id
            AND c.student_id = ${studentId} AND c.kind = 'campaign' AND c.status <> 'voided'))
       )`;
    const rows = await this.txHost.tx.$queryRaw<FamilyEventRow[]>`
      SELECT e.id, e.type::text AS type, e.title, e.starts_at AS "startsAt", e.ends_at AS "endsAt", e.venue,
             e.details, e.status::text AS status, e.campaign_id AS "campaignId"
      ${match}
      ORDER BY e.starts_at DESC, e.id DESC
      LIMIT ${page.take} OFFSET ${page.skip}`;
    const [count] = await this.txHost.tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total ${match}`;
    return { rows, total: Number(count?.total ?? 0n) };
  }

  /** The child's live charges of these campaigns (the family DTO's own charge). */
  async childCharges(
    schoolId: SchoolId,
    studentId: bigint,
    campaignIds: readonly bigint[],
  ): Promise<{ campaignId: bigint; amount: number; allocated: number; credited: number; status: string }[]> {
    if (campaignIds.length === 0) return [];
    const rows = await this.txHost.tx.charge.findMany({
      where: { schoolId, studentId, campaignId: { in: distinct(campaignIds) }, kind: 'campaign', status: { not: 'voided' } },
      select: { campaignId: true, amount: true, allocatedAmount: true, creditedAmount: true, status: true },
    });
    return rows.flatMap((r) =>
      r.campaignId === null
        ? []
        : [{ campaignId: r.campaignId, amount: r.amount, allocated: r.allocatedAmount, credited: r.creditedAmount, status: r.status }],
    );
  }

  // ------------------------------------------------------------------------------- helpers

  private async named(schoolId: SchoolId, rows: readonly EventRow[]): Promise<EventRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const sections = await this.txHost.tx.eventSection.findMany({
      where: { schoolId, eventId: { in: ids } },
      select: { eventId: true, sectionId: true, classId: true, section: { select: { name: true } }, class: { select: { name: true } } },
    });
    const years = await this.txHost.tx.academicYear.findMany({
      where: { schoolId, id: { in: distinct(rows.map((r) => r.academicYearId)) } },
      select: { id: true, name: true },
    });
    const yearName = new Map(years.map((y) => [y.id, y.name]));
    const campaignIds = rows.flatMap((r) => (r.campaignId === null ? [] : [r.campaignId]));
    const campaigns =
      campaignIds.length === 0
        ? []
        : await this.txHost.tx.chargeCampaign.findMany({
            where: { schoolId, id: { in: campaignIds } },
            select: { id: true, status: true },
          });
    const campaignStatus = new Map<bigint, string>(campaigns.map((c) => [c.id, c.status]));
    const creators = await userNames(this.txHost.tx, schoolId, rows.map((r) => r.createdBy));
    return rows.map((r) => ({
      ...r,
      academicYearName: yearName.get(r.academicYearId) ?? '',
      campaignStatus: r.campaignId === null ? null : (campaignStatus.get(r.campaignId) ?? null),
      createdByName: creators.get(r.createdBy) ?? '',
      sections: sections
        .filter((s) => s.eventId === r.id)
        .map((s) => ({ sectionId: s.sectionId, sectionName: s.section.name, classId: s.classId, className: s.class.name }))
        .sort((a, b) => a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName)),
    }));
  }
}
