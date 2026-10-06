import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import type { MessageType } from '@asms/shared';
import { addDays, daysBetween, todayIn, yearMonthIn } from '../../common/school-clock';
import { NotificationService, type PlannedSend } from '../../messaging/notification.service';
import { isAfterFailureSms, type ChannelPlan } from '../../messaging/routing';
import { smsSegments, smsTextOf } from '../../messaging/templates';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { FinanceReportRepository, type ReminderLinkRow } from '../../repositories/finance-report.repository';
import { MessageRecipientRepository } from '../../repositories/message-recipient.repository';
import { MessageUsageRepository } from '../../repositories/message-usage.repository';
import { SchoolMessagingRepository } from '../../repositories/school-messaging.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { AfterCommitPrismaAdapter } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { chargeGrace } from '../fees/charges.shared';

// Slice 22 (phase-3-financial.md §1.1 "Reminder cadence", §3.6, §3.7, R201, R202, R250;
// contracts/slice-22.md §3). Reminders are messages and nothing else: the subject is
// (`fee_reminder`, YYYYMM*10 + n), n = 0 for the month's due reminder and 1-2 for its overdue
// reminders, so messages_subject_guardian_key (R107) makes "once per family per due month" and "at
// most two overdue reminders per family per month" database facts. No table of its own.

/** The §3.8 defaults, for a school without a settings row. */
const DEFAULT_DAYS_BEFORE = 3;
const DEFAULT_EVERY_DAYS = 14;
/** At most two overdue reminders per family per month (§1.1). */
export const OVERDUE_PER_MONTH = 2;
/** 2,000 families are well inside it (§7.2: 20 s); the request limit is 15 s. */
export const REMINDER_JOB_TIMEOUT_MS = 60_000;

export type ReminderKind = 'due' | 'overdue';

/** What one dispatch did (POST /fee-reminders/send answers it). */
export interface ReminderOutcome {
  /** Families reminded now (one message each). */
  families: number;
  /** SMS units the always-SMS legs will spend (after-failure legs are not counted, §4.5 of slice 14). */
  smsUnits: number;
  /** Of those reminders, how many have a WhatsApp, SMS or push leg queued. */
  enqueued: number;
  /** Families whose SMS legs were dropped because the month's allowance would be exceeded (R250). */
  capped: number;
}

interface Family {
  guardianId: bigint;
  children: ReminderLinkRow[];
  outstanding: number;
  overdue: number;
  oldestOverdue: Date | null;
  nextDue: Date | null;
  pendingClaims: number;
}

/** One reminder about to be written: the family, its subject id and its template variables. */
interface Planned {
  family: Family;
  subjectId: bigint;
  type: 'fee_due_reminder' | 'fee_overdue';
  vars: { total: number; children: string[]; dueOn: Date } | { overdue: number; children: string[]; since: Date };
}

/** The SMS units the month has left, spent family by family in order (R250). */
export interface SmsBudget {
  remaining: number;
  /** What was left when the run started: 0 means the allowance was already used up (no notice). */
  readonly initial: number;
}

const ym = (day: Date): number => day.getUTCFullYear() * 100 + day.getUTCMonth() + 1;
const subjectOf = (yearMonth: number, n: number): bigint => BigInt(yearMonth * 10 + n);
const previousYm = (yearMonth: number): number =>
  yearMonth % 100 === 1 ? (Math.floor(yearMonth / 100) - 1) * 100 + 12 : yearMonth - 1;

