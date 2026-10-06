import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { concurrentUpdate, fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { CashHandoverRepository, type HandoverRecord } from '../../repositories/cash-handover.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { MessageRecipientRepository } from '../../repositories/message-recipient.repository';
import { PaymentReversalRepository } from '../../repositories/payment-reversal.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { requirePrincipal } from '../access/money-gates';
import type {
  ConfirmHandoverDto,
  CustodyDto,
  HandoverDto,
  ListHandoversQueryDto,
  OpenHandoverDto,
  OpenHandoverOnBehalfDto,
  ResolveShortfallDto,
} from './payments.dto';
import {
  handoverNoShortfall,
  handoverNotConfirmed,
  handoverNothing,
  handoverNotOpen,
  handoverOpen,
  notSelf,
  toHandoverDto,
} from './payments.shared';

const SUBJECT = 'cash_handover';

/**
 * Cash custody and handovers (phase-3-financial.md §3.4, A13, R193, R194): every cash payment
 * sits in its recorder's custody until a handover gathers it, under a lock on the collector's
 * payments by id, with the stored expected sum; a third user counts it; a shortfall tells the
 * principals and is resolved later by a principal. Nobody confirms their own handover or one
 * they opened on behalf (CHECK cash_handovers_not_self_check, and here first).
 */
@Injectable()
export class CashHandoversService {
  constructor(
    private readonly context: SchoolContext,
    private readonly handovers: CashHandoverRepository,
    private readonly payments: PaymentRepository,
    private readonly reversals: PaymentReversalRepository,
    private readonly expenses: ExpenseRepository,
    private readonly people: MessageRecipientRepository,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** GET /me/staff/custody: the caller's own cash in hand (the user from the session only). */
  async custody(): Promise<CustodyDto> {
    const { schoolId, userId } = this.context.actor();
    return this.payments.custody(schoolId, userId);
  }

  /** POST /me/staff/cash-handovers: the collector hands over their own custody. */
  async openOwn(session: SchoolSessionContext, dto: OpenHandoverDto): Promise<HandoverDto> {
    const staffId = session.access.staffId;
    if (staffId === null) throw notFound();
    return this.open(session.access.userId, staffId, dto.note ?? null);
  }

  /**
   * POST /cash-handovers: on behalf of a collector who has left or is suspended (A13), by a
   * `collection.handover.confirm` holder; a third user then confirms it.
   */
  async openOnBehalf(dto: OpenHandoverOnBehalfDto): Promise<HandoverDto> {
    const schoolId = this.context.schoolId;
    const collectorUserId = BigInt(dto.collectorUserId);
    const staff = await this.payments.staffOfUser(schoolId, collectorUserId);
    if (!staff) throw fieldRefused('collectorUserId', ErrorCode.REFERENCE_NOT_FOUND, 'No such staff login');
    if (staff.status === 'active') {
      throw fieldRefused(
        'collectorUserId',
        ErrorCode.INVALID_VALUE,
        'Only a collector who has left or is suspended is handed over for; an active one hands over their own cash',
      );
    }
    return this.open(collectorUserId, staff.staffId, dto.note ?? null);
  }

  @Transactional()
  private async open(collectorUserId: bigint, collectorStaffId: bigint, note: string | null): Promise<HandoverDto> {
    const { schoolId, userId } = this.context.actor();
    const existing = await this.handovers.findOpenFor(schoolId, collectorUserId);
    if (existing) throw handoverOpen({ handoverId: existing.id.toString() });
    // §3.4, R236: the collector's custody payments, locked by id; voided ones are already out.
    const custody = await this.payments.lockCustody(schoolId, collectorUserId);
    if (custody.length === 0) throw handoverNothing();
    const handover = await this.handovers.create(
      schoolId,
      {
        collectorUserId,
        collectorStaffId,
        openedBy: userId,
        expectedAmount: custody.reduce((sum, p) => sum + p.amount, 0),
        paymentCount: custody.length,
        note,
      },
      new Date(),
    );
    const ids = custody.map((p) => p.id);
    if ((await this.payments.joinHandover(schoolId, ids, handover.id)) !== ids.length) throw concurrentUpdate();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'cash_handover.opened',
      subjectType: SUBJECT,
      subjectId: handover.id,
      metadata: {
        collectorUserId: collectorUserId.toString(),
        expectedAmount: handover.expectedAmount,
        paymentCount: handover.paymentCount,
        onBehalf: handover.onBehalf,
      },
    });
    return this.dto(schoolId, handover);
  }

  /** R193, R194: a third user records the count; a shortfall tells the principals. */
  @Transactional()
  async confirm(id: bigint, dto: ConfirmHandoverDto): Promise<HandoverDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (row.status !== 'open') throw handoverNotOpen({ handoverId: id.toString() });
    if (row.collectorUserId === userId || row.openedBy === userId) {
      throw notSelf('You handed over or opened this cash. Ask a colleague to count it.', {
        reason: row.collectorUserId === userId ? 'collector' : 'opener',
      });
    }
    const shortfallAmount = Math.max(0, row.expectedAmount - dto.countedAmount);
    const surplusAmount = Math.max(0, dto.countedAmount - row.expectedAmount);
    const moved = await this.handovers.confirm(
      schoolId,
      id,
      { by: userId, countedAmount: dto.countedAmount, shortfallAmount, surplusAmount, note: dto.note ?? null },
      new Date(),
    );
    if (moved !== 1) throw handoverNotOpen({ handoverId: id.toString() });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'cash_handover.confirmed',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        collectorUserId: row.collectorUserId.toString(),
        expectedAmount: row.expectedAmount,
        countedAmount: dto.countedAmount,
        shortfallAmount,
        surplusAmount,
      },
    });
    if (shortfallAmount > 0) {
      const principals = await this.people.activePrincipalStaffIds(schoolId);
      if (principals.length > 0) {
        const names = await this.payments.userNames(schoolId, [row.collectorUserId]);
        await this.notifications.send(schoolId, {
          type: 'handover_shortfall',
          subject: { type: 'cash_handover', id },
          recipients: principals.map((staffId) => ({ staffId })),
          vars: { collectorName: names.get(row.collectorUserId) ?? 'a collector' },
        });
      }
    }
    return this.dto(schoolId, await this.require(schoolId, id));
  }

  /**
   * §3.4, R193: a principal resolves a confirmed shortfall once, with a reason: recovered, written
   * off (a cash_shortfall expense of the shortfall, in the same transaction) or explained by the
   * void of one of the handover's payments. Never by the collector.
   */
  @Transactional()
  async resolve(session: SchoolSessionContext, id: bigint, dto: ResolveShortfallDto): Promise<HandoverDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (row.status !== 'confirmed') throw handoverNotConfirmed({ handoverId: id.toString() });
    if (!row.shortfallAmount || row.shortfallResolution !== null) throw handoverNoShortfall({ handoverId: id.toString() });
    if (row.collectorUserId === userId) {
      throw notSelf('This was your cash. Ask another principal to resolve the shortfall.', { reason: 'collector' });
    }
    if ((dto.resolution === 'explained_by_void') !== (dto.reversalId !== undefined)) {
      throw fieldRefused('reversalId', ErrorCode.INVALID_VALUE, 'A void explains a shortfall only with its reversalId, and only then');
    }
    if (dto.reversalId !== undefined && !(await this.voidInHandover(schoolId, BigInt(dto.reversalId), id))) {
      throw fieldRefused('reversalId', ErrorCode.REFERENCE_NOT_FOUND, 'Name the void of a payment gathered in this handover');
    }
    const now = new Date();
    let expenseId: bigint | null = null;
    if (dto.resolution === 'written_off') {
      const expense = await this.expenses.create(
        schoolId,
        {
          expenseNo: await this.expenses.nextExpenseNo(schoolId),
          category: 'cash_shortfall',
          amount: row.shortfallAmount,
          spentOn: await this.clock.today(schoolId),
          description: `Cash shortfall written off, handover ${id.toString()}`,
          payee: null,
          method: 'cash',
          reference: null,
          status: 'approved',
          recordedBy: userId,
          receipt: null,
          // The principal's decision on record (expenses_not_self admits a principal's own).
          selfApproved: true,
        },
        now,
      );
      expenseId = expense.id;
    }
    const resolved = await this.handovers.resolve(
      schoolId,
      id,
      {
        resolution: dto.resolution,
        by: userId,
        reason: dto.reason,
        expenseId,
        reversalId: dto.reversalId === undefined ? null : BigInt(dto.reversalId),
      },
      now,
    );
    if (resolved !== 1) throw handoverNoShortfall({ handoverId: id.toString() });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'cash_handover.shortfall_resolved',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        resolution: dto.resolution,
        amount: row.shortfallAmount,
        collectorUserId: row.collectorUserId.toString(),
        expenseId: expenseId?.toString() ?? null,
        reversalId: dto.reversalId ?? null,
      },
    });
    return this.dto(schoolId, await this.require(schoolId, id));
  }

  /** The reversal is a void of a payment this handover gathered (cash_handovers_shortfall_reversal). */
  private async voidInHandover(schoolId: SchoolId, reversalId: bigint, handoverId: bigint): Promise<boolean> {
    const reversal = await this.reversals.findById(schoolId, reversalId);
    if (!reversal || reversal.kind !== 'void') return false;
    return (await this.payments.findById(schoolId, reversal.paymentId))?.handoverId === handoverId;
  }

  // -------------------------------------------------------------------------------- reads

  async list(query: ListHandoversQueryDto): Promise<Page<HandoverDto>> {
    return this.page(query, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.collectorUserId === undefined ? {} : { collectorUserId: BigInt(query.collectorUserId) }),
      ...(query.unresolvedShortfall === true ? { unresolvedShortfall: true } : {}),
    });
  }

  /** GET /me/staff/cash-handovers: the caller's own, as collector. */
  async mine(query: PageQueryDto): Promise<Page<HandoverDto>> {
    return this.page(query, { collectorUserId: this.context.actor().userId });
  }

  async get(id: bigint): Promise<HandoverDto> {
    const schoolId = this.context.schoolId;
    return this.dto(schoolId, await this.require(schoolId, id));
  }

  /** 404 unless the handover is this school's (GET /cash-handovers/:id/payments). */
  async exists(id: bigint): Promise<void> {
    await this.require(this.context.schoolId, id);
  }

  private async page(
    query: PageQueryDto,
    filter: { status?: HandoverRecord['status']; collectorUserId?: bigint; unresolvedShortfall?: boolean },
  ): Promise<Page<HandoverDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.handovers.list(schoolId, {
      ...filter,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const names = await this.names(schoolId, rows);
    return toPage(rows.map((r) => toHandoverDto(r, names)), query, total);
  }

  private async require(schoolId: SchoolId, id: bigint): Promise<HandoverRecord> {
    const row = await this.handovers.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private async dto(schoolId: SchoolId, row: HandoverRecord): Promise<HandoverDto> {
    return toHandoverDto(row, await this.names(schoolId, [row]));
  }

  private async names(schoolId: SchoolId, rows: readonly HandoverRecord[]): Promise<(userId: bigint) => string> {
    const names = await this.payments.userNames(
      schoolId,
      rows.flatMap((r) => [r.collectorUserId, r.openedBy, ...(r.confirmedBy === null ? [] : [r.confirmedBy])]),
    );
    return (userId) => names.get(userId) ?? '';
  }
}
