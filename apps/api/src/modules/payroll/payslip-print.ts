// The payslip print view (phase-3-financial.md §3.5, R237): built with the escaping `html` tag and
// sent only through sendPrintView. Names, components and reasons are the school's text, printed as
// text whatever they hold.
import { formatRupees, monthLabel } from '@asms/shared';
import { html, printPage, type SafeHtml } from '../../common/print-view';
import type { PayslipDto } from './payroll.dto';
import { shortDay } from './payslip-compute';

const row = (label: string, amount: string): SafeHtml =>
  html`<tr><td>${label}</td><td class="amount">${amount}</td></tr>`;

const signed = (amount: number): string => (amount < 0 ? `- ${formatRupees(-amount)}` : formatRupees(amount));

export function payslipPage(schoolName: string, slip: PayslipDto): SafeHtml {
  const earnings = [
    row(`Basic (${slip.employedWorkingDays} of ${slip.workingDays} working days)`, formatRupees(slip.basic)),
    ...slip.lines.filter((l) => l.kind === 'allowance').map((l) => row(l.name, formatRupees(l.amount))),
  ];
  const deductions = slip.lines
    .filter((l) => l.kind === 'deduction' || l.kind === 'absence' || l.kind === 'advance_recovery')
    .map((l) => row(l.name, formatRupees(l.amount)));
  const adjustments = slip.lines.filter((l) => l.kind === 'adjustment').map((l) => row(l.name, signed(l.amount)));
  const notTaken = slip.deductionsNotTaken.map((d) => html`<li>${d.name}: ${formatRupees(d.amount)} not deducted this month</li>`);
  const paid =
    slip.status === 'paid' && slip.paidOn !== null
      ? html`<p>Paid on ${shortDay(slip.paidOn)}${slip.paidMethod === null ? '' : `, ${slip.paidMethod.replaceAll('_', ' ')}`}${slip.paidReference === null ? '' : `, reference ${slip.paidReference}`}.</p>`
      : html`<p>Not yet paid.</p>`;
  const body = html`<h1>${schoolName}</h1>
<h2>Payslip, ${monthLabel(slip.yearMonth)}</h2>
<p><strong>${slip.staffName}</strong>${slip.designation === null ? '' : `, ${slip.designation}`}</p>
<p>Unpaid days: ${slip.unpaidDays}. Unmarked days: ${slip.unmarkedDays}.</p>
<h3>Earnings</h3>
<table>${earnings}</table>
<h3>Deductions</h3>
<table>${deductions.length > 0 ? deductions : [row('None', formatRupees(0))]}</table>
${adjustments.length > 0 ? html`<h3>Adjustments</h3><table>${adjustments}</table>` : ''}
${notTaken.length > 0 ? html`<ul>${notTaken}</ul>` : ''}
<table>${row('Net pay', formatRupees(slip.net))}</table>
${paid}`;
  return printPage(`Payslip ${monthLabel(slip.yearMonth)}, ${slip.staffName}`, body);
}