/** Families ordered oldest-overdue first (R202), then by the nearest due date, then by id. */
function familiesOf(links: readonly ReminderLinkRow[]): Family[] {
  const byGuardian = new Map<bigint, Family>();
  for (const link of links) {
    const family = byGuardian.get(link.guardianId) ?? {
      guardianId: link.guardianId,
      children: [],
      outstanding: 0,
      overdue: 0,
      oldestOverdue: null,
      nextDue: null,
      pendingClaims: 0,
    };
    family.children.push(link);
    family.outstanding += link.outstanding;
    family.overdue += link.overdue;
    family.pendingClaims += link.pendingClaims;
    if (link.oldestOverdue !== null && (family.oldestOverdue === null || link.oldestOverdue < family.oldestOverdue)) {
      family.oldestOverdue = link.oldestOverdue;
    }
    if (link.nextDue !== null && (family.nextDue === null || link.nextDue < family.nextDue)) family.nextDue = link.nextDue;
    byGuardian.set(link.guardianId, family);
  }
  const time = (d: Date | null): number => (d === null ? Number.POSITIVE_INFINITY : d.getTime());
  return [...byGuardian.values()].sort(
    (a, b) =>
      time(a.oldestOverdue) - time(b.oldestOverdue) ||
      time(a.nextDue) - time(b.nextDue) ||
      (a.guardianId < b.guardianId ? -1 : a.guardianId > b.guardianId ? 1 : 0),
  );
}

/**
 * Narrows each plan in order to what the month's SMS allowance can carry (R250): an always-SMS leg
 * spends one unit while units remain (every reminder body is one segment, R110); once none remain,
 * the family's SMS legs (the after-failure one too) are dropped and it goes by WhatsApp or push
 * only, or is suppressed `cap_reached` when nothing else reaches it. Returns the units spent and
 * how many families lost an SMS leg.
 */
export function fitSmsBudget(planned: PlannedSend, budget: Pick<SmsBudget, 'remaining'>): { units: number; capped: number } {
  let units = 0;
  let capped = 0;
  planned.plans.forEach((plan, i) => {
    const smsAt = plan.legs.flatMap((leg, at) => (leg === 'sms' ? [at] : []));
    if (smsAt.length === 0) return;
    const always = smsAt.some((at) => !isAfterFailureSms(planned.priority, plan.legs, at));
    if (budget.remaining > 0) {
      if (always) {
        budget.remaining -= 1;
        units += 1;
      }
      return;
    }
    capped += 1;
    const legs = plan.legs.filter((leg) => leg !== 'sms');
    const narrowed: ChannelPlan = {
      legs,
      suppressed: legs.some((leg) => leg !== 'in_app') ? [] : [{ channel: 'sms', reason: 'cap_reached' }],
    };
    planned.plans[i] = narrowed;
  });
  return { units, capped };
}

/**
 * The fee reminders (R201, R202, R250): the daily job's body and POST /fee-reminders/send's. One
 * scan of the open charges grouped by fee-paying guardian; the families ordered oldest-overdue
 * first, so when the SMS allowance runs out it is the newest debts that lose the SMS leg.
 */
