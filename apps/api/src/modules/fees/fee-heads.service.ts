import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, type FeeHeadCategory } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { FeeHeadRepository, type FeeHeadRecord } from '../../repositories/fee-head.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type {
  CreateFeeHeadDto,
  FeeHeadDto,
  ListFeeHeadsQueryDto,
  UpdateFeeHeadDto,
} from './fees.dto';
import type { ReasonDto } from '../../common/reason.dto';

const SUBJECT = 'fee_head';

/**
 * Categories with at most one live head (fee_heads_one_tuition_key, fee_heads_one_fine_key and,
 * since Phase 5, fee_heads_one_transport_key: the transport charge names its head).
 */
const ONE_PER_SCHOOL: readonly FeeHeadCategory[] = ['tuition', 'fine', 'transport'];

export function toFeeHeadDto(head: FeeHeadRecord): FeeHeadDto {
  return {
    id: head.id.toString(),
    name: head.name,
    category: head.category,
    frequency: head.frequency,
    concessionEligible: head.concessionEligible,
    refundable: head.refundable,
    status: head.status,
    archivedAt: head.archivedAt,
    archiveReason: head.archiveReason,
    seeded: head.createdBy === null,
    createdAt: head.createdAt,
  };
}

export const feeHeadArchived = (feeHeadId: bigint): ApiException =>
  new ApiException(409, ErrorCode.FEE_HEAD_ARCHIVED, 'This fee head is archived.', {
    feeHeadId: feeHeadId.toString(),
  });

const nameTaken = (feeHeadId: bigint): ApiException =>
  new ApiException(409, ErrorCode.FEE_HEAD_NAME_TAKEN, 'A fee head of that name already exists.', {
    feeHeadId: feeHeadId.toString(),
  });

const categoryTaken = (feeHeadId: bigint, category: FeeHeadCategory): ApiException =>
  new ApiException(
    409,
    ErrorCode.FEE_HEAD_CATEGORY_TAKEN,
    `The school already has a ${category} head. Archive it first.`,
    { feeHeadId: feeHeadId.toString() },
  );

/** Rules 19 and 20 as request rules: 422 on the field, before the CHECK would refuse it. */
function refuseForbiddenFlags(
  category: FeeHeadCategory,
  flags: { concessionEligible?: boolean | undefined; refundable?: boolean | undefined },
): void {
  if (category === 'fine' && flags.concessionEligible === true) {
    throw fieldRefused('concessionEligible', ErrorCode.INVALID_VALUE, 'A fine is never concession-eligible');
  }
  if (category === 'admission' && flags.refundable === true) {
    throw fieldRefused('refundable', ErrorCode.INVALID_VALUE, 'An admission fee is never refundable');
  }
}

/** Fee heads (phase-3-financial.md slice 18, R176). */
@Injectable()
export class FeeHeadsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly heads: FeeHeadRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(query: ListFeeHeadsQueryDto): Promise<Page<FeeHeadDto>> {
    const { rows, total } = await this.heads.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      sort: query.sort ?? 'name',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toFeeHeadDto), query, total);
  }

  async get(id: bigint): Promise<FeeHeadDto> {
    const head = await this.heads.findById(this.context.schoolId, id);
    if (!head) throw notFound();
    return toFeeHeadDto(head);
  }

  /**
   * A taken live name or a second live tuition or fine head is refused with the holder's id; the
   * partial unique indexes catch a concurrent create (mapped in prisma-errors.ts).
   */
  @Transactional()
  async create(dto: CreateFeeHeadDto): Promise<FeeHeadDto> {
    const { schoolId, userId } = this.context.actor();
    refuseForbiddenFlags(dto.category, dto);
    const sameName = await this.heads.findLiveByName(schoolId, dto.name);
    if (sameName) throw nameTaken(sameName.id);
    if (ONE_PER_SCHOOL.includes(dto.category)) {
      const holder = await this.heads.findLiveByCategory(schoolId, dto.category);
      if (holder) throw categoryTaken(holder.id, dto.category);
    }
    const head = await this.heads.create(schoolId, {
      name: dto.name,
      category: dto.category,
      frequency: dto.frequency,
      concessionEligible: dto.concessionEligible ?? dto.category !== 'fine',
      refundable: dto.refundable ?? dto.category !== 'admission',
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_head.created',
      subjectType: SUBJECT,
      subjectId: head.id,
      metadata: {
        name: head.name,
        category: head.category,
        frequency: head.frequency,
        concessionEligible: head.concessionEligible,
        refundable: head.refundable,
      },
    });
    return toFeeHeadDto(head);
  }

  /** Name and the two flags; category and frequency are frozen; an archived head is frozen. */
  @Transactional()
  async update(id: bigint, dto: UpdateFeeHeadDto): Promise<FeeHeadDto> {
    const { schoolId, userId } = this.context.actor();
    const head = await this.lock(schoolId, id);
    if (head.status === 'archived') throw feeHeadArchived(head.id);
    refuseForbiddenFlags(head.category, dto);

    const data: { name?: string; concessionEligible?: boolean; refundable?: boolean } = {};
    const changes: Record<string, { from: string | boolean; to: string | boolean }> = {};
    if (dto.name !== undefined && dto.name !== head.name) {
      const sameName = await this.heads.findLiveByName(schoolId, dto.name, head.id);
      if (sameName) throw nameTaken(sameName.id);
      data.name = dto.name;
      changes.name = { from: head.name, to: dto.name };
    }
    for (const key of ['concessionEligible', 'refundable'] as const) {
      const value = dto[key];
      if (value !== undefined && value !== head[key]) {
        data[key] = value;
        changes[key] = { from: head[key], to: value };
      }
    }
    if (Object.keys(changes).length === 0) return toFeeHeadDto(head);

    const updated = await this.heads.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_head.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toFeeHeadDto(updated);
  }

  /** Final. Open charges keep their head; generation skips it (R176). Repeating it is a no-op. */
  @Transactional()
  async archive(id: bigint, dto: ReasonDto): Promise<FeeHeadDto> {
    const { schoolId, userId } = this.context.actor();
    const head = await this.lock(schoolId, id);
    if (head.status === 'archived') return toFeeHeadDto(head);
    const updated = await this.heads.archive(schoolId, id, userId, dto.reason);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_head.archived',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { name: head.name, category: head.category },
    });
    return toFeeHeadDto(updated);
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<FeeHeadRecord> {
    return readLocked(
      () => this.heads.findById(schoolId, id),
      (row) => this.heads.lockIfUnchanged(schoolId, row),
    );
  }
}
