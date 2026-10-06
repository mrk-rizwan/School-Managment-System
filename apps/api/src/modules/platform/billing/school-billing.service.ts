import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, tierFor } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { addDays, todayIn } from '../../../common/school-clock';
import { InvoiceRepository } from '../../../repositories/platform/invoice.repository';
import { PlanRepository } from '../../../repositories/platform/plan.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolMetricsRepository } from '../../../repositories/platform/school-metrics.repository';
import { SchoolRepository, type SchoolRecord } from '../../../repositories/platform/school.repository';
import {
  SubscriptionRepository,
  type SubscriptionRecord,
} from '../../../repositories/platform/subscription.repository';
import { retentionEndsOn } from '../schools/schools.service';
import { METRICS_MAX_AGE_DAYS } from './billing-run.service';
import type { AssignPlanDto, SchoolBillingDto, SubscriptionDto } from './billing.dto';
import {
  fromDateString,
  PLATFORM_TIMEZONE,
  toDateString,
  toInvoiceDto,
  toSubscriptionDto,
} from './billing.mappers';

/** The billing tab shows the last 12 invoices. */
const INVOICES_SHOWN = 12;

const terminated = () =>
  new ApiException(409, ErrorCode.SCHOOL_TERMINATED, 'A terminated school cannot be changed.');

/** The later of two DATE values. */
const later = (a: Date, b: Date): Date => (a > b ? a : b);

/**
 * One school's place in platform billing (slice 26, R223, A12): its live subscription, its latest
 * count, its invoices and its SMS cap; pinning it to a plan, unpinning it, and the explicit "use
 * the plan's allowance" that clears a manual cap override. Every write locks the school first,
 * then the plan (the monthly run's order).
 */
@Injectable()
export class SchoolBillingService {
  constructor(
    private readonly schools: SchoolRepository,
    private readonly plans: PlanRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly metrics: SchoolMetricsRepository,
    private readonly invoices: InvoiceRepository,
    private readonly audit: PlatformAuditRepository,
  ) {}

  async get(schoolId: bigint): Promise<SchoolBillingDto> {
    const school = await this.schools.findById(schoolId);
    if (!school) throw notFound();
    return this.view(school);
  }

