// contracts/slice-21.md §5: slice 21's templates. payment_claim_rejected is SMS-allowed, so it fits
// one GSM-7 segment with the longest fixtures (R110), names the school first, keeps the amount and
// as much of the office's reason as fits; its push title carries none (R238).
// payment_claim_submitted is internal and carries no amount.
import { MAX_RUPEES } from '@asms/shared';
import { renderMessage, schoolLabel, smsSegments, toGsm7 } from '../../messaging/templates';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const REASON500 = 'The slip shows a different account number. '.repeat(12).trim();
const ctx = { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType: 'payment_claim' as const };
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('slice 21 message templates', () => {
  it('payment_claim_rejected: one segment with the longest fixtures, the school first, the amount, no link', () => {
    const rendered = renderMessage(
      'payment_claim_rejected',
      { studentName: NAME40, amount: MAX_RUPEES, paidOn: day('2026-10-05'), reason: REASON500 },
      ctx,
    );
    expect(rendered.title).toBe('Deposit slip not accepted');
    expect(rendered.body.startsWith(schoolLabel(SCHOOL))).toBe(true);
    expect(rendered.body).toContain('Rs 10,000,000');
    expect(rendered.body.endsWith('...')).toBe(true);
    expect(smsSegments(toGsm7(rendered.body))).toBe(1);
    expect(rendered.body).not.toMatch(/https?:|www\./);
  });

  it('payment_claim_rejected: a short reason reads in full', () => {
    const { body } = renderMessage(
      'payment_claim_rejected',
      { studentName: 'Ali Raza', amount: 6500, paidOn: day('2026-10-05'), reason: 'The slip is unreadable.' },
      { ...ctx, schoolName: 'Iqra Model School' },
    );
    expect(body).toBe('Iqra Model School: Deposit slip for Ali Raza (Rs 6,500, Mon 5 Oct) not accepted: The slip is unreadable.');
  });

  it('payment_claim_submitted names the child, never an amount', () => {
    const rendered = renderMessage('payment_claim_submitted', { studentName: 'Ali Raza' }, ctx);
    expect([rendered.title, rendered.body]).toEqual([
      'Deposit slip to verify',
      `${schoolLabel(SCHOOL)}: A deposit slip for Ali Raza is waiting to be verified. Open ASMS to check it.`,
    ]);
  });
});
