import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { diffFields } from '../../../common/diff';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { toPage, type Page } from '../../../common/pagination';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlanRepository, type PlanRecord } from '../../../repositories/platform/plan.repository';
import { SubscriptionRepository } from '../../../repositories/platform/subscription.repository';
import type { CreatePlanDto, ListPlansQueryDto, PlanDto, UpdatePlanDto } from './billing.dto';
import { toPlanDto } from './billing.mappers';

const SUBJECT = 'platform_plan';
const EDITABLE = ['name', 'monthlyPrice', 'smsAllowance'] as const;

const overlaps = (plan: PlanRecord) =>
  new ApiException(409, ErrorCode.PLAN_BAND_OVERLAPS, 'The band overlaps an active plan.', {
    planId: plan.id.toString(),
    minStudents: plan.minStudents,
    maxStudents: plan.maxStudents,
  });

const archived = (plan: PlanRecord) =>
  new ApiException(409, ErrorCode.PLAN_ARCHIVED, 'An archived plan cannot be changed.', {
    planId: plan.id.toString(),
  });

/**
 * The platform's price tiers (R219): bands that never overlap among active plans, a monthly price
 * and an SMS allowance. None is seeded (the owner's §1.2 item 23). Bands are frozen; name, price
 * and allowance change until archive, which is final and refused while a live subscription points
 * at the plan. A price or allowance change reaches schools at the next monthly run (A12).
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly plans: PlanRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly audit: PlatformAuditRepository,
  ) {}

  async list(query: ListPlansQueryDto): Promise<Page<PlanDto>> {
    const { rows, total } = await this.plans.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toPlanDto), query, total);
  }

  async get(id: bigint): Promise<PlanDto> {
    const plan = await this.plans.findById(id);
    if (!plan) throw notFound();
    return toPlanDto(plan);
  }

  /**
   * The overlap is checked first for the contract's details; the exclusion constraint is what
   * holds under a concurrent create (mapped to the same code, constraints-billing.ts).
   */
  @Transactional()
  async create(actorId: bigint, dto: CreatePlanDto): Promise<PlanDto> {
    const maxStudents = dto.maxStudents ?? null;
    if (maxStudents !== null && maxStudents < dto.minStudents) {
      throw fieldRefused('maxStudents', ErrorCode.INVALID_VALUE, 'maxStudents must be at least minStudents');
    }
    const clash = await this.plans.findOverlappingActive(dto.minStudents, maxStudents);
    if (clash) throw overlaps(clash);
    const plan = await this.plans.create({
      name: dto.name,
      minStudents: dto.minStudents,
      maxStudents,
      monthlyPrice: dto.monthlyPrice,
      smsAllowance: dto.smsAllowance,
    });
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: null,
      action: 'platform_plan.created',
      subjectType: SUBJECT,
      subjectId: plan.id,
      metadata: {
        name: plan.name,
        minStudents: plan.minStudents,
        maxStudents: plan.maxStudents,
        monthlyPrice: plan.monthlyPrice,
        smsAllowance: plan.smsAllowance,
      },
    });
    return toPlanDto(plan);
  }

  /** Under the plan's lock; no change -> 200 without an audit row. */
  @Transactional()
  async update(actorId: bigint, id: bigint, dto: UpdatePlanDto): Promise<PlanDto> {
    const plan = await this.plans.lock(id);
    if (!plan) throw notFound();
    if (plan.status === 'archived') throw archived(plan);
    const { data, changes } = diffFields(plan, dto, EDITABLE);
    if (Object.keys(changes).length === 0) return toPlanDto(plan);
    const updated = await this.plans.update(id, data);
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: null,
      action: 'platform_plan.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toPlanDto(updated);
  }

  /**
   * Final. Under the plan's lock, which every subscription write takes too, so no subscription
   * lands on the plan between the in-use check and the archive. A repeat is 200 with no row.
   */
  @Transactional()
  async archive(actorId: bigint, id: bigint, reason: string): Promise<PlanDto> {
    const plan = await this.plans.lock(id);
    if (!plan) throw notFound();
    if (plan.status === 'archived') return toPlanDto(plan);
    if (await this.subscriptions.anyLiveOnPlan(id)) {
      throw new ApiException(409, ErrorCode.PLAN_IN_USE, 'A school is on this plan.', {
        planId: id.toString(),
      });
    }
    await this.plans.archive(id);
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: null,
      action: 'platform_plan.archived',
      subjectType: SUBJECT,
      subjectId: id,
      reason,
      metadata: { name: plan.name },
    });
    const after = await this.plans.findById(id);
    if (!after) throw notFound();
    return toPlanDto(after);
  }
}
