import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, type DutyKind } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EventRepository, type EventRecord, type RosterRow } from '../../repositories/event.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString } from '../academics/academics.shared';
import type { PaymentDto } from '../payments/payments.dto';
import { PaymentsService } from '../payments/payments.service';
import { onceMore } from '../payments/payments.shared';
import type {
  CreateEventPaymentDto,
  EventReportDto,
  EventRosterDto,
  EventRosterQueryDto,
  EventRosterRowDto,
  MyEventDto,
  RecordEventParticipationDto,
} from './events.dto';
import { eventDay, eventNotPublished } from './events.service';

// Phase 5 slice 38 (contracts/slice-38.md §2.6-§2.8, §2.10; rule 32, R311, R312, R314, R315,
// R317): what happens at an event — the roster and its participation, the collection duty's
// payments — its report, and the family's list. The duty scope is checked here: a duty holder
// reaches only their own event, a class teacher only their sections' rows; anyone else 404.

const PAYMENT_ENDPOINT = 'event_payments';
const PAYMENT_SUBJECT = 'payment';
const PARTICIPATION_SUBJECT = 'event';

/** Who the caller is at this event (rule 32: from duty and assignment data, never a checkbox). */
interface EventAccess {
  event: EventRecord;
  holder: boolean;
  /** The caller's live duties on the event. */
  duties: DutyKind[];
  /** The event sections the caller is class teacher or cover of on the event date. */
  classSections: bigint[];
}

const owed = (c: { amount: number; allocated: number; credited: number; status: string }): number =>
  c.status === 'open' ? Math.max(0, c.amount - c.allocated - c.credited) : 0;

/**
 * Security L2 (fix round): a child's event dues are shown only to who collects or manages them — a
 * live collection duty on this event, an events holder (holiday.manage) or a payment.record holder.
 * A registration or supervision officer and a class teacher see the roster without the money.
 */
function seesDues(session: SchoolSessionContext, a: EventAccess): boolean {
  return a.holder || a.duties.includes('collection') || session.access.capabilities.has(Capability.PAYMENT_RECORD);
}

function toRosterRowDto(r: RosterRow, dues: boolean): EventRosterRowDto {
  return {
    studentId: r.studentId.toString(),
    enrolmentId: r.enrolmentId.toString(),
    fullName: r.fullName,
    admissionNo: r.admissionNo,
    rollNo: r.rollNo,
    sectionId: r.sectionId.toString(),
    sectionName: r.sectionName,
    className: r.className,
    participation: r.participation,
    recordedAt: r.recordedAt,
    charge:
      r.charge === null || !dues
        ? null
        : { chargeId: r.charge.chargeId.toString(), amount: r.charge.amount, outstanding: owed(r.charge), status: r.charge.status },
  };
}

