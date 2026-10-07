// The receipt's print view (phase-3-financial.md §3.5, R190, R237): a scriptless, auto-escaped
// page sent only through sendPrintView. Every value comes from the receipt's snapshot and the
// payment; nothing is a link.
import { formatRupees, PAYMENT_METHOD_LABELS } from '@asms/shared';
import { html, printPage, type SafeHtml } from '../../common/print-view';
import type { PaymentDto, ReceiptDto } from './payments.dto';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (period: string): string =>
  new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`));

export function receiptPage(schoolName: string, receipt: ReceiptDto, payment: PaymentDto, timezone: string): SafeHtml {
  const issued = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(receipt.issuedAt);
  const lines = receipt.lines.map(
    (line) => html`<tr>
  <td>${line.studentName}</td>
  <td>${line.chargeId === null ? 'Advance (kept for later fees)' : line.feeHeadName}</td>
  <td>${line.period === null ? '' : monthName(line.period)}</td>
  <td class="amount">${formatRupees(line.amount)}</td>
</tr>`,
  );
  const body = html`<h1>${schoolName}</h1>
<h2>Fee receipt ${receipt.receiptLabel}</h2>
${receipt.voidedAt === null ? html`` : html`<p><strong>VOIDED</strong> on ${DAY.format(receipt.voidedAt)}. This receipt is no longer valid.</p>`}
<table>
  <tr><th>Received on</th><td>${DAY.format(new Date(`${payment.receivedOn}T00:00:00Z`))}</td></tr>
  <tr><th>Received from</th><td>${payment.payerName}</td></tr>
  <tr><th>Method</th><td>${PAYMENT_METHOD_LABELS[payment.method]}${payment.reference === null ? '' : `, reference ${payment.reference}`}</td></tr>
  <tr><th>Issued</th><td>${issued} by ${receipt.issuedByName}</td></tr>
</table>
<h3>Paid towards</h3>
<table>
  <tr><th>Student</th><th>Fee</th><th>Month</th><th class="amount">Amount</th></tr>
  ${lines}
  <tr><th colspan="3">Total</th><th class="amount">${formatRupees(receipt.amount)}</th></tr>
</table>`;
  return printPage(`Receipt ${receipt.receiptLabel}`, body);
}
