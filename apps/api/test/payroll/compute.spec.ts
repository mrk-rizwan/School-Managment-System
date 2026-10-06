// computePayslip as a table (phase-3-financial.md §3.3, R245-R247): the matrix of R245 one case per
// row, pro-rating (R246), working_days = 0, the deduction order and its shortfall, recoveries in
// grant order stopping before net goes negative, and payslipNet's refusal.
import type { StaffAttendanceStatus } from '@asms/shared';
import { computePayslip, emptyPayslip, type ComputedPayslip, type PayslipInput } from '../../src/modules/payroll/payslip-compute';

/** Ten working days, 1-10 June 2026 (no weekly off in this table). */
const DAYS = Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);

const base = (over: Partial<PayslipInput> = {}): PayslipInput => ({
  monthWorkingDays: DAYS,
  window: { from: DAYS[0] ?? '', to: DAYS[9] ?? '' },
  structure: { id: 1n, basic: 10_000, components: [] },
  marks: new Map(DAYS.map((d) => [d, 'present'])),
  leave: [],
  advances: [],
  adjustment: 0,
  ...over,
});

const ok = (input: PayslipInput): ComputedPayslip => {
  const out = computePayslip(input);
  if ('refused' in out) throw new Error('refused');
  return out;
};

const DAY = '2026-06-05';
const marksWith = (status: StaffAttendanceStatus | undefined) => {
  const m = new Map<string, StaffAttendanceStatus>(DAYS.map((d) => [d, 'present']));
  if (status === undefined) m.delete(DAY);
  else m.set(DAY, status);
  return m;
};
const leaveOf = (kind: 'none' | 'paid' | 'unpaid') =>
  kind === 'none' ? [] : [{ startsOn: DAY, endsOn: DAY, paid: kind === 'paid' }];

describe('computePayslip (R245-R247)', () => {
  // [mark, leave, unpaid, unmarked, listed as unapproved leave]
  const MATRIX: [StaffAttendanceStatus | undefined, 'none' | 'paid' | 'unpaid', number, number, boolean][] = [
    ['present', 'none', 0, 0, false],
    ['present', 'paid', 0, 0, false],
    ['present', 'unpaid', 0, 0, false],
    ['late', 'unpaid', 0, 0, false],
    ['absent', 'none', 1, 0, false],
    ['absent', 'paid', 0, 0, false],
    ['absent', 'unpaid', 1, 0, false],
    ['on_leave', 'none', 1, 0, true],
    ['on_leave', 'paid', 0, 0, false],
    ['on_leave', 'unpaid', 1, 0, false],
    [undefined, 'none', 0, 1, false],
    [undefined, 'paid', 0, 0, false],
    [undefined, 'unpaid', 1, 0, false],
  ];
  it.each(MATRIX)('R245: mark %s with %s leave → %i unpaid, %i unmarked', (mark, leave, unpaid, unmarked, listed) => {
    const slip = ok(base({ marks: marksWith(mark), leave: leaveOf(leave) }));
    expect([slip.figures.unpaidDays, slip.figures.unmarkedDays, slip.days.unapprovedLeave]).toEqual([unpaid, unmarked, listed ? [DAY] : []]);
    expect(slip.figures.absenceDeduction).toBe(unpaid * 1_000);
    expect(slip.days.unpaid).toEqual(unpaid === 1 ? [DAY] : []);
    expect(slip.days.unmarked).toEqual(unmarked === 1 ? [DAY] : []);
  });

  it('R245: leave spanning the month counts only the window\'s days', () => {
    const marks = new Map<string, StaffAttendanceStatus>();
    const slip = ok(base({ marks, leave: [{ startsOn: '2026-05-25', endsOn: '2026-06-02', paid: false }] }));
    expect([slip.figures.unpaidDays, slip.figures.unmarkedDays]).toEqual([2, 8]);
  });

  it('R246: a mid-month join pro-rates basic, allowances and deductions; absence on the same window', () => {
    const slip = ok(
      base({
        window: { from: '2026-06-04', to: '2026-06-10' },
        structure: {
          id: 1n,
          basic: 10_000,
          components: [
            { kind: 'allowance', name: 'House rent', amount: 1_001 },
            { kind: 'deduction', name: 'Fund', amount: 333 },
          ],
        },
        marks: marksWith('absent'),
      }),
    );
    // 7 of 10 days: floor(10,000 × 7 / 10), floor(1,001 × 7 / 10), floor(333 × 7 / 10).
    expect([slip.figures.employedWorkingDays, slip.figures.basic, slip.figures.allowancesTotal, slip.figures.deductionsTotal]).toEqual([7, 7_000, 700, 233]);
    expect([slip.figures.unpaidDays, slip.figures.absenceDeduction, slip.figures.net]).toEqual([1, 1_000, 7_000 + 700 - 233 - 1_000]);
  });

  it('§1.1: working_days = 0 is full pay and no deduction', () => {
    const slip = ok(base({ monthWorkingDays: [], marks: new Map(), structure: { id: 1n, basic: 9_999, components: [{ kind: 'allowance', name: 'Fuel', amount: 1 }] } }));
    expect([slip.figures.basic, slip.figures.allowancesTotal, slip.figures.absenceDeduction, slip.figures.net]).toEqual([9_999, 1, 0, 10_000]);
  });

  it('§3.3, R247: absence, then deductions in order, then advances in grant order, each stopping before net goes negative', () => {
    const slip = ok(
      base({
        structure: {
          id: 1n,
          basic: 10_000,
          components: [
            { kind: 'deduction', name: 'Loan', amount: 6_000 },
            { kind: 'deduction', name: 'Welfare', amount: 1_000 },
          ],
        },
        marks: marksWith('absent'),
        advances: [
          { advanceId: 7n, grantedOn: '2026-04-02', instalment: 2_000, remaining: 1_500 },
          { advanceId: 9n, grantedOn: '2026-05-09', instalment: 5_000, remaining: 5_000 },
          { advanceId: 11n, grantedOn: '2026-05-20', instalment: 5_000, remaining: 5_000 },
        ],
      }),
    );
    // 10,000 − 1,000 absence − 6,000 − 1,000 = 2,000: the first advance its remaining 1,500, the
    // second the 500 left, the third nothing.
    expect(slip.recoveries).toEqual([
      { advanceId: 7n, amount: 1_500 },
      { advanceId: 9n, amount: 500 },
    ]);
    expect([slip.figures.advanceRecovery, slip.figures.net]).toEqual([2_000, 0]);
    expect(slip.lines.map((l) => [l.kind, l.name, l.amount])).toEqual([
      ['deduction', 'Loan', 6_000],
      ['deduction', 'Welfare', 1_000],
      ['absence', 'Unpaid absence, 1 day', 1_000],
      ['advance_recovery', 'Advance of 2 Apr 2026', 1_500],
      ['advance_recovery', 'Advance of 9 May 2026', 500],
    ]);
  });

  it('a positive adjustment counts with the gross; one larger than the pay is refused, never clamped', () => {
    expect(ok(base({ adjustment: 500 })).figures.net).toBe(10_500);
    expect(computePayslip(base({ adjustment: -10_001 }))).toEqual({ refused: true, gross: -1, pay: 10_000 });
    expect(emptyPayslip(1n, 250)?.net).toBe(250);
    expect(emptyPayslip(1n, -1)).toBeNull();
  });
});
