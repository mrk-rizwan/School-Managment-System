// The Phase 3 pure functions (phase-3-financial.md §3.3, rule 0.22), table-tested. Each is the one
// definition of its rule; the services that land in slices 19-26 call these.
import {
  absenceDeduction,
  allocate,
  concessionAmount,
  dueOn,
  formatRupees,
  lateFeeTarget,
  leaveBalance,
  MAX_RUPEES,
  outstanding,
  payslipNet,
  proRate,
  tierFor,
  unpaidDays,
  type LateFeeCandidate,
  type StaffAttendanceStatus,
} from '@asms/shared';

describe('money helpers (§3.3)', () => {
  it('formatRupees: whole rupees, grouped, no paisa', () => {
    expect(formatRupees(0)).toBe('Rs 0');
    expect(formatRupees(12500)).toBe('Rs 12,500');
    expect(formatRupees(1250000)).toBe('Rs 1,250,000');
    expect(formatRupees(-500)).toBe('-Rs 500');
    expect(() => formatRupees(10.5)).toThrow();
    expect(MAX_RUPEES).toBe(10_000_000);
  });

  it('outstanding = amount − allocated − credited', () => {
    expect(outstanding({ amount: 5000, allocatedAmount: 2000, creditedAmount: 500 })).toBe(2500);
    expect(outstanding({ amount: 0, allocatedAmount: 0, creditedAmount: 0 })).toBe(0);
  });

  it.each([
    // period, feeDueDay, createdOn, grace, expected
    ['2026-05', 1, '2026-04-28', 7, '2026-05-01'],
    ['2026-05', 1, '2026-05-01', 7, '2026-05-01'],
    ['2026-05', 1, '2026-05-02', 7, '2026-05-09'],
    ['2026-05', 5, '2026-05-01', 7, '2026-05-05'],
    ['2026-05', 5, '2026-05-06', 7, '2026-05-13'],
    ['2026-05', 10, '2026-05-10', 7, '2026-05-10'],
    ['2026-05', 10, '2026-05-18', 7, '2026-05-25'],
    ['2026-05', 28, '2026-05-01', 0, '2026-05-28'],
    ['2026-05', 28, '2026-05-29', 0, '2026-05-29'],
    ['2026-12', 28, '2026-12-30', 7, '2027-01-06'],
  ])('dueOn(%s, day %i, created %s, grace %i) = %s (born late only after the nominal date)', (period, day, created, grace, expected) => {
    expect(dueOn(period, day, created, grace)).toBe(expected);
  });

  it.each([
    // gross, kind, value, eligible, named, expected
    [5000, 'percentage', 50, true, true, 2500],
    [5001, 'percentage', 50, true, true, 2500], // rounded down
    [999, 'percentage', 33, true, true, 329],
    [5000, 'percentage', 100, true, true, 5000],
    [5000, 'fixed', 1000, true, true, 1000],
    [800, 'fixed', 1000, true, true, 800], // capped at the gross
    [5000, 'fixed', 1000, false, true, 0], // a fine is never eligible
    [5000, 'fixed', 1000, true, false, 0], // a head the concession does not name
  ] as const)('concessionAmount(%i, %s %i, eligible %s, named %s) = %i', (gross, kind, value, eligible, named, expected) => {
    const concession = { kind, value, feeHeadIds: named ? [7n] : [8n] };
    expect(concessionAmount(gross, concession, { id: 7n, concessionEligible: eligible })).toBe(expected);
    expect(concessionAmount(gross, null, { id: 7n, concessionEligible: true })).toBe(0);
  });

  it('allocate: the child\'s own advances first, then new money oldest-first across the named children, ties by id', () => {
    const charges = [
      { id: 3n, studentId: 1n, dueOn: '2026-05-10', outstanding: 3000 },
      { id: 2n, studentId: 2n, dueOn: '2026-04-10', outstanding: 2000 },
      { id: 1n, studentId: 1n, dueOn: '2026-04-10', outstanding: 1000 },
      { id: 9n, studentId: 9n, dueOn: '2026-01-10', outstanding: 9000 }, // not named
    ];
    const advances = [
      { paymentId: 50n, studentId: 1n, unallocated: 1500 },
      { paymentId: 51n, studentId: 9n, unallocated: 500 },
    ];
    const result = allocate(4000, [1n, 2n], charges, advances);
    expect(result.allocations).toEqual([
      { chargeId: 1n, studentId: 1n, paymentId: 50n, amount: 1000 },
      { chargeId: 3n, studentId: 1n, paymentId: 50n, amount: 500 },
      { chargeId: 2n, studentId: 2n, paymentId: null, amount: 2000 },
      { chargeId: 3n, studentId: 1n, paymentId: null, amount: 2000 },
    ]);
    expect(result.remainder).toBe(0);
    // More money than is owed: the rest is the payment's advance.
    expect(allocate(10_000, [2n], charges, []).remainder).toBe(8000);
    // A sibling's advance never pays another child's charge.
    expect(allocate(0, [2n], charges, advances).allocations).toEqual([]);
  });

  it('allocate: a due-date tie is broken by charge id, whatever order the charges arrive in', () => {
    const tied = [
      { id: 8n, studentId: 1n, dueOn: '2026-05-10', outstanding: 1000 },
      { id: 4n, studentId: 1n, dueOn: '2026-05-10', outstanding: 1000 },
    ];
    // 1,500 pays charge 4 in full and 500 of charge 8; by arrival order it would be the reverse.
    for (const order of [tied, [...tied].reverse()]) {
      expect(allocate(1500, [1n], order, []).allocations).toEqual([
        { chargeId: 4n, studentId: 1n, paymentId: null, amount: 1000 },
        { chargeId: 8n, studentId: 1n, paymentId: null, amount: 500 },
      ]);
    }
  });

  it('allocate: the older advance (lower payment id) is spent first, whatever order the advances arrive in', () => {
    const charges = [{ id: 1n, studentId: 1n, dueOn: '2026-05-10', outstanding: 700 }];
    const advances = [
      { paymentId: 90n, studentId: 1n, unallocated: 500 },
      { paymentId: 30n, studentId: 1n, unallocated: 500 },
    ];
    for (const order of [advances, [...advances].reverse()]) {
      expect(allocate(0, [1n], charges, order).allocations).toEqual([
        { chargeId: 1n, studentId: 1n, paymentId: 30n, amount: 500 },
        { chargeId: 1n, studentId: 1n, paymentId: 90n, amount: 200 },
      ]);
    }
  });

  it('lateFeeTarget: the oldest overdue monthly charge past grace, enabled, open year, no live late fee for its period (A3)', () => {
    const base: LateFeeCandidate = {
      id: 1n,
      kind: 'generated',
      headFrequency: 'monthly',
      period: '2026-05',
      dueOn: '2026-05-10',
      outstanding: 1000,
      yearClosed: false,
    };
    const settings = { lateFeeEnabled: true, lateFeeGraceDays: 7, lateFeeEnabledOn: '2026-04-01' };
    expect(lateFeeTarget([base], [], settings, '2026-05-17')).toBeNull(); // inside grace
    expect(lateFeeTarget([base], [], settings, '2026-05-18')).toEqual(base);
    expect(lateFeeTarget([base], [], { ...settings, lateFeeEnabled: false }, '2026-06-30')).toBeNull();
    expect(lateFeeTarget([base], ['2026-05'], settings, '2026-06-30')).toBeNull();
    expect(lateFeeTarget([{ ...base, yearClosed: true }], [], settings, '2026-06-30')).toBeNull();
    expect(lateFeeTarget([{ ...base, outstanding: 0 }], [], settings, '2026-06-30')).toBeNull();
    expect(lateFeeTarget([base], [], { ...settings, lateFeeEnabledOn: '2026-05-11' }, '2026-06-30')).toBeNull();
    for (const kind of ['late_fee', 'adjustment', 'campaign'] as const) {
      expect(lateFeeTarget([{ ...base, kind }], [], settings, '2026-06-30')).toBeNull();
    }
    expect(lateFeeTarget([{ ...base, headFrequency: 'yearly', period: null }], [], settings, '2026-06-30')).toBeNull();
    const older = { ...base, id: 2n, period: '2026-04', dueOn: '2026-04-10' };
    expect(lateFeeTarget([base, older], [], settings, '2026-06-30')).toEqual(older);
    // The oldest period already carries a live late fee: the next overdue charge is chosen.
    expect(lateFeeTarget([older, base], ['2026-04'], settings, '2026-06-30')).toEqual(base);
    // A manual monthly charge qualifies like a generated one.
    const manual = { ...base, id: 3n, kind: 'manual' as const, period: '2026-03', dueOn: '2026-04-05' };
    expect(lateFeeTarget([base, older, manual], [], settings, '2026-06-30')).toEqual(manual);
  });

  it.each([
    [30000, 20, 26, 23076],
    [30000, 26, 26, 30000],
    [30000, 0, 26, 0],
    [30000, 5, 0, 30000], // no working day: full pay
  ])('proRate(%i, %i of %i) = %i', (x, employed, working, expected) => {
    expect(proRate(x, employed, working)).toBe(expected);
  });

  it.each([
    [30000, 26, 2, 2306],
    [30000, 0, 2, 0],
    [30000, 26, 0, 0],
  ])('absenceDeduction(%i, %i working, %i unpaid) = %i', (basic, working, unpaid, expected) => {
    expect(absenceDeduction(basic, working, unpaid)).toBe(expected);
  });

  it('unpaidDays: the R245 matrix; attendance wins over leave when present', () => {
    const days = ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07'];
    const marks = (status: StaffAttendanceStatus | undefined) =>
      new Map(status === undefined ? [] : [[days[0]!, status]]);
    const one = [days[0]!];
    const paidLeave = [{ startsOn: days[0]!, endsOn: days[0]!, paid: true }];
    const unpaidLeave = [{ startsOn: days[0]!, endsOn: days[0]!, paid: false }];
    const table: [StaffAttendanceStatus | undefined, 'none' | 'paid' | 'unpaid', number, number, number][] = [
      // mark, leave, unpaid, unmarked, unapproved on_leave
      ['present', 'none', 0, 0, 0],
      ['present', 'paid', 0, 0, 0],
      ['present', 'unpaid', 0, 0, 0],
      ['late', 'unpaid', 0, 0, 0],
      ['absent', 'none', 1, 0, 0],
      ['absent', 'paid', 0, 0, 0],
      ['absent', 'unpaid', 1, 0, 0],
      ['on_leave', 'none', 1, 0, 1],
      ['on_leave', 'paid', 0, 0, 0],
      ['on_leave', 'unpaid', 1, 0, 0],
      [undefined, 'none', 0, 1, 0],
      [undefined, 'paid', 0, 0, 0],
      [undefined, 'unpaid', 1, 0, 0],
    ];
    for (const [mark, leave, unpaid, unmarked, unapproved] of table) {
      const result = unpaidDays(marks(mark), leave === 'none' ? [] : leave === 'paid' ? paidLeave : unpaidLeave, one);
      expect([mark, leave, result.unpaidDays, result.unmarkedDays, result.unapprovedLeaveDays.length]).toEqual([
        mark,
        leave,
        unpaid,
        unmarked,
        unapproved,
      ]);
    }
    // A leave spanning the month boundary counts only the run month's working days passed in.
    const spanning = [{ startsOn: '2026-04-28', endsOn: '2026-05-05', paid: false }];
    expect(unpaidDays(new Map(), spanning, days).unpaidDays).toBe(2);
  });

  it('payslipNet: absence, then named deductions in order, then recoveries; none takes net below zero', () => {
    const net = payslipNet({
      basic: 10000,
      allowances: 2000,
      adjustment: 0,
      absence: 1000,
      deductions: [
        { name: 'Provident fund', amount: 4000 },
        { name: 'Loan', amount: 9000 },
      ],
      advances: [
        { advanceId: 1n, instalment: 3000, remaining: 3000 },
        { advanceId: 2n, instalment: 1000, remaining: 500 },
      ],
    });
    if (!net.ok) throw new Error('refused');
    expect(net.absence).toBe(1000);
    expect(net.deductions).toEqual([
      { name: 'Provident fund', amount: 4000, shortBy: 0 },
      { name: 'Loan', amount: 7000, shortBy: 2000 },
    ]);
    expect(net.recoveries).toEqual([]);
    expect(net.net).toBe(0);
    const roomy = payslipNet({
      basic: 30000,
      allowances: 0,
      adjustment: 500,
      absence: 0,
      deductions: [],
      advances: [
        { advanceId: 1n, instalment: 3000, remaining: 3000 },
        { advanceId: 2n, instalment: 1000, remaining: 500 },
      ],
    });
    if (!roomy.ok) throw new Error('refused');
    expect(roomy.recoveries).toEqual([
      { advanceId: 1n, amount: 3000 },
      { advanceId: 2n, amount: 500 },
    ]);
    expect(roomy.net).toBe(30500 - 3500);
  });

  it('payslipNet: a negative adjustment beyond basic + allowances is refused, never clamped', () => {
    const base = { basic: 10000, allowances: 2000, absence: 0, deductions: [], advances: [] };
    expect(payslipNet({ ...base, adjustment: -12001 })).toEqual({ ok: false, reason: 'adjustment_exceeds_pay', gross: -1 });
    const exact = payslipNet({ ...base, adjustment: -12000 });
    expect(exact.ok && exact.net).toBe(0);
    const partial = payslipNet({ ...base, adjustment: -2000 });
    expect(partial.ok && partial.net).toBe(10000);
  });

  it('payslipNet: an instalment larger than the net left is recovered in part, and the rest waits', () => {
    const net = payslipNet({
      basic: 10000,
      allowances: 0,
      adjustment: 0,
      absence: 0,
      deductions: [{ name: 'Provident fund', amount: 8000 }],
      advances: [
        { advanceId: 1n, instalment: 3000, remaining: 5000 },
        { advanceId: 2n, instalment: 1000, remaining: 1000 },
      ],
    });
    if (!net.ok) throw new Error('refused');
    expect(net.recoveries).toEqual([{ advanceId: 1n, amount: 2000 }]);
    expect([net.recoveryTotal, net.net]).toEqual([2000, 0]);
    // The identity the slice-25 CHECK states holds on what was taken.
    expect(10000 - net.deductionsTotal - net.absence - net.recoveryTotal).toBe(net.net);
  });

  it.each([
    [10, null, 2026, 3, { entitled: 10, taken: 3, remaining: 7 }],
    [10, '2025-08-15', 2026, 0, { entitled: 10, taken: 0, remaining: 10 }],
    [10, '2026-07-01', 2026, 0, { entitled: 5, taken: 0, remaining: 5 }],
    [10, '2026-07-02', 2026, 0, { entitled: 4, taken: 0, remaining: 4 }],
    [10, '2027-01-01', 2026, 0, { entitled: 0, taken: 0, remaining: 0 }],
    [null, null, 2026, 12, { entitled: null, taken: 12, remaining: null }],
  ] as const)('leaveBalance(%s, joined %s, %i, taken %i)', (entitlement, joined, year, taken, expected) => {
    expect(leaveBalance(entitlement, joined, year, taken)).toEqual(expected);
  });

  it('tierFor: the active band containing the count, bounds inclusive', () => {
    const tiers = [
      { id: 1n, minStudents: 0, maxStudents: 200, status: 'active' as const },
      { id: 2n, minStudents: 201, maxStudents: 500, status: 'active' as const },
      { id: 3n, minStudents: 501, maxStudents: null, status: 'active' as const },
      { id: 4n, minStudents: 0, maxStudents: 10_000, status: 'archived' as const },
    ];
    expect(tierFor(0, tiers)?.id).toBe(1n);
    expect(tierFor(200, tiers)?.id).toBe(1n);
    expect(tierFor(201, tiers)?.id).toBe(2n);
    expect(tierFor(5000, tiers)?.id).toBe(3n);
    expect(tierFor(10, tiers.slice(3))).toBeNull();
  });
});