@Injectable()
export class EventActivityService {
  constructor(
    private readonly context: SchoolContext,
    private readonly events: EventRepository,
    private readonly payments: PaymentsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------- participation

  /** §2.6: the roster in the caller's scope; a draft's roster is the holders' alone. */
  async roster(session: SchoolSessionContext, eventId: bigint, query: EventRosterQueryDto): Promise<EventRosterDto> {
    const schoolId = this.context.schoolId;
    const access = await this.access(session, eventId);
    const scope = this.readScope(access);
    const rows = await this.rosterOf(schoolId, access, scope, query.sectionId);
    const dues = seesDues(session, access);
    return { eventId: eventId.toString(), status: access.event.status, rows: rows.map((r) => toRosterRowDto(r, dues)) };
  }

  /** §2.6, R312: duty holders and the sections' class teachers record; published only. */
  @Transactional()
  async record(session: SchoolSessionContext, eventId: bigint, dto: RecordEventParticipationDto): Promise<EventRosterDto> {
    const { schoolId, userId } = this.context.actor();
    const locked = await this.events.lockForShare(schoolId, eventId);
    if (!locked) throw notFound();
    const access = await this.access(session, eventId);
    const scope = this.writeScope(access);
    if (access.event.status !== 'published') throw eventNotPublished(eventId);
    const roster = await this.rosterOf(schoolId, access, scope, undefined);
    const byStudent = new Map(roster.map((r) => [r.studentId, r]));
    const seen = new Set<bigint>();
    const rows = dto.rows.map((row, index) => {
      const studentId = BigInt(row.studentId);
      if (seen.has(studentId)) throw fieldRefused(`rows[${index}].studentId`, ErrorCode.INVALID_VALUE, 'This student is named twice');
      seen.add(studentId);
      const member = byStudent.get(studentId);
      if (!member) throw fieldRefused(`rows[${index}].studentId`, ErrorCode.REFERENCE_NOT_FOUND, 'Not on this event roster');
      return { studentId, enrolmentId: member.enrolmentId, status: row.status };
    });
    const changed = await this.events.recordParticipation(
      schoolId,
      { id: eventId, academicYearId: access.event.academicYearId },
      rows,
      userId,
      new Date(),
    );
    if (changed > 0) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'event_participation.recorded',
        subjectType: PARTICIPATION_SUBJECT,
        subjectId: eventId,
        metadata: { rows: rows.length, changed },
      });
    }
    const after = await this.rosterOf(schoolId, access, scope, undefined);
    const dues = seesDues(session, access);
    return { eventId: eventId.toString(), status: access.event.status, rows: after.map((r) => toRosterRowDto(r, dues)) };
  }

  // -------------------------------------------------------------------------------- payments

  /**
   * §2.7, R317: keyed (endpoint event_payments, path id the student). A live collection duty on
   * this event or payment.record; the event published with a campaign; the money through
   * PaymentsService.recordForEvent.
   */
  async recordPayment(
    session: SchoolSessionContext,
    eventId: bigint,
    dto: CreateEventPaymentDto,
    rawKey: string | undefined,
  ): Promise<{ replayed: boolean; payment: PaymentDto }> {
    const actor = this.context.actor();
    const studentId = BigInt(dto.studentId);
    const outcome = await this.idempotency.withIdempotencyKey(
      actor,
      PAYMENT_ENDPOINT,
      studentId,
      { eventId: eventId.toString(), ...dto },
      rawKey,
      (claim) => onceMore(() => this.recordPaymentInTransaction(session, actor, eventId, dto, claim)),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, payment: await this.payments.get(id) };
  }

  @Transactional()
  private async recordPaymentInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    eventId: bigint,
    dto: CreateEventPaymentDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, PAYMENT_ENDPOINT, claim, PAYMENT_SUBJECT);
    // The event first (FOR SHARE): a cancel or completion waits for this payment, then sees it.
    const locked = await this.events.lockForShare(schoolId, eventId);
    if (!locked) throw notFound();
    const recorder = session.access.capabilities.has(Capability.PAYMENT_RECORD);
    const staffId = session.access.staffId;
    const collector = staffId !== null && (await this.events.liveDutyKinds(schoolId, eventId, staffId)).includes('collection');
    if (!recorder && !collector) throw notFound();
    if (locked.status !== 'published') throw eventNotPublished(eventId);
    if (locked.campaignId === null) {
      throw new ApiException(409, ErrorCode.EVENT_NO_CHARGE, 'This event has no charge to collect.', { eventId: eventId.toString() });
    }
    const studentId = BigInt(dto.studentId);
    const payment = await this.payments.recordForEvent(actor, {
      eventId,
      campaignId: locked.campaignId,
      studentId,
      amount: dto.amount,
      receivedOn: fromDateString(dto.receivedOn),
      reference: dto.reference ?? null,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event_payment.recorded',
      subjectType: PAYMENT_SUBJECT,
      subjectId: payment.id,
      metadata: { eventId: eventId.toString(), studentId: dto.studentId, amount: dto.amount, collector },
    });
    await recordSubject(payment.id);
    return payment.id;
  }

  /** §1: payment.record reads every payment of the event; a collector (live or ended) their own. */
  async listPayments(session: SchoolSessionContext, eventId: bigint, query: PageQueryDto): Promise<Page<PaymentDto>> {
    const schoolId = this.context.schoolId;
    const event = await this.events.findById(schoolId, eventId);
    if (!event) throw notFound();
    const recorder = session.access.capabilities.has(Capability.PAYMENT_RECORD);
    const staffId = session.access.staffId;
    if (!recorder && (staffId === null || event.status === 'draft' || !(await this.events.everCollected(schoolId, eventId, staffId)))) {
      throw notFound();
    }
    if (event.campaignId === null) return toPage([], query, 0);
    return this.payments.list({
      page: query.page,
      limit: query.limit,
      eventId: eventId.toString(),
      ...(recorder ? {} : { recordedByUserId: session.access.userId.toString() }),
    });
  }

  // ---------------------------------------------------------------------------------- report

  /** §2.8, R314: live, not a snapshot; published or completed. */
  async report(eventId: bigint): Promise<EventReportDto> {
    const schoolId = this.context.schoolId;
    const event = await this.events.findById(schoolId, eventId);
    if (!event) throw notFound();
    if (event.status !== 'published' && event.status !== 'completed') throw eventNotPublished(eventId);
    const timezone = await this.clock.timezone(schoolId);
    const roster = await this.events.roster(
      schoolId,
      { id: event.id, academicYearId: event.academicYearId, campaignId: event.campaignId, sectionIds: event.sections.map((s) => s.sectionId) },
      eventDay(event.startsAt, timezone),
      null,
    );
    const count = (status: string | null) => roster.filter((r) => r.participation === status).length;
    const totals =
      event.campaignId === null
        ? { chargeCount: 0, charged: 0, credited: 0, collected: 0 }
        : await this.events.campaignTotals(schoolId, event.campaignId);
    const expenses = await this.events.expenseTotals(schoolId, eventId);
    return {
      eventId: eventId.toString(),
      title: event.title,
      status: event.status,
      participants: {
        roster: roster.length,
        attended: count('attended'),
        absent: count('absent'),
        excused: count('excused'),
        unrecorded: count(null),
      },
      collections: {
        chargeCount: totals.chargeCount,
        charged: totals.charged,
        collected: totals.collected,
        outstanding: Math.max(0, totals.charged - totals.collected - totals.credited),
      },
      expenses,
      net: totals.collected - expenses.total,
    };
  }

  // ---------------------------------------------------------------------------------- family

  /** §2.10, R315: a child's (or the student's own) published and completed events. */
  async family(session: SchoolSessionContext, studentId: bigint | null, query: PageQueryDto): Promise<Page<MyEventDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const id = studentId ?? (scope.kind === 'students' ? scope.ids[0] : undefined);
    if (id === undefined || scope.kind !== 'students' || !scope.ids.includes(id)) throw notFound();
    const timezone = await this.clock.timezone(schoolId);
    const { rows, total } = await this.events.familyEvents(schoolId, scope, id, timezone, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const charges = await this.events.childCharges(
      schoolId,
      id,
      rows.flatMap((r) => (r.campaignId === null ? [] : [r.campaignId])),
    );
    return toPage(
      rows.map((r) => {
        const c = charges.find((x) => x.campaignId === r.campaignId);
        return {
          id: r.id.toString(),
          type: r.type,
          title: r.title,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          venue: r.venue,
          details: r.details,
          status: r.status,
          charge: c === undefined ? null : { amount: c.amount, outstanding: owed(c), status: c.status },
        };
      }),
      query,
      total,
    );
  }

  // -------------------------------------------------------------------------------- helpers

  /** The event and the caller's standing at it; a draft only for holders (404 otherwise). */
  private async access(session: SchoolSessionContext, eventId: bigint): Promise<EventAccess> {
    const schoolId = this.context.schoolId;
    const event = await this.events.findById(schoolId, eventId);
    const holder = session.access.capabilities.has(Capability.HOLIDAY_MANAGE);
    if (!event || (event.status === 'draft' && !holder)) throw notFound();
    const staffId = session.access.staffId;
    if (staffId === null) return { event, holder, duties: [], classSections: [] };
    const duties = await this.events.liveDutyKinds(schoolId, eventId, staffId);
    const classSections = await this.events.classTeacherSections(
      schoolId,
      staffId,
      event.sections.map((s) => s.sectionId),
      eventDay(event.startsAt, await this.clock.timezone(schoolId)),
    );
    return { event, holder, duties, classSections };
  }

  /** Read: the whole roster for a holder or a duty holder; a class teacher's sections; else 404. */
  private readScope(a: EventAccess): bigint[] | null {
    if (a.holder || a.duties.length > 0) return null;
    if (a.classSections.length > 0) return a.classSections;
    throw notFound();
  }

  /** Write: a duty holder (whole roster) or a class teacher (their sections); a holder alone may not. */
  private writeScope(a: EventAccess): bigint[] | null {
    if (a.duties.length > 0) return null;
    if (a.classSections.length > 0) return a.classSections;
    if (a.holder) throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only a duty holder or the class teacher records participation.');
    throw notFound();
  }

  private async rosterOf(
    schoolId: SchoolId,
    a: EventAccess,
    scope: bigint[] | null,
    sectionId: string | undefined,
  ): Promise<RosterRow[]> {
    let sections = scope;
    if (sectionId !== undefined) {
      const id = BigInt(sectionId);
      if (!a.event.sections.some((s) => s.sectionId === id)) {
        throw fieldRefused('sectionId', ErrorCode.REFERENCE_NOT_FOUND, 'Not a section of this event');
      }
      if (scope !== null && !scope.includes(id)) throw notFound();
      sections = [id];
    }
    return this.events.roster(
      schoolId,
      {
        id: a.event.id,
        academicYearId: a.event.academicYearId,
        campaignId: a.event.campaignId,
        sectionIds: a.event.sections.map((s) => s.sectionId),
      },
      eventDay(a.event.startsAt, await this.clock.timezone(schoolId)),
      sections,
    );
  }
}
