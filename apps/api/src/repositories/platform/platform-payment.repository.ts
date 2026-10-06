import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PrismaTxAdapter } from '../prisma';

// platform_payments (non-tenant, append-only): the full payment of one invoice, recorded by hand
// (A11: no gateway, no partial payment; one row per invoice, platform_payments_invoice_id_key).
// Importable only from src/modules/platform/billing/** and src/jobs/platform-billing.ts.

export interface PlatformPaymentRecord {
  id: bigint;
  invoiceId: bigint;
  amount: number;
  receivedOn: Date;
  reference: string;
  recordedBy: bigint;
  createdAt: Date;
}

const SELECT = {
  id: true,
  invoiceId: true,
  amount: true,
  receivedOn: true,
  reference: true,
  recordedBy: true,
  createdAt: true,
} as const;

@Injectable()
export class PlatformPaymentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(data: {
    invoiceId: bigint;
    amount: number;
    receivedOn: Date;
    reference: string;
    recordedBy: bigint;
  }): Promise<PlatformPaymentRecord> {
    return this.txHost.tx.platformPayment.create({ data, select: SELECT });
  }

  findByInvoice(invoiceId: bigint): Promise<PlatformPaymentRecord | null> {
    return this.txHost.tx.platformPayment.findFirst({ where: { invoiceId }, select: SELECT });
  }
}
