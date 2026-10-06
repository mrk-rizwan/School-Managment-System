import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, concessionAmount, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AcademicYearRepository, type AcademicYearRecord } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  ChargeCampaignRepository,
  type CampaignAudienceRow,
  type CampaignContent,
  type CampaignRecord,
} from '../../repositories/charge-campaign.repository';
import { ChargeRunRepository } from '../../repositories/charge-run.repository';
import { ConcessionRepository } from '../../repositories/concession.repository';
import { FeeHeadRepository, type FeeHeadRecord } from '../../repositories/fee-head.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString, yearClosed } from '../academics/academics.shared';
import { assertTargetsExist, audienceDtos, campaignAudienceRows, parseCampaignAudiences } from './campaign-audiences';
import type {
  CampaignDto,
  CampaignPreviewDto,
  CancelCampaignDto,
  CreateCampaignDto,
  ListCampaignsQueryDto,
  PreviewCampaignTargetsDto,
  UpdateCampaignDto,
} from './campaigns.dto';
import type { ChargeRunDto } from './charges.dto';
import {
  campaignNoTargets,
  campaignNotDraft,
  monthNotGeneratable,
  periodOf,
  runInProgress,
  toChargeRunDto,
} from './charges.shared';
import { requireHeld } from './fee-gates';
import { feeHeadArchived } from './fee-heads.service';

const ENDPOINT = 'charge_campaigns';
const SUBJECT = 'charge_campaign';
/** §3.1, §4: a campaign charges a per-term or ad hoc head (monthly, once and yearly heads are generated). */
const CAMPAIGN_FREQUENCIES = ['per_term', 'ad_hoc'];

export interface CampaignCreateOutcome {
  replayed: boolean;
  campaign: CampaignDto;
}

export function toCampaignDto(row: CampaignRecord): CampaignDto {
  return {
    id: row.id.toString(),
    name: row.name,
    academicYearId: row.academicYearId.toString(),
    feeHeadId: row.feeHeadId.toString(),
    feeHeadName: row.feeHead.name,
    amount: row.amount,
    dueOn: toDateString(row.dueOn),
    description: row.description,
    applyConcessions: row.applyConcessions,
    status: row.status,
    audiences: audienceDtos(campaignAudienceRows(row)),
    createdByUserId: row.createdBy.toString(),
    createdAt: row.createdAt,
    generatedAt: row.generatedAt,
    generatedCount: row.generatedCount,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
  };
}

