import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { tierFor, type BillingSkipReason } from '@asms/shared';
import { failureLog } from '../../../common/errors/failure-log';
import { recoverConstraint } from '../../../common/errors/prisma-errors';
import { addDays, dayStart, todayIn } from '../../../common/school-clock';
import { PlatformAlerts } from '../../../messaging/platform-alerts';
import { InvoiceRepository } from '../../../repositories/platform/invoice.repository';
import { PlanRepository, type PlanRecord } from '../../../repositories/platform/plan.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformSettingsRepository } from '../../../repositories/platform/platform-settings.repository';
import {
  SchoolMetricsRepository,
  type MetricsRecord,
} from '../../../repositories/platform/school-metrics.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { SubscriptionRepository } from '../../../repositories/platform/subscription.repository';
import { fromDateString, PLATFORM_TIMEZONE } from './billing.mappers';

/** A metrics row older than this many days does not price an invoice (A11, R220). */
export const METRICS_MAX_AGE_DAYS = 7;

export interface IssueMonthResult {
  issued: number;
  existing: number;
  skipped: { schoolId: bigint; reason: BillingSkipReason }[];
  /** Schools whose transaction failed for another reason (logged); the next run retries them. */
  failed: number;
}

type SchoolOutcome =
  | { kind: 'issued' }
  | { kind: 'existing' }
  | { kind: 'gone' }
  | { kind: 'skipped'; reason: BillingSkipReason };

/** `INV-<year issued>-<counter, five digits>` (CHECK platform_invoices_invoice_no_check). */
const invoiceNo = (issuedOn: Date, n: number): string =>
  `INV-${issuedOn.getUTCFullYear()}-${String(n).padStart(5, '0')}`;

/** The month a DATE value falls in, `YYYY-MM`. */
const yearMonthOf = (day: Date): string => day.toISOString().slice(0, 7);

/**
 * The platform billing run (phase-3-financial.md §3.7, R220, R221, A11, A12): the monthly invoice
 * per billable school, and the daily overdue and eligibility stamps. Reads only schools,
 * platform_school_metrics, platform_settings, the audit log's trial exit and the billing tables
 * (R222). Used by the scheduled job (src/jobs/platform-billing.ts) and by `POST
 * /platform/invoices/issue-month`.
 */
@Injectable()
export class BillingRunService {
  private readonly logger = new Logger('BillingRun');

  constructor(
    private readonly schools: SchoolRepository,
    private readonly plans: PlanRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly metrics: SchoolMetricsRepository,
    private readonly invoices: InvoiceRepository,
    private readonly settings: PlatformSettingsRepository,
    private readonly audit: PlatformAuditRepository,
    private readonly alerts: PlatformAlerts,
  ) {}

  /**
   * The scheduled body, daily at 04:00 Asia/Karachi: on the 1st it issues the month, then every
   * day it stamps overdue and suspension-eligible invoices. A run that failed on the 1st is not
   * retried on the 2nd: the console's "Issue month" is the catch-up (idempotent).
   */
  async daily(now: Date = new Date()): Promise<{ issue: IssueMonthResult | null; overdue: number; eligible: number }> {
    const today = todayIn(PLATFORM_TIMEZONE, now);
    let issue: IssueMonthResult | null = null;
    if (today.getUTCDate() === 1) {
      issue = await this.issueMonth(yearMonthOf(today), null, now);
      this.logger.log(
        { yearMonth: yearMonthOf(today), issued: issue.issued, existing: issue.existing, skipped: issue.skipped.length, failed: issue.failed },
        'platform billing month issued',
      );
    }
    const stamps = await this.stamp(now);
    return { issue, ...stamps };
  }

  /**
   * R221: an issued invoice is overdue the day after its due date, and eligible for suspension
   * once `graceDays` more have passed. Each stamp is written once; nothing suspends a school.
   */
  async stamp(now: Date = new Date()): Promise<{ overdue: number; eligible: number }> {
    const today = todayIn(PLATFORM_TIMEZONE, now);
    const { graceDays } = await this.settings.get();
    const overdue = await this.invoices.stampOverdue(today, now);
    const eligible = await this.invoices.stampSuspensionEligible(addDays(today, -graceDays), now);
    return { overdue, eligible };
  }

