import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AcademicYearRepository, type AcademicYearRecord } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { FeeHeadRepository, type FeeHeadRecord } from '../../repositories/fee-head.repository';
import {
  FeeStructureRepository,
  type FeeStructureRecord,
} from '../../repositories/fee-structure.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { classArchived, yearClosed } from '../academics/academics.shared';
import { ChargeRunRepository } from '../../repositories/charge-run.repository';
import { runInProgress } from './charges.shared';
import { feeHeadArchived } from './fee-heads.service';
import type {
  CopyFeeStructuresDto,
  CopyFeeStructuresResultDto,
  CreateFeeStructureDto,
  FeeStructureClassDto,
  FeeStructureDto,
  ListFeeStructuresQueryDto,
} from './fees.dto';

const ENDPOINT = 'fee_structures';
const SUBJECT = 'fee_structure';

export interface FeeStructureCreateOutcome {
  replayed: boolean;
  structure: FeeStructureDto;
}

export function toFeeStructureDto(row: FeeStructureRecord): FeeStructureDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    classId: row.classId.toString(),
    feeHeadId: row.feeHeadId.toString(),
    feeHeadName: row.feeHead.name,
    amount: row.amount,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    supersededBy: row.supersededBy?.toString() ?? null,
    supersededAt: row.supersededAt,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

const yearMonth = (date: Date): string => date.toISOString().slice(0, 7);

const structureExists = (structureId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.FEE_STRUCTURE_EXISTS,
    'This class already has an amount for that head from that month. Give a reason to replace it.',
    { structureId: structureId.toString() },
  );

const notLater = (latestEffectiveFrom: string): ApiException =>
  new ApiException(
    409,
    ErrorCode.FEE_STRUCTURE_NOT_LATER,
    `A new amount must start after ${latestEffectiveFrom}, the latest month already set.`,
    { latestEffectiveFrom },
  );

/** Fee structures (phase-3-financial.md slice 18, R177). Nothing is charged from them yet. */
@Injectable()
export class FeeStructuresService {
  constructor(
    private readonly context: SchoolContext,
    private readonly structures: FeeStructureRepository,
    private readonly heads: FeeHeadRepository,
    private readonly years: AcademicYearRepository,
    private readonly classes: ClassRepository,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly runs: ChargeRunRepository,
  ) {}