/**
 * Charge campaigns (phase-3-financial.md slice 19, R184): one fee to an audience of students,
 * generated once by the charge-run job. Writes need `charge.create` as well as the route's
 * `charge.campaign.send` (§3.1).
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly campaigns: ChargeCampaignRepository,
    private readonly runs: ChargeRunRepository,
    private readonly concessions: ConcessionRepository,
    private readonly heads: FeeHeadRepository,
    private readonly years: AcademicYearRepository,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly clock: SchoolClock,
  ) {}

  async list(query: ListCampaignsQueryDto): Promise<Page<CampaignDto>> {
    const { rows, total } = await this.campaigns.list(this.context.schoolId, {
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toCampaignDto), query, total);
  }

  async get(id: bigint): Promise<CampaignDto> {
    return toCampaignDto(await this.require(this.context.schoolId, id));
  }

  /** Keyed by Idempotency-Key (endpoint charge_campaigns, path id the academic year). */
  async create(
    session: SchoolSessionContext,
    dto: CreateCampaignDto,
    rawKey: string | undefined,
  ): Promise<CampaignCreateOutcome> {
    requireHeld(session, Capability.CHARGE_CREATE);
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, BigInt(dto.academicYearId), dto, rawKey, (claim) =>
      this.createInTransaction(actor, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, campaign: await this.get(id) };
  }

  @Transactional()
  private async createInTransaction(actor: Actor, dto: CreateCampaignDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const year = await this.openYear(schoolId, BigInt(dto.academicYearId));
    assertDueInYear(year, dto.dueOn);
    const head = await this.campaignHead(schoolId, BigInt(dto.feeHeadId));
    const audiences = parseCampaignAudiences(dto.audiences);
    await assertTargetsExist(this.campaigns, schoolId, year.id, audiences);
    const id = await this.campaigns.create(
      schoolId,
      {
        name: dto.name,
        academicYearId: year.id,
        feeHeadId: head.id,
        amount: dto.amount,
        dueOn: fromDateString(dto.dueOn),
        description: dto.description ?? null,
        applyConcessions: dto.applyConcessions ?? false,
      },
      audiences,
      userId,
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge_campaign.created',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { academicYearId: year.id.toString(), feeHeadId: head.id.toString(), amount: dto.amount, dueOn: dto.dueOn },
    });
    await recordSubject(id);
    return id;
  }

  /** A draft's fields; `audiences` replaces the whole set (the announcement precedent). */
  @Transactional()
  async update(session: SchoolSessionContext, id: bigint, dto: UpdateCampaignDto): Promise<CampaignDto> {
    requireHeld(session, Capability.CHARGE_CREATE);
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status !== 'draft') throw campaignNotDraft(id);
    const year = await this.openYear(schoolId, row.academicYearId);
    const content: Partial<CampaignContent> = {};
    if (dto.name !== undefined) content.name = dto.name;
    if (dto.amount !== undefined) content.amount = dto.amount;
    if (dto.applyConcessions !== undefined) content.applyConcessions = dto.applyConcessions;
    if (dto.description !== undefined) content.description = dto.description;
    if (dto.dueOn !== undefined) {
      assertDueInYear(year, dto.dueOn);
      content.dueOn = fromDateString(dto.dueOn);
    }
    if (dto.feeHeadId !== undefined) content.feeHeadId = (await this.campaignHead(schoolId, BigInt(dto.feeHeadId))).id;
    let audiences: CampaignAudienceRow[] | undefined;
    if (dto.audiences !== undefined) {
      audiences = parseCampaignAudiences(dto.audiences);
      await assertTargetsExist(this.campaigns, schoolId, year.id, audiences);
    }
    await this.campaigns.updateDraft(schoolId, id, content, audiences);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge_campaign.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { fields: [...Object.keys(content), ...(audiences ? ['audiences'] : [])].join(',') },
    });
    return this.get(id);
  }

  /** How many students the audience reaches and what concessions would take off (read only). */
  async preview(dto: PreviewCampaignTargetsDto): Promise<CampaignPreviewDto> {
    const schoolId = this.context.schoolId;
    const year = await this.years.findById(schoolId, BigInt(dto.academicYearId));
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    const head = await this.campaignHead(schoolId, BigInt(dto.feeHeadId));
    const audiences = parseCampaignAudiences(dto.audiences);
    await assertTargetsExist(this.campaigns, schoolId, year.id, audiences);
    const targets = await this.campaigns.targetEnrolments(schoolId, year.id, audiences);
    let affected = 0;
    let totalReduction = 0;
    if (dto.applyConcessions && head.concessionEligible) {
      const period = periodOf(await this.clock.today(schoolId));
      const approved = await this.concessions.approvedForStudents(
        schoolId,
        year.id,
        head.id,
        targets.map((t) => t.studentId),
        period,
      );
      const seen = new Set<bigint>();
      for (const c of approved) {
        if (seen.has(c.studentId)) continue;
        seen.add(c.studentId);
        const off = concessionAmount(dto.amount, { kind: c.kind, value: c.value, feeHeadIds: [head.id] }, head);
        if (off > 0) {
          affected += 1;
          totalReduction += off;
        }
      }
    }
    return {
      targets: { students: targets.length, enrolments: targets.length },
      concessions: { affected, totalReduction },
    };
  }

  /**
   * Queues the campaign's run (R184): draft → generating and a `campaign` charge_runs row; the
   * charge-run job writes the charges and moves it to generated. 201 with the run.
   */
  async generate(session: SchoolSessionContext, id: bigint): Promise<ChargeRunDto> {
    requireHeld(session, Capability.CHARGE_CREATE);
    const schoolId = this.context.schoolId;
    const run = await recoverConstraint(
      'charge_runs_period_key',
      () => this.queue(id),
      async (error) => {
        const row = await this.campaigns.findById(schoolId, id);
        const busy = row ? await this.runs.findInProgress(schoolId, row.academicYearId) : null;
        if (!busy) throw error;
        throw runInProgress(busy.id);
      },
    );
    return toChargeRunDto(run, new Map());
  }

  @Transactional()
  private async queue(id: bigint) {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status !== 'draft') throw campaignNotDraft(id);
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year || year.status === 'closed') throw monthNotGeneratable('year_closed');
    if (row.feeHead.status === 'archived') throw feeHeadArchived(row.feeHeadId);
    const busy = await this.runs.findInProgress(schoolId, row.academicYearId);
    if (busy) throw runInProgress(busy.id);
    const targets = await this.campaigns.targetEnrolments(schoolId, row.academicYearId, campaignAudienceRows(row));
    if (targets.length === 0) throw campaignNoTargets();
    if ((await this.campaigns.move(schoolId, id, 'draft', 'generating')) !== 1) throw campaignNotDraft(id);
    const now = new Date();
    const run = await this.runs.createQueued(schoolId, {
      academicYearId: row.academicYearId,
      period: periodOf(await this.clock.today(schoolId)),
      kind: 'campaign',
      campaignId: id,
      triggeredBy: userId,
      regenerateVoided: false,
      queuedAt: now,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge_campaign.generate_requested',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { runId: run.id.toString(), targets: targets.length, amount: row.amount },
    });
    this.outbox.chargeRunAfterCommit(schoolId, run.id);
    return run;
  }

  /** draft | generated → cancelled; cancelling a generated campaign voids nothing (R184). */
  @Transactional()
  async cancel(session: SchoolSessionContext, id: bigint, dto: CancelCampaignDto): Promise<CampaignDto> {
    requireHeld(session, Capability.CHARGE_CREATE);
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status !== 'draft' && row.status !== 'generated') throw campaignNotDraft(id);
    const moved = await this.campaigns.move(schoolId, id, row.status, 'cancelled', {
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: dto.reason,
    });
    if (moved !== 1) throw campaignNotDraft(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge_campaign.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { fromStatus: row.status, generatedCount: row.generatedCount },
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------------------ helpers

  private async require(schoolId: SchoolId, id: bigint): Promise<CampaignRecord> {
    const row = await this.campaigns.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<CampaignRecord> {
    return readLocked(
      () => this.campaigns.findById(schoolId, id),
      (row) => this.campaigns.lockIfUnchanged(schoolId, row),
    );
  }

  private async openYear(schoolId: SchoolId, id: bigint): Promise<AcademicYearRecord> {
    const year = await this.years.findById(schoolId, id);
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw yearClosed();
    return year;
  }

  /** A live per-term or ad hoc head (422 otherwise; 409 when archived). */
  private async campaignHead(schoolId: SchoolId, id: bigint): Promise<FeeHeadRecord> {
    const head = await this.heads.findById(schoolId, id);
    if (!head) throw fieldRefused('feeHeadId', ErrorCode.REFERENCE_NOT_FOUND, 'No such fee head');
    if (head.status === 'archived') throw feeHeadArchived(head.id);
    if (!CAMPAIGN_FREQUENCIES.includes(head.frequency)) {
      throw fieldRefused('feeHeadId', ErrorCode.INVALID_VALUE, 'A campaign charges a per-term or ad hoc head');
    }
    return head;
  }
}

/** The due date falls inside the academic year (422). */
function assertDueInYear(year: AcademicYearRecord, dueOn: string): void {
  const day = fromDateString(dueOn);
  if (day < year.startsOn || day > year.endsOn) {
    throw fieldRefused('dueOn', ErrorCode.INVALID_VALUE, 'dueOn must fall inside the academic year');
  }
}
