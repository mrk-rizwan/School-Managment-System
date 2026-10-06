// contracts/slice-20.md §6: slice 20's templates. receipt_issued is SMS-allowed, so it fits one
// GSM-7 segment with the longest fixtures (R110), names the school first and keeps the amounts
// (WhatsApp and SMS); its push title carries none (R238). handover_shortfall carries no amount.
import { MAX_RUPEES } from '@asms/shared';
import { renderMessage, schoolLabel, smsSegments, toGsm7 } from '../../messaging/templates';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const YEAR100 = 'Session 2026-2027 for the senior and junior schools, April intake, morning and evening shifts both';
const ctx = (subjectType: 'receipt' | 'cash_handover') => ({ schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType });

describe('slice 20 message templates', () => {
  it('receipt_issued: one segment with the longest fixtures, the school first, both amounts, no link', () => {
    const rendered = renderMessage(
      'receipt_issued',
      { receiptLabel: `99999/${YEAR100}`, amount: MAX_RUPEES, children: [NAME40, NAME40, NAME40], yearName: YEAR100, balance: MAX_RUPEES },
      ctx('receipt'),
    );
    expect(rendered.title).toBe('Fee receipt');
    expect(rendered.body.startsWith(schoolLabel(SCHOOL))).toBe(true);
    expect(rendered.body.match(/Rs 10,000,000/g)?.length).toBe(2);
    expect(smsSegments(toGsm7(rendered.body))).toBe(1);
    expect(rendered.body).not.toMatch(/https?:|www\./);
  });

  it('receipt_issued: a short family reads in full', () => {
    const { body } = renderMessage(
      'receipt_issued',
      { receiptLabel: '17/2026-27', amount: 6500, children: ['Ali Raza', 'Sara Raza'], yearName: '2026-27', balance: 0 },
      { ...ctx('receipt'), schoolName: 'Iqra Model School' },
    );
    expect(body).toBe('Iqra Model School: Receipt 17/2026-27: Rs 6,500 received for Ali Raza, Sara Raza. Balance for 2026-27: Rs 0.');
  });

  it('handover_shortfall names the collector, never an amount', () => {
    const rendered = renderMessage('handover_shortfall', { collectorName: 'Office Clerk' }, ctx('cash_handover'));
    expect([rendered.title, rendered.body]).toEqual([
      'Cash handover short',
      `${schoolLabel(SCHOOL)}: A cash handover from Office Clerk was counted short. Open ASMS to resolve it.`,
    ]);
  });
});