  /** One page of the year's classes, each with its current amounts and its whole history. */
  async list(query: ListFeeStructuresQueryDto): Promise<Page<FeeStructureClassDto>> {
    const schoolId = this.context.schoolId;
    const academicYearId = BigInt(query.academicYearId);
    // As on create: an unknown year, or another school's, is a refused field, not an empty grid.
    if (!(await this.years.findById(schoolId, academicYearId))) {
      throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    }
    const { rows, total } = await this.structures.classesOfYear(schoolId, academicYearId, {
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const history = await this.structures.forClasses(
      schoolId,
      academicYearId,
      rows.map((c) => c.id),
    );
    const data = rows.map((cls): FeeStructureClassDto => {
      const own = history.filter((h) => h.classId === cls.id);
      // forClasses orders by head, then newest month: the first active row per head is current.
      const current = new Map<bigint, FeeStructureRecord>();
      for (const row of own) {
        if (row.status === 'active' && !current.has(row.feeHeadId)) current.set(row.feeHeadId, row);
      }
      return {
        classId: cls.id.toString(),
        className: cls.name,
        heads: [...current.values()]
          .sort((a, b) => a.feeHead.name.localeCompare(b.feeHead.name))
          .map((row) => ({
            feeHeadId: row.feeHeadId.toString(),
            name: row.feeHead.name,
            frequency: row.feeHead.frequency,
            amount: row.amount,
            effectiveFrom: row.effectiveFrom,
            structureId: row.id.toString(),
          })),
        history: own.map(toFeeStructureDto),
      };
    });
    return toPage(data, query, total);
  }

  /**
   * Keyed by Idempotency-Key (endpoint fee_structures, path id the class). A same-month row
   * supersedes the active one when a reason is given; a later month is a new active row.
   */
  async create(dto: CreateFeeStructureDto, rawKey: string | undefined): Promise<FeeStructureCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(
      actor,
      ENDPOINT,
      BigInt(dto.classId),
      dto,
      rawKey,
      (claim) => this.createInTransaction(actor, dto, claim),
    );
    if (outcome.replayed) {
      const row = await this.structures.findById(actor.schoolId, outcome.subjectId);
      if (!row) throw notFound();
      return { replayed: true, structure: toFeeStructureDto(row) };
    }
    return { replayed: false, structure: toFeeStructureDto(outcome.value) };
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    dto: CreateFeeStructureDto,
    claim: IdempotencyClaim,
  ): Promise<FeeStructureRecord> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const year = await this.openYear(schoolId, BigInt(dto.academicYearId), 'academicYearId');
    assertMonthInYear(year, dto.effectiveFrom, 'effectiveFrom');
    const cls = await this.classes.findById(schoolId, BigInt(dto.classId));
    if (!cls || cls.academicYearId !== year.id) {
      throw fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class in that academic year');
    }
    if (cls.status === 'archived') throw classArchived();
    // Every write for a head runs under the head's lock: the latest-month rule sees a stable set.
    const head = await this.lockHead(schoolId, BigInt(dto.feeHeadId));
    if (head.status === 'archived') throw feeHeadArchived(head.id);
    // Slice 19: no structure write while the year's charges are being generated (§5.1).
    const busy = await this.runs.findInProgress(schoolId, year.id);
    if (busy) throw runInProgress(busy.id);

    const active = await this.structures.activeFor(schoolId, cls.id, head.id);
    const sameMonth = active.find((row) => row.effectiveFrom === dto.effectiveFrom);
    let superseded: FeeStructureRecord | undefined;
    if (sameMonth) {
      if (dto.reason === undefined) throw structureExists(sameMonth.id);
      if ((await this.structures.markSuperseded(schoolId, sameMonth.id)) === 0) {
        throw structureExists(sameMonth.id);
      }
      superseded = sameMonth;
    } else {
      const latest = active[0];
      if (latest && dto.effectiveFrom <= latest.effectiveFrom) throw notLater(latest.effectiveFrom);
    }
    const created = await this.structures.create(schoolId, {
      academicYearId: year.id,
      classId: cls.id,
      feeHeadId: head.id,
      amount: dto.amount,
      effectiveFrom: dto.effectiveFrom,
      reason: dto.reason ?? null,
      createdBy: userId,
    });
    if (superseded) await this.structures.linkSuccessor(schoolId, superseded.id, created.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_structure.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        academicYearId: year.id.toString(),
        classId: cls.id.toString(),
        feeHeadId: head.id.toString(),
        amount: created.amount,
        effectiveFrom: created.effectiveFrom,
        supersededId: superseded?.id.toString() ?? null,
        supersededAmount: superseded?.amount ?? null,
      },
    });
    await recordSubject(created.id);
    return created;
  }

  /**
   * Copies a year's current amounts to the classes of the same name in another year, from
   * `effectiveFrom`. A pair the target already prices, an archived head and a class with no
   * namesake are skipped; nothing existing is touched.
   */
  @Transactional()
  async copy(dto: CopyFeeStructuresDto): Promise<CopyFeeStructuresResultDto> {
    const { schoolId, userId } = this.context.actor();
    if (dto.fromAcademicYearId === dto.toAcademicYearId) {
      throw fieldRefused('toAcademicYearId', ErrorCode.INVALID_VALUE, 'toAcademicYearId must differ from fromAcademicYearId');
    }
    const from = await this.years.findById(schoolId, BigInt(dto.fromAcademicYearId));
    if (!from) {
      throw fieldRefused('fromAcademicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    }
    const to = await this.openYear(schoolId, BigInt(dto.toAcademicYearId), 'toAcademicYearId');
    assertMonthInYear(to, dto.effectiveFrom, 'effectiveFrom');

    const fromClasses = await this.structures.liveClassesOfYear(schoolId, from.id);
    const toClasses = new Map(
      (await this.structures.liveClassesOfYear(schoolId, to.id)).map((c) => [c.name.toLowerCase(), c.id]),
    );
    const sourceRows = await this.structures.forClasses(schoolId, from.id, fromClasses.map((c) => c.id));
    let created = 0;
    let skipped = 0;
    for (const cls of fromClasses) {
      const target = toClasses.get(cls.name.toLowerCase());
      // The current (latest active) row per head of the source class.
      const current = new Map<bigint, FeeStructureRecord>();
      for (const row of sourceRows) {
        if (row.classId === cls.id && row.status === 'active' && !current.has(row.feeHeadId)) {
          current.set(row.feeHeadId, row);
        }
      }
      for (const row of current.values()) {
        if (target === undefined) {
          skipped += 1;
          continue;
        }
        const head = await this.lockHead(schoolId, row.feeHeadId);
        if (head.status === 'archived' || (await this.structures.activeFor(schoolId, target, head.id)).length > 0) {
          skipped += 1;
          continue;
        }
        await this.structures.create(schoolId, {
          academicYearId: to.id,
          classId: target,
          feeHeadId: head.id,
          amount: row.amount,
          effectiveFrom: dto.effectiveFrom,
          reason: null,
          createdBy: userId,
        });
        created += 1;
      }
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'fee_structure.copied',
      subjectType: 'academic_year',
      subjectId: to.id,
      metadata: {
        fromAcademicYearId: from.id.toString(),
        effectiveFrom: dto.effectiveFrom,
        created,
        skipped,
      },
    });
    return { created, skipped };
  }

  private async openYear(schoolId: SchoolId, id: bigint, field: string): Promise<AcademicYearRecord> {
    const year = await this.years.findById(schoolId, id);
    if (!year) throw fieldRefused(field, ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw yearClosed();
    return year;
  }

  private lockHead(schoolId: SchoolId, id: bigint): Promise<FeeHeadRecord> {
    return readLocked(
      () => this.heads.findById(schoolId, id),
      (row) => this.heads.lockIfUnchanged(schoolId, row),
      () => fieldRefused('feeHeadId', ErrorCode.REFERENCE_NOT_FOUND, 'No such fee head'),
    );
  }
}

/** The month must fall inside the academic year's dates. */
function assertMonthInYear(year: AcademicYearRecord, month: string, field: string): void {
  if (month < yearMonth(year.startsOn) || month > yearMonth(year.endsOn)) {
    throw fieldRefused(field, ErrorCode.INVALID_VALUE, `${field} must be a month of the academic year`);
  }
}
