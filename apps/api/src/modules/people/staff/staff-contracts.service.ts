import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../../common/idempotency';
import { readLocked } from '../../../common/locking';
import { toPage, type Page } from '../../../common/pagination';
import { addDays, daysBetween, SchoolClock } from '../../../common/school-clock';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { SalaryStructureRepository } from '../../../repositories/salary-structure.repository';
import { StaffRepository, type StaffRecord } from '../../../repositories/staff.repository';
import {
  StaffContractRepository,
  type StaffContractDocument,
  type StaffContractRecord,
} from '../../../repositories/staff-contract.repository';
import { StagedUploadRepository } from '../../../repositories/staged-upload.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import { fromDateString, toDateString } from '../../academics/academics.shared';
import { AttachmentFiles, type AttachedFile } from '../../documents/attachment-files.service';
import { stagedUploadUnusable } from '../../documents/documents.service';
import type {
  CreateStaffContractDto,
  EndStaffContractDto,
  ListEndingContractsQueryDto,
  ListStaffContractsQueryDto,
  MyStaffContractDto,
  StaffContractDto,
  StaffContractStatus,
} from './staff-contracts.dto';

// Phase 5 slice 39 (phase-5-extended.md rule 35, §1.1, §1.3 A6, §5 slice 39, R318-R321;
// contracts/slice-39.md §2). A contract is never edited: a renewal ends the current one on its last
// day and opens the next from the day after, in one transaction; "end employment" ends the live
// contract (reason `left`) inside the staff status change. Expiry changes nothing by itself
// (rule 35). Lock order: the staff row, then its contracts (the staff status change takes the
// staff row first too). The database holds the same rules (§4 of the contract); the service
// refuses first with the contract's codes.

const ENDPOINT = 'staff_contracts';
const SUBJECT = 'staff_contract';
/** end_reason of the contract a renewal ends, and of the one "end employment" ends. */
export const CONTRACT_RENEWED = 'renewed';
export const CONTRACT_LEFT = 'left';

export interface StaffContractCreateOutcome {
  replayed: boolean;
  contract: StaffContractDto;
}

/** R318: the staff member already has a live contract. */
const liveExists = (staffId: bigint, contractId: bigint): ApiException =>
  new ApiException(409, ErrorCode.STAFF_CONTRACT_LIVE_EXISTS, 'This staff member already has a live contract. Renew or end it first.', {
    staffId: staffId.toString(),
    contractId: contractId.toString(),
  });

/** The contract has already ended (renewed, ended or by end employment). */
const contractEnded = (staffId: bigint): ApiException =>
  new ApiException(409, ErrorCode.STAFF_CONTRACT_ENDED, 'This contract has already ended.', { staffId: staffId.toString() });

const endRequired = (message: string): ApiException => fieldRefused('endsOn', ErrorCode.STAFF_CONTRACT_END_REQUIRED, message);

/** Status against the school's today (§1 StaffContractStatus). */
export function contractStatus(row: Pick<StaffContractRecord, 'startsOn' | 'endsOn' | 'endedAt'>, today: Date): StaffContractStatus {
  if (row.endedAt !== null) return 'ended';
  if (row.startsOn > today) return 'upcoming';
  if (row.endsOn !== null && row.endsOn < today) return 'expired';
  return 'live';
}

export function toStaffContractDto(row: StaffContractRecord, today: Date): StaffContractDto {
  return {
    id: row.id.toString(),
    staffId: row.staffId.toString(),
    staffName: row.staffName,
    type: row.type,
    startsOn: toDateString(row.startsOn),
    endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
    status: contractStatus(row, today),
    daysLeft: row.endsOn === null || row.endedAt !== null ? null : daysBetween(today, row.endsOn),
    salaryStructureId: row.salaryStructureId?.toString() ?? null,
    hasDocument: row.documentObjectKey !== null,
    documentMime: row.documentMime,
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    endedOn: row.endedOn === null ? null : toDateString(row.endedOn),
    endReason: row.endReason,
    endedByName: row.endedByName,
  };
}

