import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, financialStatement } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused, notFound, ownChild } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { pageWindow } from '../../common/report-export';
import { addDays, assertRange, dayStart, SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { FinanceReportRepository, type CollectionWindow } from '../../repositories/finance-report.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { requirePrincipal } from '../access/money-gates';
import { PermissionsService } from '../access/permissions.service';
import { toChargeDto } from '../fees/charges.shared';
import type { ReasonDto } from '../../common/reason.dto';
import { FeeReminders } from './fee-reminders';
import type {
  CollectionsQueryDto,
  CollectionsReportDto,
  ConcessionsQueryDto,
  ConcessionsReportDto,
  DailyCashQueryDto,
  DailyCashReportDto,
  DefaulterDto,
  DefaultersQueryDto,
  DuesClearanceDto,
  ExpensesQueryDto,
  ExpensesReportDto,
  FinancialStatementDto,
  FinancialStatementQueryDto,
  StatementFiguresDto,
  OutstandingQueryDto,
  OutstandingReportDto,
  PayrollMonthDto,
  PayrollQueryDto,
  PayrollReportDto,
  RemindersSentDto,
  SendRemindersDto,
} from './finance-reports.dto';

/** §5 slice 22: report date ranges are at most 92 days; payroll at most 24 months. */
export const REPORT_MAX_DAYS = 92;
export const PAYROLL_MAX_MONTHS = 24;
/** The clearance panel lists at most this many open charges (the total covers all of them). */
const CLEARANCE_CHARGES = 100;

/** Phase 5 R332: a statement's from-to window is at most a year (a longer one is a year's or a term's). */
export const STATEMENT_MAX_DAYS = 366;

const monthIndex = (yearMonth: string): number => Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(5, 7)) - 1;

/** The calendar months `from`..`to` touches (`YYYY-MM-DD`, inclusive), each clipped to the window. */
export function monthsOf(from: string, to: string): { from: string; to: string }[] {
  const months: { from: string; to: string }[] = [];
  for (let index = monthIndex(from.slice(0, 7)); index <= monthIndex(to.slice(0, 7)); index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const last = toDateString(new Date(Date.UTC(year, month, 0)));
    months.push({ from: first < from ? from : first, to: last > to ? to : last });
  }
  return months;
}

/**
 * The finance reports, the manual fee reminder and the dues clearance (phase-3-financial.md slice
 * 22, R201-R205, R228, R250). Every figure is read from the counters the triggers keep; the
 * reports never write. Finance keys are school-wide (rule 0.24): nothing here consults a Scope.
 */
