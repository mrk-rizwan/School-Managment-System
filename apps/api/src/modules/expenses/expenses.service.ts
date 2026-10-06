import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, formatRupees, type ExpenseStatus } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, concurrentUpdate, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  ExpenseRepository,
  type ExpenseContent,
  type ExpenseReceipt,
  type ExpenseRecord,
} from '../../repositories/expense.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import {
  StagedUploadRepository,
  type StagedUploadRecord,
} from '../../repositories/staged-upload.repository';
import { UserRepository } from '../../repositories/user.repository';
import { AfterCommit } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { capabilityNotHeld } from '../access/access.errors';
import { PermissionsService } from '../access/permissions.service';
import { AttachmentFiles, type AttachedFile } from '../documents/attachment-files.service';
import { stagedUploadUnusable } from '../documents/documents.service';
import type { ReasonDto } from '../fees/fees.dto';
import type {
  ApproveExpenseDto,
  CreateExpenseDto,
  ExpenseDto,
  ExpenseReceiptDto,
  ListExpensesQueryDto,
  RejectExpenseDto,
  UpdateExpenseDto,
} from './expenses.dto';

// phase-3-financial.md slice 23, §3.1, §3.2 (R206-R208, R244); contracts/slice-23.md. The
// database holds the same rules as triggers (migration 20261006100200_slice23_expenses); the
// service refuses first, with the contract's codes.

const ENDPOINT = 'expenses';
const SUBJECT = 'expense';
/** `POST /expenses` has no path id (§5 slice 23: "pathId none"); the key is hashed with 0. */
const NO_PATH_ID = 0n;
/** The school_settings column default, for a school that has no settings row yet. */
const DEFAULT_THRESHOLD = 5000;
const OPEN: readonly ExpenseStatus[] = ['recorded', 'pending_approval'];
const EDITABLE = ['category', 'amount', 'spentOn', 'description', 'payee', 'method', 'reference'] as const;

export interface ExpenseCreateOutcome {
  replayed: boolean;
  expense: ExpenseDto;
}

/** 403: only the recorder edits, attaches a receipt to, or voids an open expense (§3.1). */
export const notRecorder = (): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only the person who recorded this expense can do this.', {
    reason: 'not_recorder',
  });

/** R244: nobody decides, or voids after approval, their own expense. */
const ownExpense = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'You cannot decide or void your own expense. Ask a colleague.',
  );

const expenseRefusal = (code: ErrorCode, message: string) => (expenseId: bigint) =>
  new ApiException(409, code, message, { expenseId: expenseId.toString() });

export const expenseNotOpen = expenseRefusal(
  ErrorCode.EXPENSE_NOT_OPEN,
  'This expense has been decided or voided and can no longer change this way.',
);
export const expenseNotPending = expenseRefusal(
  ErrorCode.EXPENSE_NOT_PENDING,
  'This expense is not waiting for approval.',
);
export const expenseReceiptExists = expenseRefusal(
  ErrorCode.EXPENSE_RECEIPT_EXISTS,
  'This expense already has a receipt.',
);

/** R233's reading of the role: a live principal system role on a staff member, never a grant. */
const isPrincipal = (session: SchoolSessionContext): boolean =>
  session.access.capacities.staff && session.access.systemRoles.includes('principal');

export function toExpenseDto(row: ExpenseRecord): ExpenseDto {
  return {
    id: row.id.toString(),
    expenseNo: row.expenseNo,
    category: row.category,
    amount: row.amount,
    spentOn: toDateString(row.spentOn),
    description: row.description,
    payee: row.payee,
    // CHECK expenses_method_check: never carried_forward.
    method: row.method === 'carried_forward' ? 'cash' : row.method,
    reference: row.reference,
    hasReceipt: row.receiptObjectKey !== null,
    receiptMime: row.receiptMime,
    status: row.status,
    selfApproved: row.selfApproved,
    recordedByUserId: row.recordedBy.toString(),
    recordedByName: row.recordedByName,
    recordedAt: row.recordedAt,
    decidedByUserId: row.decidedBy?.toString() ?? null,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    updatedAt: row.updatedAt,
  };
}

/** What every money verb's audit row carries about the expense (R230). */
const auditFacts = (row: ExpenseRecord) => ({
  expenseNo: row.expenseNo,
  amount: row.amount,
  category: row.category,
  recordedBy: row.recordedBy.toString(),
});

