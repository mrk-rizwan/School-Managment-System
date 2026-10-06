import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, yearMonthOf } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ExpenseRepository } from '../../repositories/expense.repository';
import { SalaryAdvanceRepository } from '../../repositories/salary-advance.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString } from '../academics/academics.shared';
import { requirePrincipal } from '../access/money-gates';
import { staffNotActive } from '../people/staff/staff.errors';
import { toAdvanceDto } from './payroll.mappers';
import type { AdvanceDto, CreateAdvanceDto, ListAdvancesQueryDto } from './payroll.dto';
import type { ReasonDto } from '../fees/fees.dto';

// phase-3-financial.md slice 25 (R215, R235, R247); contracts/slice-25.md §3. Grant and write-off
// are the principal's (R233) and never for their own staff row (no sole-principal exception: cash).
// A grant may write its salary_advance_cash expense in the same transaction (expense counter last).

const ENDPOINT = 'salary_advances';
const SUBJECT = 'salary_advance';
/** The school_settings column default, for a school that has no settings row yet. */
const DEFAULT_THRESHOLD = 5000;

export interface AdvanceCreateOutcome {
  replayed: boolean;
  advance: AdvanceDto;
}

/** R235: nobody grants or writes off their own advance. */
const ownAdvance = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'You cannot grant or write off your own salary advance. Ask a colleague.',
    { reason: 'own_advance' },
  );

const advanceNotOpen = (advanceId: bigint): ApiException =>
  new ApiException(409, ErrorCode.ADVANCE_NOT_OPEN, 'This advance is already recovered or written off.', {
    advanceId: advanceId.toString(),
  });

/** The month after `yearMonth`. */
export const nextMonth = (yearMonth: string): string => {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
};

@Injectable()
export class SalaryAdvancesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly advances: SalaryAdvanceRepository,
    private readonly staff: StaffRepository,
    private readonly expenses: ExpenseRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  async list(query: ListAdvancesQueryDto): Promise<Page<AdvanceDto>> {
    const { rows, total } = await this.advances.list(this.context.schoolId, {
      ...(query.staffId === undefined ? {} : { staffId: BigInt(query.staffId) }),
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toAdvanceDto), query, total);
  }

  async get(id: bigint): Promise<AdvanceDto> {
    return toAdvanceDto(await this.require(this.context.schoolId, id));
  }

  /** POST /salary-advances, keyed (endpoint salary_advances, path id the staff member). */
  async create(session: SchoolSessionContext, dto: CreateAdvanceDto, rawKey: string | undefined): Promise<AdvanceCreateOutcome> {
    requirePrincipal(session);
    const staffId = BigInt(dto.staffId);
    if (session.access.staffId === staffId) throw ownAdvance();
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, staffId, dto, rawKey, (claim) =>
      this.createInTransaction(actor, staffId, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, advance: await this.get(id) };
  }

  @Transactional()
  private async createInTransaction(actor: Actor, staffId: bigint, dto: CreateAdvanceDto, claim: IdempotencyClaim): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const member = await readLocked(
      () => this.staff.findById(schoolId, staffId),
      (row) => this.staff.lockIfUnchanged(schoolId, row),
      () => fieldRefused('staffId', ErrorCode.REFERENCE_NOT_FOUND, 'No such staff member'),
    );
    if (member.status !== 'active') throw staffNotActive();

    const grantedOn = fromDateString(dto.grantedOn);
    if (grantedOn > (await this.clock.today(schoolId))) {
      throw fieldRefused('grantedOn', ErrorCode.INVALID_VALUE, 'grantedOn must be no later than today');
    }
    if (dto.instalmentAmount > dto.amount) {
      throw fieldRefused('instalmentAmount', ErrorCode.INVALID_VALUE, 'instalmentAmount must be at most the amount');
    }
    const grantedMonth = yearMonthOf(dto.grantedOn);
    const recoverFrom = dto.recoverFrom ?? nextMonth(grantedMonth);
    if (recoverFrom < grantedMonth) {
      throw fieldRefused('recoverFrom', ErrorCode.INVALID_VALUE, 'recoverFrom must not be before the month it is granted');
    }
    const paidReference = dto.paidReference ?? null;

    // R215: the cash leaving the school as an expense, approved on record by the principal who
    // granted it when above the threshold (R206's self-approval); the expense counter last.
    let expenseId: bigint | null = null;
    if (dto.recordAsExpense) {
      expenseId = await this.recordExpense(schoolId, userId, member.fullName, dto, grantedOn, paidReference);
    }
    const id = await this.advances.create(schoolId, {
      staffId,
      amount: dto.amount,
      grantedOn,
      recoverFrom,
      instalmentAmount: dto.instalmentAmount,
      approvedBy: userId,
      paidMethod: dto.paidMethod,
      paidReference,
      expenseId,
    });
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'salary_advance.granted',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        staffId: staffId.toString(),
        amount: dto.amount,
        instalmentAmount: dto.instalmentAmount,
        grantedOn: dto.grantedOn,
        recoverFrom,
        paidMethod: dto.paidMethod,
        ...(expenseId === null ? {} : { expenseId: expenseId.toString() }),
      },
    });
    return id;
  }

  private async recordExpense(
    schoolId: SchoolId,
    userId: bigint,
    staffName: string,
    dto: CreateAdvanceDto,
    grantedOn: Date,
    reference: string | null,
  ): Promise<bigint> {
    const threshold = (await this.settings.find(schoolId))?.expenseApprovalThreshold ?? DEFAULT_THRESHOLD;
    const selfApproved = dto.amount > threshold;
    const expenseNo = await this.expenses.nextExpenseNo(schoolId);
    const expense = await this.expenses.create(
      schoolId,
      {
        expenseNo,
        category: 'salary_advance_cash',
        amount: dto.amount,
        spentOn: grantedOn,
        description: `Salary advance to ${staffName}`.slice(0, 500),
        payee: staffName.slice(0, 100),
        method: dto.paidMethod,
        reference,
        status: selfApproved ? 'approved' : 'recorded',
        recordedBy: userId,
        receipt: null,
        selfApproved,
      },
      new Date(),
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'expense.recorded',
      subjectType: 'expense',
      subjectId: expense.id,
      metadata: {
        expenseNo: expense.expenseNo,
        amount: expense.amount,
        category: expense.category,
        recordedBy: userId.toString(),
        method: expense.method,
        status: expense.status,
        selfApproved,
        threshold,
        hasReceipt: false,
        source: 'salary_advance',
      },
    });
    return expense.id;
  }

  /** POST /salary-advances/:id/write-off: the principal, never for their own advance (R215). */
  @Transactional()
  async writeOff(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<AdvanceDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (session.access.staffId === row.staffId) throw ownAdvance();
    if (row.status !== 'open') throw advanceNotOpen(id);
    if ((await this.advances.writeOff(schoolId, id, userId, new Date(), dto.reason)) === 0) throw advanceNotOpen(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'salary_advance.written_off',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        staffId: row.staffId.toString(),
        amount: row.amount,
        recoveredAmount: row.recoveredAmount,
        writtenOff: row.amount - row.recoveredAmount,
      },
    });
    return this.get(id);
  }

  private async require(schoolId: SchoolId, id: bigint) {
    const row = await this.advances.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }
}
