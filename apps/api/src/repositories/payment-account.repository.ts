import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PaymentAccountKind, PaymentAccountStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface PaymentAccountRecord {
  id: bigint;
  kind: PaymentAccountKind;
  title: string;
  accountNo: string;
  bankName: string | null;
  status: PaymentAccountStatus;
  disabledAt: Date | null;
  disableReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  kind: true,
  title: true,
  accountNo: true,
  bankName: true,
  status: true,
  disabledAt: true,
  disableReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SchoolPaymentAccountSelect;

/**
 * Where guardians can pay (tenant table school_payment_accounts, rule 21). Never edited in place
 * and never deleted; disabling is final. An active row turns the deposit-claim flow on.
 */
@Injectable()
export class PaymentAccountRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: { status?: PaymentAccountStatus; skip: number; take: number },
  ): Promise<{ rows: PaymentAccountRecord[]; total: number }> {
    const where: Prisma.SchoolPaymentAccountWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const rows = await this.txHost.tx.schoolPaymentAccount.findMany({
      where,
      select: SELECT,
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.schoolPaymentAccount.count({ where });
    return { rows, total };
  }

  findById(schoolId: SchoolId, id: bigint): Promise<PaymentAccountRecord | null> {
    return this.txHost.tx.schoolPaymentAccount.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** Whether the school accepts deposit claims (rule 21, R196): any active account. */
  async anyActive(schoolId: SchoolId): Promise<boolean> {
    const row = await this.txHost.tx.schoolPaymentAccount.findFirst({
      where: { schoolId, status: 'active' },
      select: { id: true },
    });
    return row !== null;
  }

  create(
    schoolId: SchoolId,
    data: { kind: PaymentAccountKind; title: string; accountNo: string; bankName: string | null; createdBy: bigint },
  ): Promise<PaymentAccountRecord> {
    return this.txHost.tx.schoolPaymentAccount.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /** Disables an active account; 0 when it was not active (already disabled, or changed). */
  async disable(schoolId: SchoolId, id: bigint, by: bigint, reason: string): Promise<number> {
    const { count } = await this.txHost.tx.schoolPaymentAccount.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'disabled', disabledAt: new Date(), disabledBy: by, disableReason: reason },
    });
    return count;
  }
}
