// contracts/slice-22.md §3, §4: the reminder templates (one GSM-7 segment with the longest
// fixtures, R110; the school first; the amount kept for WhatsApp and SMS, never in the title, R238)
// and the SMS budget that narrows the plans once the month's allowance is spent (R250).
import { MAX_RUPEES } from '@asms/shared';
import type { PlannedSend } from '../../messaging/notification.service';
import { renderMessage, schoolLabel, smsSegments, toGsm7 } from '../../messaging/templates';
import { fitSmsBudget } from './fee-reminders';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const ctx = { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType: 'fee_reminder' as const };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('slice 22 message templates', () => {
  it('fee_due_reminder: one segment with the longest fixtures, the school first, the total, children cut to fit', () => {
    const rendered = renderMessage(
      'fee_due_reminder',
      { total: MAX_RUPEES, children: [NAME40, NAME40, NAME40, NAME40], dueOn: day('2026-12-10') },
      ctx,
    );
    expect(rendered.title).toBe('Fee reminder');
    expect(rendered.body.startsWith(schoolLabel(SCHOOL))).toBe(true);
    expect(rendered.body).toContain('Rs 10,000,000');
    expect(rendered.body).toContain('is due Thu 10 Dec.');
    expect(smsSegments(toGsm7(rendered.body))).toBe(1);
  });

  it('fee_overdue: one segment with the longest fixtures', () => {
    const rendered = renderMessage(
      'fee_overdue',
      { overdue: MAX_RUPEES, children: [NAME40, NAME40, NAME40], since: day('2026-08-10') },
      ctx,
    );
    expect(rendered.title).toBe('Fees overdue');
    expect(rendered.body).toContain('unpaid since Mon 10 Aug.');
    expect(smsSegments(toGsm7(rendered.body))).toBe(1);
  });

  it('a short family reads in full', () => {
    const short = { ...ctx, schoolName: 'Iqra Model School' };
    expect(renderMessage('fee_due_reminder', { total: 6000, children: ['Ali Raza', 'Sara Raza'], dueOn: day('2026-10-10') }, short).body).toBe(
      'Iqra Model School: Fee reminder: Rs 6,000 for Ali Raza, Sara Raza is due Sat 10 Oct. Please pay at the school office.',
    );
    expect(renderMessage('fee_overdue', { overdue: 3000, children: ['Ali Raza'], since: day('2026-08-10') }, short).body).toBe(
      'Iqra Model School: Fees overdue: Rs 3,000 for Ali Raza, unpaid since Mon 10 Aug. Please pay at the school office.',
    );
  });

  it('reminder_sms_capped: a count of families, no amount', () => {
    const rendered = renderMessage('reminder_sms_capped', { families: 1 }, ctx);
    expect(rendered.title).toBe('Reminder SMS capped');
    expect(rendered.body).toContain("1 family could not be reminded by SMS because this month's SMS allowance is used up.");
    expect(rendered.body).not.toMatch(/Rs /);
    // One segment even with the longest school label and a four-digit count.
    const long = renderMessage('reminder_sms_capped', { families: 2000 }, { ...ctx, schoolName: 'X'.repeat(40) });
    expect(smsSegments(long.body)).toBe(1);
  });
});

describe('R250: fitSmsBudget', () => {
  const planned = (legs: PlannedSend['plans'][number]['legs'][]): PlannedSend => ({
    priority: 'normal',
    people: [],
    plans: legs.map((l) => ({ legs: l, suppressed: [] })),
    smsAllowed: true,
    whatsappConnected: true,
    dedupedByPhone: 0,
  });

  it('spends one unit per always-SMS family in order; past the allowance the SMS legs are dropped', () => {
    const plan = planned([['sms'], ['push', 'in_app', 'sms'], ['whatsapp', 'push', 'in_app', 'sms'], ['sms'], ['push', 'in_app', 'sms']]);
    const budget = { remaining: 2 };
    expect(fitSmsBudget(plan, budget)).toEqual({ units: 2, capped: 3 });
    expect(budget.remaining).toBe(0);
    expect(plan.plans.map((p) => p.legs)).toEqual([
      ['sms'],
      ['push', 'in_app', 'sms'],
      // Once none remain, the after-failure leg goes too.
      ['whatsapp', 'push', 'in_app'],
      [],
      ['push', 'in_app'],
    ]);
    // A keypad family left with nothing is suppressed cap_reached; one keeping push is not.
    expect(plan.plans[3]?.suppressed).toEqual([{ channel: 'sms', reason: 'cap_reached' }]);
    expect(plan.plans[4]?.suppressed).toEqual([]);
  });

  it('an after-failure SMS leg is kept, without spending, while units remain', () => {
    const plan = planned([['whatsapp', 'push', 'in_app', 'sms'], ['sms']]);
    expect(fitSmsBudget(plan, { remaining: 1 })).toEqual({ units: 1, capped: 0 });
    expect(plan.plans.map((p) => p.legs)).toEqual([['whatsapp', 'push', 'in_app', 'sms'], ['sms']]);
  });
});
