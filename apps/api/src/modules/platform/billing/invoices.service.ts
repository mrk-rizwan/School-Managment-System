import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { toPage, type Page } from '../../../common/pagination';
import { todayIn } from '../../../common/school-clock';
import { InvoiceRepository, type InvoiceRecord } from '../../../repositories/platform/invoice.repository';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { PlatformPaymentRepository } from '../../../repositories/platform/platform-payment.repository';
import { BillingRunService } from './billing-run.service';
import type {
  InvoiceDto,
  IssueMonthResultDto,
  ListInvoicesQueryDto,
  RecordPlatformPaymentDto,
} from './billing.dto';
import { fromDateString, PLATFORM_TIMEZONE, toDateString, toInvoiceDto } from './billing.mappers';

const SUBJECT = 'platform_invoice';

const notIssued = (invoice: InvoiceRecord) =>
  new ApiException(409, ErrorCode.INVOICE_NOT_ISSUED, `The invoice is ${invoice.status}.`, {
    invoiceId: invoice.id.toString(),
    status: invoice.status,
  });

/**
 * Platform invoices (R220, R221): the list with the suspension-eligibility filter, a hand-recorded
 * full payment (A11: no gateway, no partial payment), a void, and the monthly run on demand. A
 * voided month is issued again (a new number) by the next run for that month.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly payments: PlatformPaymentRepository,
    private readonly audit: PlatformAuditRepository,
    private readonly run: BillingRunService,
  ) {}

  async list(query: ListInvoicesQueryDto): Promise<Page<InvoiceDto>> {
    const { rows, total } = await this.invoices.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.schoolId === undefined ? {} : { schoolId: BigInt(query.schoolId) }),
      ...(query.yearMonth === undefined ? {} : { yearMonth: query.yearMonth }),
      ...(query.suspensionEligible === undefined ? {} : { suspensionEligible: query.suspensionEligible }),
      sort: query.sort ?? '-issuedAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toInvoiceDto), query, total);
  }

  async get(id: bigint): Promise<InvoiceDto> {
    return toInvoiceDto(await this.require(id));
  }

  /**
   * Full amount only: `amount` must equal the invoice's. issued -> paid with the payment row in
   * one transaction; a paid or void invoice is 409 INVOICE_NOT_ISSUED (not replayable).
   */
  @Transactional()
  async recordPayment(actorId: bigint, id: bigint, dto: RecordPlatformPaymentDto, now: Date = new Date()): Promise<InvoiceDto> {
    const invoice = await this.require(id);
    if (invoice.status !== 'issued') throw notIssued(invoice);
    if (dto.amount !== invoice.amount) {
      throw fieldRefused('amount', ErrorCode.INVALID_VALUE, `amount must be the invoice amount, ${invoice.amount}`);
    }
    if (dto.receivedOn > toDateString(todayIn(PLATFORM_TIMEZONE, now))) {
      throw fieldRefused('receivedOn', ErrorCode.INVALID_VALUE, 'receivedOn must not be in the future');
    }
    if ((await this.invoices.markPaid(id, now)) === 0) throw notIssued(await this.require(id));
    const payment = await this.payments.create({
      invoiceId: id,
      amount: dto.amount,
      receivedOn: fromDateString(dto.receivedOn),
      reference: dto.reference,
      recordedBy: actorId,
    });
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: invoice.schoolId,
      action: 'platform_invoice.paid',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        invoiceNo: invoice.invoiceNo,
        amount: payment.amount,
        receivedOn: dto.receivedOn,
        reference: payment.reference,
        paymentId: payment.id.toString(),
      },
    });
    return toInvoiceDto(await this.require(id));
  }

  /** issued -> void, with a reason; a paid or void invoice is 409 INVOICE_NOT_ISSUED. */
  @Transactional()
  async void(actorId: bigint, id: bigint, reason: string): Promise<InvoiceDto> {
    const invoice = await this.require(id);
    if (invoice.status !== 'issued') throw notIssued(invoice);
    if ((await this.invoices.void(id, actorId, reason)) === 0) throw notIssued(await this.require(id));
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: invoice.schoolId,
      action: 'platform_invoice.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason,
      metadata: { invoiceNo: invoice.invoiceNo, yearMonth: invoice.yearMonth, amount: invoice.amount },
    });
    return toInvoiceDto(await this.require(id));
  }

  /** The monthly run on demand (idempotent); a month later than the current one is 422. */
  async issueMonth(actorId: bigint, yearMonth: string, now: Date = new Date()): Promise<IssueMonthResultDto> {
    if (yearMonth > toDateString(todayIn(PLATFORM_TIMEZONE, now)).slice(0, 7)) {
      throw fieldRefused('yearMonth', ErrorCode.INVALID_VALUE, 'yearMonth must not be later than the current month');
    }
    const result = await this.run.issueMonth(yearMonth, actorId, now);
    return {
      issued: result.issued,
      existing: result.existing,
      skipped: result.skipped.map((s) => ({ schoolId: s.schoolId.toString(), reason: s.reason })),
      failed: result.failed,
    };
  }

  private async require(id: bigint): Promise<InvoiceRecord> {
    const invoice = await this.invoices.findById(id);
    if (!invoice) throw notFound();
    return invoice;
  }
}
