import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { NotificationService } from '../messaging/notification.service';
import { MessageRecipientRepository } from '../repositories/message-recipient.repository';
// A18: the school's own platform invoices, read with its SchoolId (school_id = schoolId only).
// eslint.config.mjs names this file and the billing-status controller as the only importers.
import { OwnInvoicesRepository, type OwnInvoiceRecord } from '../repositories/own-invoices.repository';
import type { SchoolId } from '../tenancy/school-id';

/** The three notices an invoice can give, each its own subject (R107 is one row per subject). */
const STAGE = { issued: 1n, overdue: 2n, eligible: 3n } as const;

/**
 * `messages.subject_id` of an invoice notice: `invoiceId * 10 + stage`, so the issued, overdue and
 * eligibility notices of one invoice are three subjects and each is sent once per principal.
 */
export const invoiceNoticeSubjectId = (invoiceId: bigint, stage: keyof typeof STAGE): bigint =>
  invoiceId * 10n + STAGE[stage];

/**
 * The per-school body of `billing-notices` (daily 09:30, phase-3-financial.md §3.7, A18): for each
 * unpaid platform invoice, platform_invoice_issued to the school's principals, then
 * platform_invoice_overdue once it is overdue and once more when it is eligible for suspension.
 * Idempotent: each notice is one subject (R107), so a daily re-run writes nothing new. A paid or
 * void invoice gives no further notice.
 */
@Injectable()
export class BillingNotices {
  constructor(
    private readonly invoices: OwnInvoicesRepository,
    private readonly people: MessageRecipientRepository,
    private readonly notifications: NotificationService,
  ) {}

  @Transactional()
  async run(schoolId: SchoolId): Promise<number> {
    const unpaid = await this.invoices.unpaid(schoolId);
    if (unpaid.length === 0) return 0;
    const principals = await this.people.activePrincipalStaffIds(schoolId);
    if (principals.length === 0) return 0;
    const recipients = principals.map((staffId) => ({ staffId }));
    let created = 0;
    for (const invoice of unpaid) {
      created += await this.notice(schoolId, invoice, recipients);
    }
    return created;
  }

  private async notice(
    schoolId: SchoolId,
    invoice: OwnInvoiceRecord,
    recipients: readonly { staffId: bigint }[],
  ): Promise<number> {
    const base = { invoiceNo: invoice.invoiceNo, yearMonth: invoice.yearMonth, dueOn: invoice.dueOn };
    let created = (
      await this.notifications.send(schoolId, {
        type: 'platform_invoice_issued',
        subject: { type: 'platform_invoice', id: invoiceNoticeSubjectId(invoice.id, 'issued') },
        recipients,
        vars: base,
      })
    ).created;
    if (invoice.overdueAt !== null) {
      created += (
        await this.notifications.send(schoolId, {
          type: 'platform_invoice_overdue',
          subject: { type: 'platform_invoice', id: invoiceNoticeSubjectId(invoice.id, 'overdue') },
          recipients,
          vars: { ...base, suspensionEligible: false },
        })
      ).created;
    }
    if (invoice.suspensionEligibleAt !== null) {
      created += (
        await this.notifications.send(schoolId, {
          type: 'platform_invoice_overdue',
          subject: { type: 'platform_invoice', id: invoiceNoticeSubjectId(invoice.id, 'eligible') },
          recipients,
          vars: { ...base, suspensionEligible: true },
        })
      ).created;
    }
    return created;
  }
}

/** The notices job with its repository, so only this file (and the controller) imports it. */
export const BILLING_NOTICES_PROVIDERS = [BillingNotices, OwnInvoicesRepository];