  /**
   * R220: one invoice per billable school (active or suspended) for `yearMonth`, idempotent per
   * school and month. Each school is its own transaction, so one failure never stops the rest.
   * `actorId` null is the scheduled run: it alerts the platform mailbox about skipped schools and
   * writes no audit row (platform_audit_log_actor_check admits no actorless row; the invoice
   * itself is the record). A hand run audits each invoice it issues.
   */
  async issueMonth(yearMonth: string, actorId: bigint | null, now: Date = new Date()): Promise<IssueMonthResult> {
    const today = todayIn(PLATFORM_TIMEZONE, now);
    const counts = await this.metrics.latestInWindow(addDays(today, -METRICS_MAX_AGE_DAYS), today);
    const activePlans = await this.plans.listActive();
    const result: IssueMonthResult = { issued: 0, existing: 0, skipped: [], failed: 0 };
    const alert: { schoolId: bigint; schoolName: string; reason: 'no_metrics' | 'no_band' }[] = [];
    for (const school of await this.schools.listBillable()) {
      const metrics = counts.get(school.id);
      let outcome: SchoolOutcome;
      if (metrics === undefined) {
        outcome = { kind: 'skipped', reason: 'no_metrics' };
      } else {
        try {
          outcome = await recoverConstraint(
            'platform_invoices_month_key',
            () => this.issueForSchool(school.id, yearMonth, metrics, activePlans, actorId, now),
            // A concurrent run issued it first.
            () => Promise.resolve<SchoolOutcome>({ kind: 'existing' }),
          );
        } catch (error) {
          this.logger.error({ ...failureLog(error), schoolId: school.id.toString(), yearMonth }, 'platform invoice not issued');
          result.failed++;
          continue;
        }
      }
      switch (outcome.kind) {
        case 'issued':
          result.issued++;
          break;
        case 'existing':
          result.existing++;
          break;
        case 'gone':
          break;
        case 'skipped':
          result.skipped.push({ schoolId: school.id, reason: outcome.reason });
          if (outcome.reason === 'no_metrics' || outcome.reason === 'no_band') {
            alert.push({ schoolId: school.id, schoolName: school.name, reason: outcome.reason });
          }
      }
    }
    if (actorId === null) {
      // The actionable reason first: a missing band is the platform's to fix by adding a plan.
      const byReason = (reason: 'no_band' | 'no_metrics') => alert.filter((s) => s.reason === reason);
      await this.alerts.billingTierMissing({ yearMonth, skipped: [...byReason('no_band'), ...byReason('no_metrics')] });
    }
    return result;
  }

  /**
   * One school's month, in one transaction. Lock order: school, plan, subscription, invoice
   * counter (last, so the counter's row lock is held for the shortest time).
   */
  @Transactional()
  private async issueForSchool(
    schoolId: bigint,
    yearMonth: string,
    metrics: MetricsRecord,
    activePlans: readonly PlanRecord[],
    actorId: bigint | null,
    now: Date,
  ): Promise<SchoolOutcome> {
    const school = await this.schools.lock(schoolId);
    if (!school || (school.status !== 'active' && school.status !== 'suspended')) return { kind: 'gone' };
    if (await this.invoices.findLiveForMonth(schoolId, yearMonth)) return { kind: 'existing' };
    const firstDay = fromDateString(`${yearMonth}-01`);
    // A school turning active mid-month is free until the next 1st (R220).
    if (await this.audit.leftTrialSince(schoolId, dayStart(PLATFORM_TIMEZONE, firstDay))) {
      return { kind: 'skipped', reason: 'trial' };
    }

    const live = await this.subscriptions.findLive(schoolId);
    // A12: the pinned plan, else the band holding the month's count. A pin bills a month only when
    // it started on or before that month's 1st; a pin starting later bills from its first full
    // month, and until then the month is priced by the count.
    const pinApplies = live !== null && live.pinned && live.startedOn <= firstDay;
    const planId = pinApplies ? live.planId : tierFor(metrics.activeStudents, activePlans)?.id;
    const plan = planId === undefined ? null : await this.plans.lock(planId);
    if (!plan || plan.status !== 'active') return { kind: 'skipped', reason: 'no_band' };

    // The history of the school's tiers: continue the live row when the tier is unchanged, else
    // end it and start the new tier on the 1st. A hand run for an earlier month leaves a later
    // tier alone.
    if (!live?.pinned && (live === null || (live.planId !== plan.id && live.startedOn <= firstDay))) {
      if (live) {
        const dayBefore = addDays(firstDay, -1);
        await this.subscriptions.end(live.id, live.startedOn > dayBefore ? live.startedOn : dayBefore);
      }
      await this.subscriptions.create({
        schoolId,
        planId: plan.id,
        startedOn: firstDay,
        pinned: false,
        assignedBy: null,
        reason: null,
      });
    }

    // A12: the plan's allowance becomes the cap only while the cap is not overridden.
    if (!school.smsCapOverridden && school.smsMonthlyCap !== plan.smsAllowance) {
      await this.schools.setSmsCap(schoolId, plan.smsAllowance, false);
    }

    const { invoiceDueDay } = await this.settings.get();
    const today = todayIn(PLATFORM_TIMEZONE, now);
    const invoice = await this.invoices.create({
      schoolId,
      invoiceNo: invoiceNo(today, await this.invoices.nextNumber()),
      yearMonth,
      planId: plan.id,
      studentCount: metrics.activeStudents,
      amount: plan.monthlyPrice,
      dueOn: fromDateString(`${yearMonth}-${String(invoiceDueDay).padStart(2, '0')}`),
      // A free plan's invoice is issued paid: there is nothing to record against it.
      paidAt: plan.monthlyPrice === 0 ? now : null,
    });
    if (actorId !== null) {
      await this.audit.record({
        actorPlatformUserId: actorId,
        schoolId,
        action: 'platform_invoice.issued',
        subjectType: 'platform_invoice',
        subjectId: invoice.id,
        metadata: {
          invoiceNo: invoice.invoiceNo,
          yearMonth,
          planId: plan.id.toString(),
          studentCount: metrics.activeStudents,
          amount: invoice.amount,
        },
      });
    }
    return { kind: 'issued' };
  }
}
