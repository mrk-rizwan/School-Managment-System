// R238 guardrail (phase close, security low): no rupee figure ever reaches a lock screen. Every
// money-related message type is rendered with amount-bearing values, and the push body the
// processor would send (pushBodyOf) must hold no amount. The family money types carry the amount
// in WhatsApp and SMS, so they are title-only pushes; the staff and platform money types (expense,
// handover, concession, payslip, invoice) carry no amount in any body, which this test also holds,
// so they need not be title-only. A new money type that puts an amount in its body without joining
// TITLE_ONLY_PUSH fails here once it is added to this list.
import type { MessageType } from '@asms/shared';
import { pushBodyOf } from './message-processor';
import { renderMessage } from './templates';
import type { TemplateVarsMap } from './types';

const AMOUNT = 987654;
const MONEY = /987,?654|Rs\s?[0-9]/;
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const CHILDREN = ['Hamza Tariq', 'Hira Tariq'];
const ctx = { schoolName: 'Iqra Model School', timezone: 'Asia/Karachi', subjectType: 'charge_run' as const };

const render = <T extends MessageType>(type: T, vars: TemplateVarsMap[T]) => {
  const { title, body } = renderMessage(type, vars, ctx);
  return { type, title, body, push: pushBodyOf(type, title, body) };
};

const FAMILY = [
  render('fee_charged', { label: 'October 2026 fees', total: AMOUNT, children: CHILDREN, dueOn: D('2026-10-10') }),
  render('fee_due_reminder', { total: AMOUNT, children: CHILDREN, dueOn: D('2026-10-10') }),
  render('fee_overdue', { overdue: AMOUNT, children: CHILDREN, since: D('2026-09-10') }),
  render('receipt_issued', { receiptLabel: '12/2026-27', amount: AMOUNT, children: CHILDREN, yearName: '2026-27', balance: AMOUNT }),
  render('payment_claim_rejected', { studentName: 'Hamza Tariq', amount: AMOUNT, paidOn: D('2026-10-01'), reason: 'The slip is not readable' }),
];
const STAFF_AND_PLATFORM = [
  render('payment_claim_submitted', { studentName: 'Hamza Tariq' }),
  render('handover_shortfall', { collectorName: 'Bilal Ahmed' }),
  render('reminder_sms_capped', { families: 12 }),
  render('concession_requested', { studentName: 'Hamza Tariq', requesterName: 'Bilal Ahmed' }),
  render('concession_decided', { studentName: 'Hamza Tariq', decision: 'approved' }),
  render('expense_approval_requested', { expenseNo: 41, category: 'electricity', recorderName: 'Bilal Ahmed' }),
  render('expense_decided', { expenseNo: 41, decision: 'approved' }),
  render('payslip_ready', { yearMonth: '2026-09' }),
  render('platform_invoice_issued', { invoiceNo: 'INV-2026-10-0007', yearMonth: '2026-10', dueOn: D('2026-10-10') }),
  render('platform_invoice_overdue', { invoiceNo: 'INV-2026-10-0007', yearMonth: '2026-10', dueOn: D('2026-10-10'), suspensionEligible: true }),
];

describe('R238: a push body never carries a rupee figure', () => {
  it.each([...FAMILY, ...STAFF_AND_PLATFORM].map((r) => [r.type, r] as const))('%s', (_type, r) => {
    expect(r.push).not.toMatch(MONEY);
    expect(r.title).not.toMatch(MONEY);
  });

  it('the family money types keep the amount in the body (WhatsApp and SMS) and push the title only', () => {
    for (const r of FAMILY) {
      expect(r.body).toMatch(MONEY);
      expect(r.push).toBe(r.title);
    }
  });
});