@Injectable()
export class StaffContractsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly contracts: StaffContractRepository,
    private readonly staff: StaffRepository,
    private readonly structures: SalaryStructureRepository,
    private readonly staged: StagedUploadRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly attachments: AttachmentFiles,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  /** GET /staff/:id/contracts: every contract of the staff member, newest start first. */
  async listForStaff(staffId: bigint, query: ListStaffContractsQueryDto): Promise<Page<StaffContractDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.staff.findById(schoolId, staffId))) throw notFound();
    const today = await this.clock.today(schoolId);
    const { rows, total } = await this.contracts.listForStaff(schoolId, staffId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map((row) => toStaffContractDto(row, today)), query, total);
  }

  /** GET /staff-contracts?endsBy=: live contracts ending by the date, expired ones included. */
  async listEnding(query: ListEndingContractsQueryDto): Promise<Page<StaffContractDto>> {
    const schoolId = this.context.schoolId;
    const today = await this.clock.today(schoolId);
    const { rows, total } = await this.contracts.liveEndingBy(schoolId, fromDateString(query.endsBy), {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map((row) => toStaffContractDto(row, today)), query, total);
  }

  async get(id: bigint): Promise<StaffContractDto> {
    const schoolId = this.context.schoolId;
    return toStaffContractDto(await this.require(schoolId, id), await this.clock.today(schoolId));
  }

  /** GET /me/staff/contract: the caller's live contract, without the note or the structure (R321). */
  async mine(staffId: bigint): Promise<MyStaffContractDto> {
    const schoolId = this.context.schoolId;
    const live = await this.contracts.findLive(schoolId, staffId);
    if (live === null) return { current: null };
    const today = await this.clock.today(schoolId);
    return {
      current: {
        id: live.id.toString(),
        type: live.type,
        startsOn: toDateString(live.startsOn),
        endsOn: live.endsOn === null ? null : toDateString(live.endsOn),
        status: contractStatus(live, today),
        hasDocument: live.documentObjectKey !== null,
      },
    };
  }

  /**
   * R321: the scan, streamed (never presigned, R43), audited `staff_contract.document_viewed`.
   * `ownStaffId` set: the caller's own live contract (GET /me/staff/contract/document).
   */
  async document(target: { contractId: bigint } | { ownStaffId: bigint }): Promise<AttachedFile> {
    const { schoolId, userId } = this.context.actor();
    const row =
      'contractId' in target
        ? await this.require(schoolId, target.contractId)
        : await this.contracts.findLive(schoolId, target.ownStaffId);
    if (row === null) throw notFound();
    const { documentObjectKey: objectKey, documentMime: mime, documentSizeBytes: sizeBytes } = row;
    if (objectKey === null || mime === null || sizeBytes === null) throw notFound();
    const file = await this.attachments.open(schoolId, { objectKey, mime, sizeBytes }, `contract-${row.id}`, {
      staffContractId: row.id.toString(),
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff_contract.document_viewed',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { staffId: row.staffId.toString(), own: 'ownStaffId' in target },
    });
    return file;
  }

  // ---------------------------------------------------------------------------------- write

  /** POST /staff/:id/contracts, keyed (endpoint staff_contracts, path id the staff member). */
  async create(staffId: bigint, dto: CreateStaffContractDto, rawKey: string | undefined): Promise<StaffContractCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, staffId, dto, rawKey, (claim) =>
      this.createInTransaction(actor, staffId, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, contract: await this.get(id) };
  }

  @Transactional()
  private async createInTransaction(actor: Actor, staffId: bigint, dto: CreateStaffContractDto, claim: IdempotencyClaim): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const staff = await this.lockStaff(schoolId, staffId);
    const live = await this.contracts.findLive(schoolId, staffId);
    if (live) throw liveExists(staffId, live.id);
    const id = await this.insert(actor, staff, dto);
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff_contract.created',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: await this.auditFacts(schoolId, id),
    });
    return id;
  }

  /**
   * POST /staff-contracts/:id/renew: ends the live contract on its last day (reason `renewed`) and
   * opens the next from the day after, in one transaction (R318). A permanent contract has no last
   * day to renew from.
   */
  @Transactional()
  async renew(id: bigint, dto: CreateStaffContractDto): Promise<StaffContractDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    const current = await this.require(schoolId, id);
    const staff = await this.lockStaff(schoolId, current.staffId);
    if (current.endedAt !== null) throw contractEnded(current.staffId);
    if (current.endsOn === null) {
      throw new ApiException(
        409,
        ErrorCode.ILLEGAL_STATUS_TRANSITION,
        'A permanent contract has no end to renew from. End it and add a new contract.',
        { staffId: current.staffId.toString(), type: current.type },
      );
    }
    const nextStart = addDays(current.endsOn, 1);
    if (dto.startsOn !== toDateString(nextStart)) {
      throw fieldRefused(
        'startsOn',
        ErrorCode.INVALID_VALUE,
        `A renewal starts the day after the current contract ends: ${toDateString(nextStart)}`,
      );
    }
    const now = new Date();
    const ended = await this.contracts.end(schoolId, current.id, {
      endedBy: userId,
      reason: CONTRACT_RENEWED,
      endedOn: current.endsOn,
      now,
    });
    if (ended === 0) throw contractEnded(current.staffId);
    const nextId = await this.insert(actor, staff, dto);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff_contract.renewed',
      subjectType: SUBJECT,
      subjectId: nextId,
      metadata: { ...(await this.auditFacts(schoolId, nextId)), renewedFromId: current.id.toString() },
    });
    return this.get(nextId);
  }

  /** POST /staff-contracts/:id/end: the actual last day, from the start to the agreed end (R318). */
  @Transactional()
  async end(id: bigint, dto: EndStaffContractDto): Promise<StaffContractDto> {
    const { schoolId, userId } = this.context.actor();
    const current = await this.require(schoolId, id);
    await this.lockStaff(schoolId, current.staffId);
    if (current.endedAt !== null) throw contractEnded(current.staffId);
    const endedOn = fromDateString(dto.endedOn);
    if (endedOn < current.startsOn) {
      throw fieldRefused('endedOn', ErrorCode.INVALID_VALUE, `endedOn must not be before the contract starts (${toDateString(current.startsOn)})`);
    }
    if (current.endsOn !== null && endedOn > current.endsOn) {
      throw fieldRefused('endedOn', ErrorCode.INVALID_VALUE, `endedOn must not be after the contract's last day (${toDateString(current.endsOn)}); renew it instead`);
    }
    if ((await this.contracts.end(schoolId, id, { endedBy: userId, reason: dto.reason, endedOn, now: new Date() })) === 0) {
      throw contractEnded(current.staffId);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'staff_contract.ended',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { staffId: current.staffId.toString(), endedOn: dto.endedOn, via: 'end' },
    });
    return this.get(id);
  }

  /**
   * "End employment" (POST /staff/:id/change-status to `left`, R318): inside that transaction,
   * after it has locked the staff row, the live contract ends with reason `left` on the leaving
   * day — clamped into the contract (never before its start, never after its agreed end, so an
   * expired contract ends on its own last day). Returns the ended contract's id, or null.
   */
  async endForLeaving(schoolId: SchoolId, staffId: bigint, actorUserId: bigint, leftOn: Date, now: Date): Promise<bigint | null> {
    const live = await this.contracts.findLive(schoolId, staffId);
    if (live === null) return null;
    let endedOn = leftOn;
    if (live.endsOn !== null && endedOn > live.endsOn) endedOn = live.endsOn;
    if (endedOn < live.startsOn) endedOn = live.startsOn;
    if ((await this.contracts.end(schoolId, live.id, { endedBy: actorUserId, reason: CONTRACT_LEFT, endedOn, now })) === 0) {
      return null;
    }
    await this.audit.record(schoolId, {
      actorUserId,
      action: 'staff_contract.ended',
      subjectType: SUBJECT,
      subjectId: live.id,
      reason: CONTRACT_LEFT,
      metadata: { staffId: staffId.toString(), endedOn: toDateString(endedOn), via: 'end_employment' },
    });
    return live.id;
  }

  // -------------------------------------------------------------------------------- helpers

  private async require(schoolId: SchoolId, id: bigint): Promise<StaffContractRecord> {
    const row = await this.contracts.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private lockStaff(schoolId: SchoolId, staffId: bigint): Promise<StaffRecord> {
    return readLocked(
      () => this.staff.findById(schoolId, staffId),
      (row) => this.staff.lockIfUnchanged(schoolId, row),
    );
  }

  /** The checks of a new contract (create and the next of a renewal), then the insert. */
  private async insert(actor: Actor, staff: StaffRecord, dto: CreateStaffContractDto): Promise<bigint> {
    const { schoolId, userId } = actor;
    if (staff.status === 'left') {
      throw new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'This staff member has left. Re-hire them before adding a contract.', {
        staffId: staff.id.toString(),
        status: staff.status,
      });
    }
    const startsOn = fromDateString(dto.startsOn);
    if (dto.type === 'permanent' && dto.endsOn !== undefined) throw endRequired('A permanent contract has no end date.');
    if (dto.type !== 'permanent' && dto.endsOn === undefined) throw endRequired('A fixed-term or probation contract needs its last day.');
    const endsOn = dto.endsOn === undefined ? null : fromDateString(dto.endsOn);
    if (endsOn !== null && endsOn < startsOn) {
      throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, 'endsOn must not be before startsOn');
    }
    // R321: the structure at the start, named, never restated.
    let salaryStructureId: bigint | null;
    if (dto.salaryStructureId !== undefined) {
      const structure = await this.structures.findById(schoolId, BigInt(dto.salaryStructureId));
      if (!structure || structure.staffId !== staff.id) {
        throw fieldRefused('salaryStructureId', ErrorCode.REFERENCE_NOT_FOUND, "Not one of this staff member's salary structures");
      }
      salaryStructureId = structure.id;
    } else {
      salaryStructureId = (await this.structures.activeOn(schoolId, staff.id, startsOn))?.id ?? null;
    }
    const document = dto.stagedUploadId === undefined ? null : await this.consume(actor, BigInt(dto.stagedUploadId));
    return this.contracts.create(schoolId, {
      staffId: staff.id,
      type: dto.type,
      startsOn,
      endsOn,
      salaryStructureId,
      document,
      note: dto.note ?? null,
      createdBy: userId,
    });
  }

  /** The caller's staged upload, consumed in one conditional update; else 422 (R91). */
  private async consume(actor: Actor, stagedUploadId: bigint): Promise<StaffContractDocument> {
    const [staged] = await this.staged.findOwned(actor.schoolId, actor.userId, [stagedUploadId]);
    if (staged === undefined || !(await this.staged.consume(actor.schoolId, actor.userId, staged.id, new Date()))) {
      throw stagedUploadUnusable('stagedUploadId');
    }
    return { objectKey: staged.objectKey, mime: staged.mime, sizeBytes: staged.sizeBytes };
  }

  /** What the created and renewed rows carry (never an amount, R321). */
  private async auditFacts(schoolId: SchoolId, id: bigint): Promise<Record<string, string | boolean | null>> {
    const row = await this.require(schoolId, id);
    return {
      staffId: row.staffId.toString(),
      type: row.type,
      startsOn: toDateString(row.startsOn),
      endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
      salaryStructureId: row.salaryStructureId?.toString() ?? null,
      hasDocument: row.documentObjectKey !== null,
    };
  }
}