@Injectable()
export class ExpensesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly expenses: ExpenseRepository,
    private readonly staged: StagedUploadRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly users: UserRepository,
    private readonly permissions: PermissionsService,
    private readonly idempotency: IdempotentRequests,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly attachments: AttachmentFiles,
    private readonly afterCommit: AfterCommit,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  async list(query: ListExpensesQueryDto): Promise<Page<ExpenseDto>> {
    const { rows, total } = await this.expenses.list(this.context.schoolId, {
      ...(query.spentFrom === undefined ? {} : { spentFrom: fromDateString(query.spentFrom) }),
      ...(query.spentTo === undefined ? {} : { spentTo: fromDateString(query.spentTo) }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.recordedByUserId === undefined ? {} : { recordedBy: BigInt(query.recordedByUserId) }),
      sort: query.sort ?? '-spentOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toExpenseDto), query, total);
  }

  async get(id: bigint): Promise<ExpenseDto> {
    return toExpenseDto(await this.require(this.context.schoolId, id));
  }

  /** The receipt or its thumbnail (R208): streamed, named `expense-<no>`, logged by id only. */
  async receipt(id: bigint, thumb: boolean): Promise<AttachedFile> {
    const schoolId = this.context.schoolId;
    const row = await this.require(schoolId, id);
    const { receiptObjectKey: objectKey, receiptMime: mime, receiptSizeBytes: sizeBytes } = row;
    if (objectKey === null || mime === null || sizeBytes === null) throw notFound();
    const file = { objectKey, mime, sizeBytes };
    const name = `expense-${row.expenseNo}`;
    const log = { expenseId: row.id.toString() };
    return thumb
      ? this.attachments.thumbnail(schoolId, file, name, log)
      : this.attachments.open(schoolId, file, name, log);
  }

  // --------------------------------------------------------------------------------- record

  /** R206. Keyed by Idempotency-Key (endpoint `expenses`, no path id): a replay answers 200. */
  async create(
    session: SchoolSessionContext,
    dto: CreateExpenseDto,
    rawKey: string | undefined,
  ): Promise<ExpenseCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, NO_PATH_ID, dto, rawKey, (claim) =>
      this.createInTransaction(session, actor, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, expense: await this.get(outcome.subjectId) };
    return { replayed: false, expense: toExpenseDto(outcome.value) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    dto: CreateExpenseDto,
    claim: IdempotencyClaim,
  ): Promise<ExpenseRecord> {
    // The first statement: a racing same-key request now waits on the unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const spentOn = await this.spentOn(schoolId, dto.spentOn);
    const threshold = await this.threshold(schoolId);
    const receipt =
      dto.stagedUploadId === undefined ? null : await this.consume(actor, BigInt(dto.stagedUploadId));

    // R206: at or below the threshold an expense is recorded; above it, a principal's own is
    // approved on record (self-approved), anyone else's waits — an expense.approve holder's too.
    const above = dto.amount > threshold;
    const selfApproved = above && isPrincipal(session);
    const status = !above ? 'recorded' : selfApproved ? 'approved' : 'pending_approval';
    const now = new Date();
    // The counter last, just before the insert (§3.2).
    const expenseNo = await this.expenses.nextExpenseNo(schoolId);
    const row = await this.expenses.create(
      schoolId,
      {
        expenseNo,
        category: dto.category,
        amount: dto.amount,
        spentOn,
        description: dto.description,
        payee: dto.payee ?? null,
        method: dto.method,
        reference: dto.reference ?? null,
        status,
        recordedBy: userId,
        receipt,
        selfApproved,
      },
      now,
    );
    await recordSubject(row.id);
    if (status === 'pending_approval') await this.requestApproval(schoolId, row);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'expense.recorded',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: {
        ...auditFacts(row),
        method: row.method,
        status,
        selfApproved,
        threshold,
        hasReceipt: receipt !== null,
      },
    });
    return row;
  }

  // ----------------------------------------------------------------------------------- edit

  /**
   * The recorder's edit while the expense is open. A `recorded` expense cannot be raised above
   * the threshold: its status cannot move to pending (expenses_status_transition), and an edit
   * must not skip the approval a new record would need.
   */
  @Transactional()
  async update(id: bigint, dto: UpdateExpenseDto): Promise<ExpenseDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await readLocked(
      () => this.expenses.findById(schoolId, id),
      (r) => this.expenses.lockIfUnchanged(schoolId, r),
    );
    if (row.recordedBy !== userId) throw notRecorder();
    if (!OPEN.includes(row.status)) throw expenseNotOpen(id);

    const changes: Partial<ExpenseContent> = {};
    if (dto.category !== undefined && dto.category !== row.category) changes.category = dto.category;
    if (dto.amount !== undefined && dto.amount !== row.amount) changes.amount = dto.amount;
    if (dto.spentOn !== undefined && dto.spentOn !== toDateString(row.spentOn)) {
      changes.spentOn = await this.spentOn(schoolId, dto.spentOn);
    }
    if (dto.description !== undefined && dto.description !== row.description) changes.description = dto.description;
    if (dto.payee !== undefined && dto.payee !== row.payee) changes.payee = dto.payee;
    if (dto.method !== undefined && dto.method !== row.method) changes.method = dto.method;
    if (dto.reference !== undefined && dto.reference !== row.reference) changes.reference = dto.reference;
    const changed = EDITABLE.filter((field) => changes[field] !== undefined);
    // No change: 200 unchanged, no audit row.
    if (changed.length === 0) return toExpenseDto(row);

    if (changes.amount !== undefined && row.status === 'recorded') {
      const threshold = await this.threshold(schoolId);
      if (changes.amount > threshold) {
        throw fieldRefused(
          'amount',
          ErrorCode.INVALID_VALUE,
          `Above the approval threshold of ${formatRupees(threshold)} an expense needs approval: void this one and record it again.`,
        );
      }
    }
    if ((await this.expenses.updateContent(schoolId, id, changes)) === 0) throw expenseNotOpen(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'expense.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        ...auditFacts({ ...row, ...changes }),
        changes: changed.join(','),
        ...(changes.amount === undefined ? {} : { previousAmount: row.amount }),
      },
    });
    return toExpenseDto(await this.require(schoolId, id));
  }

  /**
   * The receipt, set once by the recorder (§3.9's `expense_receipt` lane), in any status: it is
   * the evidence, and it may reach the server after the expense was decided. The same upload sent
   * again answers 200 unchanged; a different one is EXPENSE_RECEIPT_EXISTS.
   */
  @Transactional()
  async attachReceipt(id: bigint, dto: ExpenseReceiptDto): Promise<ExpenseDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    const row = await this.require(schoolId, id);
    if (row.recordedBy !== userId) throw notRecorder();
    const [staged] = await this.staged.findOwned(schoolId, userId, [BigInt(dto.stagedUploadId)]);
    const sameUpload = (key: string | null) => staged !== undefined && key === staged.objectKey;
    if (row.receiptObjectKey !== null) {
      if (sameUpload(row.receiptObjectKey)) return toExpenseDto(row);
      throw expenseReceiptExists(id);
    }
    const receipt = staged === undefined ? null : await this.tryConsume(actor, staged);
    if (receipt === null) {
      // A concurrent send of the same upload consumed it first and has committed (the consume
      // waited on its row lock): that is this request's outcome.
      const now = await this.require(schoolId, id);
      if (sameUpload(now.receiptObjectKey)) return toExpenseDto(now);
      throw stagedUploadUnusable('stagedUploadId');
    }
    if ((await this.expenses.setReceipt(schoolId, id, receipt)) === 0) throw expenseReceiptExists(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'expense.receipt_attached',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { ...auditFacts(row), mime: receipt.mime, sizeBytes: receipt.sizeBytes },
    });
    return toExpenseDto(await this.require(schoolId, id));
  }

  // ------------------------------------------------------------------------------- decide

  /** R244: an `expense.approve` holder decides a pending expense, never their own. */
  @Transactional()
  async approve(id: bigint, dto: ApproveExpenseDto): Promise<ExpenseDto> {
    return this.decide(id, 'approved', dto.expectedUpdatedAt, dto.reason ?? null);
  }

  @Transactional()
  async reject(id: bigint, dto: RejectExpenseDto): Promise<ExpenseDto> {
    return this.decide(id, 'rejected', dto.expectedUpdatedAt, dto.reason);
  }

  /**
   * Compare-and-set on the version the approver read (`expectedUpdatedAt`): a recorder's edit
   * between the approver's read and the decision makes it `409 CONCURRENT_UPDATE`, so nobody
   * approves an amount they never saw.
   */
  private async decide(
    id: bigint,
    status: 'approved' | 'rejected',
    expectedUpdatedAt: string,
    reason: string | null,
  ): Promise<ExpenseDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (row.status !== 'pending_approval') throw expenseNotPending(id);
    if (row.recordedBy === userId) throw ownExpense();
    const expected = new Date(expectedUpdatedAt);
    if (row.updatedAt.getTime() !== expected.getTime()) throw concurrentUpdate();
    const decision = { status, by: userId, at: new Date(), reason };
    if ((await this.expenses.decide(schoolId, id, expected, decision)) === 0) {
      const now = await this.require(schoolId, id);
      throw now.status === 'pending_approval' ? concurrentUpdate() : expenseNotPending(id);
    }
    if (row.recordedByStaffId !== null) {
      await this.notifications.send(schoolId, {
        type: 'expense_decided',
        subject: { type: 'expense', id },
        recipients: [{ staffId: row.recordedByStaffId }],
        vars: { expenseNo: row.expenseNo, decision: status },
      });
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: status === 'approved' ? 'expense.approved' : 'expense.rejected',
      subjectType: SUBJECT,
      subjectId: id,
      ...(reason === null ? {} : { reason }),
      metadata: auditFacts(row),
    });
    return toExpenseDto(await this.require(schoolId, id));
  }

  /**
   * R206, R244: the recorder voids their own open expense; once approved, an `expense.approve`
   * holder who is not the recorder voids it — or the principal who self-approved it.
   */
  @Transactional()
  async void(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<ExpenseDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    const { capabilities } = session.access;
    if (row.status === 'approved') {
      if (!capabilities.has(Capability.EXPENSE_APPROVE)) throw capabilityNotHeld([Capability.EXPENSE_APPROVE]);
      if (row.recordedBy === userId && !(row.selfApproved && isPrincipal(session))) throw ownExpense();
    } else if (OPEN.includes(row.status)) {
      if (row.recordedBy !== userId) throw notRecorder();
      if (!capabilities.has(Capability.EXPENSE_RECORD)) throw capabilityNotHeld([Capability.EXPENSE_RECORD]);
    } else {
      throw expenseNotOpen(id);
    }
    if ((await this.expenses.void(schoolId, id, row.status, userId, new Date(), dto.reason)) === 0) {
      const now = await this.require(schoolId, id);
      throw now.status === 'voided' || now.status === 'rejected' ? expenseNotOpen(id) : concurrentUpdate();
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'expense.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { ...auditFacts(row), fromStatus: row.status, selfApproved: row.selfApproved },
    });
    return toExpenseDto(await this.require(schoolId, id));
  }

  // -------------------------------------------------------------------------------- helpers

  private async require(schoolId: SchoolId, id: bigint): Promise<ExpenseRecord> {
    const row = await this.expenses.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** `spentOn` no later than today in the school's time zone (§5: date rules in the request). */
  private async spentOn(schoolId: SchoolId, value: string): Promise<Date> {
    const date = fromDateString(value);
    if (date > (await this.clock.today(schoolId))) {
      throw fieldRefused('spentOn', ErrorCode.INVALID_VALUE, 'spentOn must be no later than today');
    }
    return date;
  }

  private async threshold(schoolId: SchoolId): Promise<number> {
    return (await this.settings.find(schoolId))?.expenseApprovalThreshold ?? DEFAULT_THRESHOLD;
  }

  /** The caller's staged upload, consumed in one conditional update; else 422 (R91). */
  private async consume(actor: Actor, stagedUploadId: bigint): Promise<ExpenseReceipt> {
    const [staged] = await this.staged.findOwned(actor.schoolId, actor.userId, [stagedUploadId]);
    const receipt = staged === undefined ? null : await this.tryConsume(actor, staged);
    if (receipt === null) throw stagedUploadUnusable('stagedUploadId');
    return receipt;
  }

  /**
   * Consumes the row, or null when it is used or expired. An image's thumbnail is made from the
   * stored object after commit, so nothing reaches storage for a write that rolls back.
   */
  private async tryConsume(actor: Actor, staged: StagedUploadRecord): Promise<ExpenseReceipt | null> {
    const { schoolId, userId } = actor;
    if (!(await this.staged.consume(schoolId, userId, staged.id, new Date()))) return null;
    const receipt = { objectKey: staged.objectKey, mime: staged.mime, sizeBytes: staged.sizeBytes };
    this.afterCommit.register(() => this.attachments.storeThumbnail(schoolId, receipt));
    return receipt;
  }

  /**
   * `expense_approval_requested` to every confirmed `expense.approve` holder other than the
   * recorder (§3.6): candidates by role, grant or custom role, each confirmed through the
   * permission service (revokes honoured).
   */
  private async requestApproval(schoolId: SchoolId, row: ExpenseRecord): Promise<void> {
    const staffIds: bigint[] = [];
    for (const candidate of await this.users.watcherCandidates(schoolId, Capability.EXPENSE_APPROVE)) {
      if (candidate.userId === row.recordedBy) continue;
      const access = await this.permissions.load(schoolId, candidate.userId);
      if (access?.capacities.staff && access.capabilities.has(Capability.EXPENSE_APPROVE)) {
        staffIds.push(candidate.staffId);
      }
    }
    if (staffIds.length === 0) return;
    await this.notifications.send(schoolId, {
      type: 'expense_approval_requested',
      subject: { type: 'expense', id: row.id },
      recipients: staffIds.map((staffId) => ({ staffId })),
      vars: { expenseNo: row.expenseNo, category: row.category, recorderName: row.recordedByName },
    });
  }
}
