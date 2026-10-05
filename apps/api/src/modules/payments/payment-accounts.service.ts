import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  PaymentAccountRepository,
  type PaymentAccountRecord,
} from '../../repositories/payment-account.repository';
import { requirePrincipal } from '../access/money-gates';
import type { ReasonDto } from '../fees/fees.dto';
import type {
  CreatePaymentAccountDto,
  ListPaymentAccountsQueryDto,
  MyPaymentAccountDto,
  PaymentAccountDto,
} from './payment-accounts.dto';

const SUBJECT = 'payment_account';

export function toPaymentAccountDto(row: PaymentAccountRecord): PaymentAccountDto {
  return {
    id: row.id.toString(),
    kind: row.kind,
    title: row.title,
    accountNo: row.accountNo,
    bankName: row.bankName,
    status: row.status,
    disabledAt: row.disabledAt,
    disableReason: row.disableReason,
    createdAt: row.createdAt,
  };
}

const toMyDto = (row: PaymentAccountRecord): MyPaymentAccountDto => ({
  id: row.id.toString(),
  kind: row.kind,
  title: row.title,
  accountNo: row.accountNo,
  bankName: row.bankName,
});

/**
 * The account's last four characters, for the audit row: the full number never enters the log
 * (a long account number can hold a 13-digit run, which audit_log refuses).
 */
const ending = (accountNo: string): string => accountNo.slice(-4);

/** Where parents pay besides the counter (rule 21). Writes are payee changes: principal only. */
@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly accounts: PaymentAccountRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(query: ListPaymentAccountsQueryDto): Promise<Page<PaymentAccountDto>> {
    const { rows, total } = await this.accounts.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toPaymentAccountDto), query, total);
  }

  async get(id: bigint): Promise<PaymentAccountDto> {
    const row = await this.accounts.findById(this.context.schoolId, id);
    if (!row) throw notFound();
    return toPaymentAccountDto(row);
  }

  /** GET /me/payment-accounts: the active accounts, for a guardian deciding where to pay. */
  async listActive(query: PageQueryDto): Promise<Page<MyPaymentAccountDto>> {
    const { rows, total } = await this.accounts.list(this.context.schoolId, {
      status: 'active',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toMyDto), query, total);
  }

  @Transactional()
  async create(session: SchoolSessionContext, dto: CreatePaymentAccountDto): Promise<PaymentAccountDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    if (dto.bankName !== undefined && dto.kind !== 'bank') {
      throw fieldRefused('bankName', ErrorCode.INVALID_VALUE, 'bankName is for bank accounts only');
    }
    const row = await this.accounts.create(schoolId, {
      kind: dto.kind,
      title: dto.title,
      accountNo: dto.accountNo,
      bankName: dto.bankName ?? null,
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_account.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { kind: row.kind, title: row.title, accountNoEnding: ending(row.accountNo) },
    });
    return toPaymentAccountDto(row);
  }

  /** Final. Repeating it changes nothing and writes no row. */
  @Transactional()
  async disable(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<PaymentAccountDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.accounts.findById(schoolId, id);
    if (!row) throw notFound();
    if ((await this.accounts.disable(schoolId, id, userId, dto.reason)) === 0) {
      return toPaymentAccountDto((await this.accounts.findById(schoolId, id)) ?? row);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_account.disabled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { kind: row.kind, accountNoEnding: ending(row.accountNo) },
    });
    const updated = await this.accounts.findById(schoolId, id);
    if (!updated) throw notFound();
    return toPaymentAccountDto(updated);
  }
}