@Injectable()
export class FeeReminders {
  constructor(
    private readonly reports: FinanceReportRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly school: SchoolMessagingRepository,
    private readonly usage: MessageUsageRepository,
    private readonly notifications: NotificationService,
    private readonly people: MessageRecipientRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * `fee-reminder` (§3.7, daily 09:00 school time), inside QueueTenancy.runAsSchool: the overdue
   * reminders, then the due ones, on one SMS budget, so the oldest debts keep the SMS leg (R202,
   * R250); the principals hear once if it ran out during the run.
   * Audited as the system actor when it reminded anyone (A19).
   */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: REMINDER_JOB_TIMEOUT_MS })
  async daily(schoolId: SchoolId, now: Date = new Date()): Promise<{ due: ReminderOutcome; overdue: ReminderOutcome }> {
    const budget = await this.budget(schoolId, now);
    const overdue = await this.dispatch(schoolId, 'overdue', { now, mode: 'scheduled', budget });
    const due = await this.dispatch(schoolId, 'due', { now, mode: 'scheduled', budget });
    await this.tellPrincipals(schoolId, budget, due.capped + overdue.capped, now);
    if (due.families + overdue.families > 0) {
      await this.audit.recordSystem(schoolId, {
        action: 'fee_reminder.scheduled_sent',
        subjectType: 'fee_reminder',
        subjectId: null,
        metadata: {
          job: 'fee-reminder',
          dueFamilies: due.families,
          overdueFamilies: overdue.families,
          smsUnits: due.smsUnits + overdue.smsUnits,
          cappedFamilies: due.capped + overdue.capped,
        },
      });
    }
    return { due, overdue };
  }

  /**
   * The month's SMS units left for the reminders of this run: the cap less what message_usage has
   * reserved and less the always-SMS legs of messages still queued (written, not yet attempted),
   * which reserve when the worker reaches them. Advisory: two concurrent runs can read the same
   * figure; the processor's reserveSms is what holds the cap.
   */
  async budget(schoolId: SchoolId, now: Date): Promise<SmsBudget> {
    const settings = await this.messaging(schoolId);
    const used = await this.usage.smsUsed(schoolId, yearMonthIn(settings.timezone, now));
    const pending = (await this.reports.pendingSmsMessages(schoolId)).reduce((units, row) => {
      const at = row.channelPlan.indexOf('sms');
      if (at < 0 || isAfterFailureSms(row.priority, row.channelPlan, at)) return units;
      return units + smsSegments(smsTextOf(row.body, row.hasMedia)) * row.count;
    }, 0);
    const remaining = Math.max(settings.smsMonthlyCap - used - pending, 0);
    return { remaining, initial: remaining };
  }

  /**
   * `reminder_sms_capped` to every active principal, once per school day (R250), when the allowance
   * ran out during this run. When it was already used up before the run started (a cap of 0
   * included) the principals are not told again.
   */
  async tellPrincipals(schoolId: SchoolId, budget: SmsBudget, cappedFamilies: number, now: Date): Promise<void> {
    if (cappedFamilies === 0 || budget.initial === 0) return;
    const principals = await this.people.activePrincipalStaffIds(schoolId);
    if (principals.length === 0) return;
    const today = todayIn((await this.messaging(schoolId)).timezone, now);
    const dayKey = BigInt(today.toISOString().slice(0, 10).replaceAll('-', ''));
    await this.notifications.send(schoolId, {
      type: 'reminder_sms_capped',
      subject: { type: 'fee_reminder', id: dayKey },
      recipients: principals.map((staffId) => ({ staffId })),
      vars: { families: cappedFamilies },
    });
  }

  /**
   * One kind of reminder for the school, or for the families of `guardianIds` (a manual send).
   * Runs in the caller's transaction. A scheduled due reminder goes `feeReminderDaysBefore` days
   * ahead of the due date; a scheduled overdue one once the oldest charge is past due + grace, and
   * again every `overdueReminderEveryDays` days, at most twice a month. A manual send skips the
   * timing (any upcoming due date; anything past due) and keeps every cap.
   */
  async dispatch(
    schoolId: SchoolId,
    kind: ReminderKind,
    opts: { now: Date; mode: 'scheduled' | 'manual'; budget: SmsBudget; guardianIds?: readonly bigint[] },
  ): Promise<ReminderOutcome> {
    const timezone = (await this.messaging(schoolId)).timezone;
    const today = todayIn(timezone, opts.now);
    const settings = await this.settings.find(schoolId);
    const daysBefore = settings?.feeReminderDaysBefore ?? DEFAULT_DAYS_BEFORE;
    const every = settings?.overdueReminderEveryDays ?? DEFAULT_EVERY_DAYS;
    const grace = settings === null ? 7 : chargeGrace(settings);

    const links = await this.reports.reminderLinks(schoolId, today, opts.guardianIds);
    // R201: a family whose pending claims cover what it owes is waiting for verification.
    const families = familiesOf(links).filter((f) => f.pendingClaims < f.outstanding);
    const thisMonth = ym(today);
    // The due subjects already written: one per distinct due month of these families (a manual
    // send may remind of any upcoming month, not only this one and the next).
    const subjects =
      kind === 'due'
        ? [...new Set(families.flatMap((f) => (f.nextDue === null ? [] : [ym(f.nextDue)])))].map((m) => subjectOf(m, 0))
        : [1, 2].flatMap((n) => [subjectOf(thisMonth, n), subjectOf(previousYm(thisMonth), n)]);
    const sent = await this.reports.reminderMessages(schoolId, subjects);
    const sentBy = new Map<bigint, { subjectId: bigint; createdAt: Date }[]>();
    for (const row of sent) {
      if (row.type !== (kind === 'due' ? 'fee_due_reminder' : 'fee_overdue')) continue;
      sentBy.set(row.guardianId, [...(sentBy.get(row.guardianId) ?? []), row]);
    }

    const planned: Planned[] = [];
    for (const family of families) {
      const already = sentBy.get(family.guardianId) ?? [];
      if (kind === 'due') {
        const dueOn = family.nextDue;
        if (dueOn === null) continue;
        if (opts.mode === 'scheduled' && daysBetween(today, dueOn) > daysBefore) continue;
        const subjectId = subjectOf(ym(dueOn), 0);
        if (already.some((m) => m.subjectId === subjectId)) continue;
        const owing = family.children.filter((c) => c.outstanding > 0);
        planned.push({
          family,
          subjectId,
          type: 'fee_due_reminder',
          vars: { total: family.outstanding, children: owing.map((c) => c.studentName), dueOn },
        });
      } else {
        const since = family.oldestOverdue;
        if (since === null || family.overdue <= 0) continue;
        if (opts.mode === 'scheduled' && addDays(since, grace) > today) continue;
        const thisMonthSent = already.filter((m) => Number(m.subjectId / 10n) === thisMonth).length;
        if (thisMonthSent >= OVERDUE_PER_MONTH) continue;
        const last = already.reduce<Date | null>((latest, m) => (latest === null || m.createdAt > latest ? m.createdAt : latest), null);
        if (last !== null && daysBetween(todayIn(timezone, last), today) < every) continue;
        const owing = family.children.filter((c) => c.overdue > 0);
        planned.push({
          family,
          subjectId: subjectOf(thisMonth, thisMonthSent + 1),
          type: 'fee_overdue',
          vars: { overdue: family.overdue, children: owing.map((c) => c.studentName), since },
        });
      }
    }
    if (planned.length === 0) return { families: 0, smsUnits: 0, enqueued: 0, capped: 0 };

    const type: MessageType = kind === 'due' ? 'fee_due_reminder' : 'fee_overdue';
    const plan = await this.notifications.plan(schoolId, {
      type,
      recipients: planned.map((p) => ({ guardianId: p.family.guardianId })),
    });
    const { units, capped } = fitSmsBudget(plan, opts.budget);
    const enqueued = plan.plans.filter((p) => p.legs.some((leg) => leg !== 'in_app')).length;

    // One write per subject (the due month, or the overdue reminder's n), each with its slice of
    // the plan computed above in family order.
    const bySubject = new Map<bigint, number[]>();
    planned.forEach((p, i) => bySubject.set(p.subjectId, [...(bySubject.get(p.subjectId) ?? []), i]));
    let reminded = 0;
    for (const [subjectId, indices] of bySubject) {
      const part: PlannedSend = {
        ...plan,
        people: indices.map((i) => plan.people[i]).filter((p) => p !== undefined),
        plans: indices.map((i) => plan.plans[i]).filter((p) => p !== undefined),
      };
      const result =
        type === 'fee_due_reminder'
          ? await this.notifications.sendEach(schoolId, {
              type: 'fee_due_reminder',
              subject: { type: 'fee_reminder', id: subjectId },
              planned: part,
              items: indices.flatMap((i) => {
                const p = planned[i];
                return p !== undefined && 'dueOn' in p.vars ? [{ recipient: { guardianId: p.family.guardianId }, vars: p.vars }] : [];
              }),
            })
          : await this.notifications.sendEach(schoolId, {
              type: 'fee_overdue',
              subject: { type: 'fee_reminder', id: subjectId },
              planned: part,
              items: indices.flatMap((i) => {
                const p = planned[i];
                return p !== undefined && 'since' in p.vars ? [{ recipient: { guardianId: p.family.guardianId }, vars: p.vars }] : [];
              }),
            });
      reminded += result.created;
    }
    return { families: reminded, smsUnits: units, enqueued, capped };
  }

  private async messaging(schoolId: SchoolId) {
    const settings = await this.school.find(schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    return settings;
  }
}
