// contracts/slice-19.md §6: slice 19's templates. fee_charged is SMS-eligible, so it fits one
// GSM-7 segment with the longest fixtures (R110), names the school first, and keeps the amount
// (WhatsApp and SMS, R238); its push title carries none. The concession notices carry no amount.
import { MAX_RUPEES } from '@asms/shared';
import { renderMessage, schoolLabel, smsSegments, toGsm7 } from '../../messaging/templates';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const ctx = (subjectType: 'charge_run' | 'concession') => ({ schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType });

describe('slice 19 message templates', () => {
  it('fee_charged: one segment with the longest fixtures, the school first, the family total, children cut to fit', () => {
    const rendered = renderMessage(
      'fee_charged',
      {
        label: 'Annual sports, science fair and trip fee for the senior school',
        total: MAX_RUPEES,
        children: [NAME40, NAME40, NAME40, NAME40],
        dueOn: new Date('2026-12-10T00:00:00.000Z'),
      },
      ctx('charge_run'),
    );
    expect(rendered.title).toBe('Fees charged');
    expect(rendered.body.startsWith(schoolLabel(SCHOOL))).toBe(true);
    expect(rendered.body).toContain('Rs 10,000,000');
    expect(rendered.body).toContain('Due Thu 10 Dec.');
    expect(smsSegments(toGsm7(rendered.body))).toBe(1);
    expect(rendered.title).not.toMatch(/[0-9]/);
  });

  it('fee_charged: a short family reads in full', () => {
    const { body } = renderMessage(
      'fee_charged',
      { label: 'October 2026 fees', total: 6500, children: ['Ali Raza', 'Sara Raza'], dueOn: new Date('2026-10-10T00:00:00.000Z') },
      { ...ctx('charge_run'), schoolName: 'Iqra Model School' },
    );
    expect(body).toBe('Iqra Model School: October 2026 fees: Rs 6,500 for Ali Raza, Sara Raza. Due Sat 10 Oct.');
  });

  it('concession notices name the student and the decision, never an amount', () => {
    const requested = renderMessage('concession_requested', { studentName: NAME40, requesterName: 'Office Clerk' }, ctx('concession'));
    expect([requested.title, requested.body]).toEqual([
      'Concession to decide',
      `${schoolLabel(SCHOOL)}: A fee concession for ${NAME40} was requested by Office Clerk. Open ASMS to decide.`,
    ]);
    for (const decision of ['approved', 'rejected', 'ended'] as const) {
      const decided = renderMessage('concession_decided', { studentName: 'Ali Raza', decision }, ctx('concession'));
      expect(decided.body).toBe(`${schoolLabel(SCHOOL)}: The fee concession you requested for Ali Raza was ${decision}.`);
      expect(decided.body).not.toMatch(/Rs /);
    }
  });
});