@Injectable()
export class FinanceReportsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly reports: FinanceReportRepository,
    private readonly years: AcademicYearRepository,
    private readonly charges: ChargeRepository,
    private readonly reminders: FeeReminders,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
    private readonly permissions: PermissionsService,
    private readonly settings: SchoolSettingsRepository,
  ) {}

  // ---------------------------------------------------------------------------- defaulters

  /** R203: today's defaulters, from the covering index, a page at a time. */
  async defaulters(query: DefaultersQueryDto): Promise<Page<DefaulterDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.reports.defaulters(schoolId, {
      today: await this.clock.today(schoolId),
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.minOutstanding === undefined ? {} : { minOutstanding: query.minOutstanding }),
      overdueOnly: query.overdueOnly ?? false,
      sort: query.sort ?? '-outstanding',
      // A CSV export reads every row up to one past the cap (R336).
      ...pageWindow(query),
    });
    const extras = new Map(
      (await this.reports.defaulterExtras(schoolId, rows.map((r) => r.studentId))).map((e) => [e.studentId, e]),
    );
    return toPage(
      rows.map((r): DefaulterDto => {
        const extra = extras.get(r.studentId);
        return {
          studentId: r.studentId.toString(),
          studentName: r.studentName,
          admissionNo: r.admissionNo,
          className: r.className,
          sectionName: r.sectionName,
          outstanding: r.outstanding,
          overdue: r.overdue,
          oldestDueOn: toDateString(r.oldestDueOn),
          openCharges: r.openCharges,
          feePayer:
            extra?.feePayerName == null || extra.feePayerCapability === null
              ? null
              : { name: extra.feePayerName, contactCapability: extra.feePayerCapability },
          lastPaymentOn: extra?.lastPaymentOn == null ? null : toDateString(extra.lastPaymentOn),
          lastReminderAt: extra?.lastReminderAt ?? null,
          pendingClaim: extra?.pendingClaim ?? false,
        };
      }),
      query,
      total,
    );
  }

  // --------------------------------------------------------------------------- collections

  /**
   * R205, §0.20: non-voided receipts of the window by the chosen date (received or verified),
   * grouped; refunds, refund reversals, voided receipts and carry-forwards as their own lines.
   */
  async collections(query: CollectionsQueryDto): Promise<CollectionsReportDto> {
    const schoolId = this.context.schoolId;
    const window = await this.window(schoolId, query.receivedFrom, query.receivedTo, query.basis ?? 'verified', {
      field: 'receivedTo',
      from: 'receivedFrom',
    });
    const rows = await this.reports.collections(schoolId, window, query.groupBy);
    const totals = await this.reports.collectionTotals(schoolId, window);
    return {
      basis: window.basis,
      rows,
      total: totals.total.amount,
      count: totals.total.count,
      refunds: totals.refunds,
      refundReversals: totals.refundReversals,
      net: totals.total.amount - totals.refunds.amount + totals.refundReversals.amount,
      voided: totals.voided,
      carriedForward: totals.carriedForward,
      carryForwardReversals: totals.carryForwardReversals,
    };
  }

  // --------------------------------------------------------------------------- outstanding

  async outstanding(query: OutstandingQueryDto): Promise<OutstandingReportDto> {
    const schoolId = this.context.schoolId;
    const yearId = await this.requireYear(schoolId, query.academicYearId);
    const rows = await this.reports.outstanding(schoolId, yearId, query.groupBy ?? 'class');
    return {
      asOf: toDateString(await this.clock.today(schoolId)),
      rows,
      total: rows.reduce((sum, r) => sum + r.amount, 0),
      adjustments: await this.reports.adjustmentsTotal(schoolId, yearId),
    };
  }

  // ---------------------------------------------------------------------------- daily cash

  /** §3.4, §0.20: one day's cash in, where it is, and the day's cash out. */
  async dailyCash(query: DailyCashQueryDto): Promise<DailyCashReportDto> {
    const schoolId = this.context.schoolId;
    const timezone = await this.clock.timezone(schoolId);
    const day = fromDateString(query.date);
    const facts = await this.reports.dailyCash(schoolId, day, dayStart(timezone, day), dayStart(timezone, addDays(day, 1)));
    const names = await this.reports.userNames(schoolId, [
      ...facts.withCollectors.map((c) => c.userId),
      ...facts.handedOver.flatMap((h) => (h.confirmedBy === null ? [h.collectorUserId] : [h.collectorUserId, h.confirmedBy])),
    ]);
    const name = (id: bigint): string => names.get(id) || 'Unknown';
    return {
      date: query.date,
      cashReceived: facts.cashReceived,
      voidedBeforeHandover: facts.voidedBeforeHandover,
      withCollectors: facts.withCollectors.map((c) => ({
        collectorUserId: c.userId.toString(),
        collector: name(c.userId),
        amount: c.amount,
        since: c.since,
      })),
      handedOver: facts.handedOver.map((h) => ({
        handoverId: h.handoverId.toString(),
        status: h.status,
        collector: name(h.collectorUserId),
        confirmedBy: h.confirmedBy === null ? null : name(h.confirmedBy),
        expected: h.expected,
        counted: h.counted,
        shortfall: h.shortfall,
        surplus: h.surplus,
        shortfallResolution: h.shortfallResolution,
        fromDay: h.fromDay,
      })),
      voidedAfterHandover: facts.voidedAfterHandover,
      refundsPaidCash: facts.refundsPaidCash,
      cashExpenses: facts.cashExpenses,
      shortfallWrittenOff: facts.shortfallWrittenOff,
      salariesPaidCash: facts.salariesPaidCash,
    };
  }

  // --------------------------------------------------------------------------- concessions

  async concessions(query: ConcessionsQueryDto): Promise<ConcessionsReportDto> {
    const schoolId = this.context.schoolId;
    const yearId = await this.requireYear(schoolId, query.academicYearId);
    const rows = await this.reports.concessions(schoolId, yearId, query.groupBy ?? 'feeHead');
    return {
      rows: rows.map((r) => ({ key: r.key, label: r.label, students: r.students, reduction: r.amount })),
      total: rows.reduce((sum, r) => sum + r.amount, 0),
    };
  }

  // ------------------------------------------------------------------------------ expenses

  async expenses(query: ExpensesQueryDto): Promise<ExpensesReportDto> {
    const schoolId = this.context.schoolId;
    const from = fromDateString(query.spentFrom);
    const to = fromDateString(query.spentTo);
    assertRange(from, to, REPORT_MAX_DAYS, { field: 'spentTo', from: 'spentFrom' });
    const rows = await this.reports.expenses(schoolId, from, to, query.groupBy ?? 'category');
    const sides = await this.reports.expenseSides(schoolId, from, to);
    return {
      rows,
      total: rows.reduce((sum, r) => sum + r.amount, 0),
      pendingApproval: sides.pending,
      subThresholdByRecorder: sides.subThreshold.map((r) => ({
        recorderUserId: r.userId.toString(),
        recorder: r.name,
        amount: r.amount,
        count: r.count,
      })),
    };
  }

  // ------------------------------------------------------------------------------- payroll

  async payroll(query: PayrollQueryDto): Promise<PayrollReportDto> {
    const span = monthIndex(query.to) - monthIndex(query.from);
    if (span < 0 || span >= PAYROLL_MAX_MONTHS) {
      throw fieldRefused('to', ErrorCode.INVALID_VALUE, `to must be on or after from and at most ${PAYROLL_MAX_MONTHS} months in all`);
    }
    const rows = await this.reports.payroll(this.context.schoolId, query.from, query.to);
    const total: PayrollMonthDto = {
      yearMonth: query.to,
      staffCount: 0,
      gross: 0,
      deductions: 0,
      adjustments: 0,
      net: 0,
      paid: 0,
      unpaid: 0,
    };
    for (const r of rows) {
      total.staffCount += r.staffCount;
      total.gross += r.gross;
      total.deductions += r.deductions;
      total.adjustments += r.adjustments;
      total.net += r.net;
      total.paid += r.paid;
      total.unpaid += r.unpaid;
    }
    return { rows, total };
  }

  // -------------------------------------------------------------------- financial statement

  /**
   * Phase 5 R332 (contracts/slice-42.md §2.1): income against expenditure over one window — from
   * and to (≤ 366 days), a term or an academic year — on the basis asked for or the school's
   * setting, a row per calendar month and the total. Read from the stored money rows; summed by
   * the shared financialStatement(), so every row's lines and net follow one definition.
   */
  async financialStatement(query: FinancialStatementQueryDto): Promise<FinancialStatementDto> {
    const schoolId = this.context.schoolId;
    const forms = [query.from !== undefined || query.to !== undefined, query.termId !== undefined, query.academicYearId !== undefined];
    if (forms.filter(Boolean).length !== 1) {
      throw fieldRefused('from', ErrorCode.INVALID_VALUE, 'Give exactly one of from and to, termId, or academicYearId');
    }
    let from: string;
    let to: string;
    if (query.termId !== undefined) {
      const term = await this.reports.termRange(schoolId, BigInt(query.termId));
      if (!term) throw fieldRefused('termId', ErrorCode.REFERENCE_NOT_FOUND, 'No such term');
      [from, to] = [toDateString(term.startsOn), toDateString(term.endsOn)];
    } else if (query.academicYearId !== undefined) {
      const year = await this.years.findById(schoolId, BigInt(query.academicYearId));
      if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
      [from, to] = [toDateString(year.startsOn), toDateString(year.endsOn)];
    } else {
      if (query.from === undefined) throw fieldRefused('from', ErrorCode.INVALID_VALUE, 'from is required with to');
      if (query.to === undefined) throw fieldRefused('to', ErrorCode.INVALID_VALUE, 'to is required with from');
      assertRange(fromDateString(query.from), fromDateString(query.to), STATEMENT_MAX_DAYS, { field: 'to', from: 'from' });
      [from, to] = [query.from, query.to];
    }
    const basis = query.basis ?? (await this.settings.find(schoolId))?.financialStatementBasis ?? 'received';
    const timezone = await this.clock.timezone(schoolId);
    const fromDay = fromDateString(from);
    const toDay = fromDateString(to);
    const lines = await this.reports.statementLines(schoolId, {
      basis,
      from: fromDay,
      to: toDay,
      startsAt: dayStart(timezone, fromDay),
      endsBefore: dayStart(timezone, addDays(toDay, 1)),
      timezone,
    });
    const figures = (period: string, window: { from: string; to: string }): StatementFiguresDto => ({
      period,
      ...window,
      ...financialStatement(lines, basis, window),
    });
    return {
      basis,
      from,
      to,
      months: monthsOf(from, to).map((m) => figures(m.from.slice(0, 7), m)),
      total: figures('total', { from, to }),
    };
  }

  // ----------------------------------------------------------------------------- reminders

  /**
   * POST /fee-reminders/send (R202: "manual sends obey the same caps"): the families of the target
   * (or every family), one kind, now. The due reminder is once per family per due month and the
   * overdue one at most twice a month and not within the cadence of the last; R107 keeps a retry
   * from sending twice. Audited with the counts.
   */
  @Transactional()
  async sendReminders(dto: SendRemindersDto): Promise<RemindersSentDto> {
    const { schoolId, userId } = this.context.actor();
    const targets = [dto.classId, dto.sectionId, dto.studentIds].filter((t) => t !== undefined).length;
    if (targets > 1) {
      throw fieldRefused('classId', ErrorCode.INVALID_VALUE, 'Send to at most one of classId, sectionId and studentIds');
    }
    const target = {
      ...(dto.classId === undefined ? {} : { classId: BigInt(dto.classId) }),
      ...(dto.sectionId === undefined ? {} : { sectionId: BigInt(dto.sectionId) }),
      ...(dto.studentIds === undefined ? {} : { studentIds: dto.studentIds.map(BigInt) }),
    };
    if (!(await this.reports.targetsExist(schoolId, target))) {
      const field = dto.classId !== undefined ? 'classId' : dto.sectionId !== undefined ? 'sectionId' : 'studentIds';
      throw fieldRefused(field, ErrorCode.REFERENCE_NOT_FOUND, 'No such target in this school');
    }
    const guardianIds =
      targets === 0
        ? undefined
        : await this.reports.feePayerGuardians(
            schoolId,
            target.studentIds ?? (await this.reports.studentsIn(schoolId, target)),
          );
    const now = this.clock.now();
    const budget = await this.reminders.budget(schoolId, now);
    const outcome = await this.reminders.dispatch(schoolId, dto.kind, {
      now,
      mode: 'manual',
      budget,
      ...(guardianIds === undefined ? {} : { guardianIds }),
    });
    await this.reminders.tellPrincipals(schoolId, budget, outcome.capped, now);
    // The subject is the school day (YYYYMMDD), as the principals' reminder_sms_capped notice's.
    const day = toDateString(await this.clock.today(schoolId)).replaceAll('-', '');
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_reminder.sent',
      subjectType: 'fee_reminder',
      subjectId: BigInt(day),
      metadata: {
        kind: dto.kind,
        target: dto.classId !== undefined ? 'class' : dto.sectionId !== undefined ? 'section' : dto.studentIds !== undefined ? 'students' : 'school',
        families: outcome.families,
        smsUnits: outcome.smsUnits,
        cappedFamilies: outcome.capped,
      },
    });
    return outcome;
  }

  // ------------------------------------------------------------------------ dues clearance

  /**
   * R204, A7: the student's open charges across every enrolment and year; cleared when nothing is
   * owed or a principal's override is newer than the newest open charge. Phase 4's certificate
   * issue calls this; a leaving student's status change only warns (rule 20 blocks the
   * certificate, not the status).
   */
  async clearance(studentId: bigint): Promise<DuesClearanceDto> {
    const schoolId = this.context.schoolId;
    if (!(await this.charges.studentExists(schoolId, studentId))) throw notFound();
    return this.clearanceOf(schoolId, studentId);
  }

  /**
   * The override (certificate.issue + principal, R204, R233): no table; the override is the audit
   * row `dues_clearance.overridden` with the outstanding it overrode and the reason. A principal who
   * is a guardian of the student is refused (R232), with no sole-principal exception: the
   * certificate can wait for the dues to be paid.
   */
  @Transactional()
  async override(session: SchoolSessionContext, studentId: bigint, dto: ReasonDto): Promise<DuesClearanceDto> {
    const { schoolId, userId } = this.context.actor();
    if (!(await this.charges.studentExists(schoolId, studentId))) throw notFound();
    requirePrincipal(session);
    if (await this.permissions.actorIsGuardianOf(schoolId, userId, studentId)) throw ownChild();
    const { outstanding } = await this.reports.studentDues(schoolId, studentId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'dues_clearance.overridden',
      subjectType: 'student',
      subjectId: studentId,
      reason: dto.reason,
      metadata: { outstanding },
    });
    return this.clearanceOf(schoolId, studentId);
  }

  private async clearanceOf(schoolId: SchoolId, studentId: bigint): Promise<DuesClearanceDto> {
    const dues = await this.reports.studentDues(schoolId, studentId);
    const open = await this.charges.openOfStudents(schoolId, [studentId], undefined, CLEARANCE_CHARGES);
    const latest = await this.reports.latestOverride(schoolId, studentId);
    // The override stands while no charge has opened since it and the student owes no more than it
    // overrode: a voided payment that reopens an old charge raises the outstanding and lapses it.
    const valid =
      latest !== null &&
      (dues.newestOpenAt === null || latest.createdAt > dues.newestOpenAt) &&
      dues.outstanding <= latest.outstanding
        ? latest
        : null;
    const byName = valid === null ? '' : ((await this.reports.userNames(schoolId, [valid.actorUserId])).get(valid.actorUserId) ?? '');
    return {
      studentId: studentId.toString(),
      outstanding: dues.outstanding,
      openCharges: open.map(toChargeDto),
      advance: await this.reports.studentAdvance(schoolId, studentId),
      cleared: dues.outstanding === 0 || valid !== null,
      override:
        valid === null
          ? null
          : { byUserId: valid.actorUserId.toString(), byName, at: valid.createdAt, reason: valid.reason ?? '' },
    };
  }

  // ---------------------------------------------------------------------------------- reads

  private async requireYear(schoolId: SchoolId, id: string): Promise<bigint> {
    const year = await this.years.findById(schoolId, BigInt(id));
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    return year.id;
  }

  private async window(
    schoolId: SchoolId,
    fromValue: string,
    toValue: string,
    basis: CollectionWindow['basis'],
    names: { field: string; from: string },
  ): Promise<CollectionWindow> {
    const from = fromDateString(fromValue);
    const to = fromDateString(toValue);
    assertRange(from, to, REPORT_MAX_DAYS, names);
    const timezone = await this.clock.timezone(schoolId);
    return { basis, from, to, startsAt: dayStart(timezone, from), endsBefore: dayStart(timezone, addDays(to, 1)), timezone };
  }
}