  /**
   * Pins the school to a plan (A12): billed on it whatever the count until unpinned. Idempotent by
   * state: the same plan already pinned is 200 with no change. Otherwise the live row ends the day
   * before `startedOn` (or on its own first day) and a pinned row starts; the cap becomes the
   * plan's allowance and the override flag is cleared (R223). A trial school may hold a plan.
   */
  @Transactional()
  async assign(actorId: bigint, schoolId: bigint, dto: AssignPlanDto): Promise<SubscriptionDto> {
    const school = await this.lockSchool(schoolId);
    const planId = BigInt(dto.planId);
    const plan = await this.plans.lock(planId);
    if (!plan) throw fieldRefused('planId', ErrorCode.REFERENCE_NOT_FOUND, 'No such plan.');
    if (plan.status === 'archived') {
      throw new ApiException(409, ErrorCode.PLAN_ARCHIVED, 'An archived plan cannot be assigned.', {
        planId: plan.id.toString(),
      });
    }
    const live = await this.subscriptions.findLive(schoolId);
    if (live?.pinned && live.planId === planId) return toSubscriptionDto(live);
    const startedOn = fromDateString(dto.startedOn);
    if (live && startedOn < live.startedOn) {
      throw fieldRefused(
        'startedOn',
        ErrorCode.INVALID_VALUE,
        `startedOn must be on or after the current subscription's start, ${toDateString(live.startedOn)}`,
      );
    }
    if (live) await this.endLive(live, startedOn);
    const created = await this.subscriptions.create({
      schoolId,
      planId,
      startedOn,
      pinned: true,
      assignedBy: actorId,
      reason: dto.reason,
    });
    await this.schools.setSmsCap(schoolId, plan.smsAllowance, true);
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId,
      action: 'platform_subscription.assigned',
      subjectType: 'platform_subscription',
      subjectId: created.id,
      reason: dto.reason,
      metadata: {
        planId: planId.toString(),
        startedOn: dto.startedOn,
        previousPlanId: live === null ? null : live.planId.toString(),
        smsMonthlyCap: { from: school.smsMonthlyCap, to: plan.smsAllowance },
        smsCapOverridden: { from: school.smsCapOverridden, to: false },
      },
    });
    return toSubscriptionDto(created);
  }

  /**
   * Ends a pin (A12): the school goes back to the tier its count derives. When a count at most 7
   * days old falls in an active band, that tier starts today (unpinned) and, unless the cap is
   * overridden, the cap follows its allowance; otherwise the school has no live plan until the
   * next monthly run. Not pinned: 200 with no change.
   */
  @Transactional()
  async unpin(actorId: bigint, schoolId: bigint, reason: string, now: Date = new Date()): Promise<SchoolBillingDto> {
    const school = await this.lockSchool(schoolId);
    const live = await this.subscriptions.findLive(schoolId);
    if (!live?.pinned) return this.view(school);
    const today = todayIn(PLATFORM_TIMEZONE, now);
    const count = await this.metrics.latest(schoolId, addDays(today, -METRICS_MAX_AGE_DAYS), today);
    const tier = count === null ? null : tierFor(count.activeStudents, await this.plans.listActive());
    const plan = tier === null ? null : await this.plans.lock(tier.id);
    await this.endLive(live, today);
    let derived: SubscriptionRecord | null = null;
    if (plan?.status === 'active') {
      derived = await this.subscriptions.create({
        schoolId,
        planId: plan.id,
        startedOn: today,
        pinned: false,
        assignedBy: actorId,
        reason,
      });
      if (!school.smsCapOverridden && school.smsMonthlyCap !== plan.smsAllowance) {
        await this.schools.setSmsCap(schoolId, plan.smsAllowance, false);
      }
    }
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId,
      action: 'platform_subscription.unpinned',
      subjectType: 'platform_subscription',
      subjectId: live.id,
      reason,
      metadata: {
        planId: live.planId.toString(),
        derivedPlanId: derived === null ? null : derived.planId.toString(),
      },
    });
    return this.view(await this.requireSchool(schoolId));
  }

  /**
   * A12: the explicit clear of a manual cap override. The cap becomes the live plan's allowance;
   * with no live plan only the flag clears, and the next monthly run sets the cap. Not overridden:
   * 200 with no change.
   */
  @Transactional()
  async usePlanAllowance(actorId: bigint, schoolId: bigint): Promise<SchoolBillingDto> {
    const school = await this.lockSchool(schoolId);
    if (!school.smsCapOverridden) return this.view(school);
    const live = await this.subscriptions.findLive(schoolId);
    const plan = live === null ? null : await this.plans.findById(live.planId);
    const cap = plan?.smsAllowance ?? school.smsMonthlyCap;
    await this.schools.setSmsCap(schoolId, cap, true);
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId,
      action: 'school.sms_cap_override_cleared',
      subjectType: 'school',
      subjectId: schoolId,
      metadata: {
        smsMonthlyCap: { from: school.smsMonthlyCap, to: cap },
        planId: plan === null ? null : plan.id.toString(),
      },
    });
    return this.view(await this.requireSchool(schoolId));
  }

  /** Ends the live row the day before `from`, or on its own first day when it began on or after. */
  private async endLive(live: SubscriptionRecord, from: Date): Promise<void> {
    const ended = await this.subscriptions.end(live.id, later(live.startedOn, addDays(from, -1)));
    if (ended === 0) {
      throw new ApiException(409, ErrorCode.CONCURRENT_UPDATE, 'The subscription changed while this request ran. Reload and try again.');
    }
  }

  private async lockSchool(schoolId: bigint): Promise<SchoolRecord> {
    const school = await this.schools.lock(schoolId);
    if (!school) throw notFound();
    if (school.status === 'terminated') throw terminated();
    return school;
  }

  private async requireSchool(schoolId: bigint): Promise<SchoolRecord> {
    const school = await this.schools.findById(schoolId);
    if (!school) throw notFound();
    return school;
  }

  private async view(school: SchoolRecord): Promise<SchoolBillingDto> {
    const live = await this.subscriptions.findLive(school.id);
    const metrics = await this.metrics.mostRecent(school.id);
    const invoices = await this.invoices.lastForSchool(school.id, INVOICES_SHOWN);
    return {
      subscription: live === null ? null : toSubscriptionDto(live),
      metrics: metrics === null ? null : { day: toDateString(metrics.day), activeStudents: metrics.activeStudents },
      invoices: invoices.map(toInvoiceDto),
      smsCap: { value: school.smsMonthlyCap, overridden: school.smsCapOverridden },
      terminatedAt: school.terminatedAt,
      retentionEndsOn: school.terminatedAt === null ? null : retentionEndsOn(school.terminatedAt),
    };
  }
}
