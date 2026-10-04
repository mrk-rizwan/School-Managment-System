// contracts/slice-11.md §5 (R127, R128): the shared pure functions, table-driven. Every
// combination of statuses over one to three periods is derived against an independent statement
// of the precedence rule; the named examples of §5.1 and every row of the §5.2 / §5.3 tables are
// their own tests.
import {
  ATTENDANCE_STATUSES,
  attendancePercentage,
  dayValue,
  deriveDayStatus,
  LATE_COUNTS_AS,
  LEAVE_COUNTS_AS,
  type AttendanceStatus,
  type AttendanceValueSettings,
  type DayStatus,
  type PercentageDay,
  type ValuedDay,
} from '@asms/shared';

const P = 'present';
const A = 'absent';
const L = 'late';
const OL = 'on_leave';

const periods = (...statuses: AttendanceStatus[]) =>
  statuses.map((status, i) => ({ period: i + 1, status }));

/** R127 stated a second way: on_leave (all) > absent (all) > partial (mixed) > late (first) > present. */
function oracle(statuses: readonly AttendanceStatus[]): DayStatus {
  const set = new Set(statuses);
  if (set.size === 1 && set.has(OL)) return 'on_leave';
  if (set.size === 1 && set.has(A)) return 'absent';
  if (set.has(A) || set.has(OL)) return 'partial';
  return statuses[0] === L ? 'late' : 'present';
}

function combinations(length: number): AttendanceStatus[][] {
  if (length === 0) return [[]];
  return combinations(length - 1).flatMap((prefix) =>
    ATTENDANCE_STATUSES.map((status) => [...prefix, status]),
  );
}

describe('R127 deriveDayStatus (§5.1)', () => {
  const all = [1, 2, 3].flatMap(combinations);

  it('R127: covers every combination over 1-3 periods (4 + 16 + 64 = 84)', () => {
    expect(all).toHaveLength(84);
  });

  it.each(all.map((statuses) => [statuses.join(','), statuses] as const))(
    'R127: [%s] derives the precedence rule',
    (_label, statuses) => {
      const { status, counts } = deriveDayStatus(periods(...statuses));
      expect(status).toBe(oracle(statuses));
      expect(counts).toEqual({
        recorded: statuses.length,
        present: statuses.filter((s) => s === P).length,
        late: statuses.filter((s) => s === L).length,
        absent: statuses.filter((s) => s === A).length,
        leave: statuses.filter((s) => s === OL).length,
      });
    },
  );

  it.each<[string, AttendanceStatus[], DayStatus]>([
    ['[A] → absent', [A], 'absent'],
    ['[L] → late', [L], 'late'],
    ['[P, L] → present (a late to a later period is not a late day)', [P, L], 'present'],
    ['[L, P, P] → late', [L, P, P], 'late'],
    ['[A, P, P] → partial', [A, P, P], 'partial'],
    ['[A, L] → partial', [A, L], 'partial'],
    ['[OL, OL] → on_leave', [OL, OL], 'on_leave'],
    ['[OL, P] → partial', [OL, P], 'partial'],
    ['[A, A, A] → absent', [A, A, A], 'absent'],
    ['[OL, A] → partial (mixed leave and absence)', [OL, A], 'partial'],
  ])('R127 §5.1 example: %s', (_label, statuses, expected) => {
    expect(deriveDayStatus(periods(...statuses)).status).toBe(expected);
  });

  it('R127: periods out of order are read ascending (the first recorded period decides late)', () => {
    expect(deriveDayStatus([{ period: 3, status: P }, { period: 1, status: L }]).status).toBe('late');
    expect(deriveDayStatus([{ period: 2, status: L }, { period: 5, status: P }]).status).toBe('late');
  });

  it('R127: an unrecorded period is simply absent from the input (periods 2 and 4 only)', () => {
    expect(deriveDayStatus([{ period: 2, status: P }, { period: 4, status: P }]).counts.recorded).toBe(2);
  });

  it('R127: nothing recorded is not a day', () => {
    expect(() => deriveDayStatus([])).toThrow(RangeError);
  });
});

const settings = (over: Partial<AttendanceValueSettings> = {}): AttendanceValueSettings => ({
  lateCountsAs: 'present',
  lateCutoffTime: null,
  leaveCountsAs: 'excused',
  ...over,
});

const day = (statuses: AttendanceStatus[], firstLateArrivedAt: string | null = null): ValuedDay => ({
  ...deriveDayStatus(periods(...statuses)),
  firstLateArrivedAt,
});

describe('R128 dayValue (§5.2)', () => {
  it.each(LATE_COUNTS_AS.flatMap((late) => LEAVE_COUNTS_AS.map((leave) => [late, leave] as const)))(
    'R128: present is 1 and absent is 0 under late=%s, leave=%s',
    (lateCountsAs, leaveCountsAs) => {
      const s = settings({ lateCountsAs, leaveCountsAs, lateCutoffTime: '08:30' });
      expect(dayValue(day([P]), s)).toBe(1);
      expect(dayValue(day([A]), s)).toBe(0);
      expect(dayValue(day([P, P, P]), s)).toBe(1);
      expect(dayValue(day([A, A]), s)).toBe(0);
    },
  );

  it.each<[string, AttendanceValueSettings, string | null, number]>([
    ['late=present', settings({ lateCountsAs: 'present' }), '09:00', 1],
    ['late=half_day', settings({ lateCountsAs: 'half_day' }), '09:00', 0.5],
    ['absent_after_cutoff, arrived after the cutoff', settings({ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: '08:30' }), '08:31', 0],
    ['absent_after_cutoff, arrived at the cutoff', settings({ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: '08:30' }), '08:30', 1],
    ['absent_after_cutoff, arrived before the cutoff', settings({ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: '08:30' }), '08:10', 1],
    ['absent_after_cutoff, arrival unknown (not penalised)', settings({ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: '08:30' }), null, 1],
    ['absent_after_cutoff, no cutoff set', settings({ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: null }), '11:00', 1],
  ])('R128: a late day under %s', (_label, s, arrivedAt, expected) => {
    expect(dayValue(day([L], arrivedAt), s)).toBe(expected);
    expect(dayValue(day([L, P, L], arrivedAt), s)).toBe(expected);
  });

  it('R128: on leave is 0 under leave=absent and excluded (null) under leave=excused', () => {
    expect(dayValue(day([OL]), settings({ leaveCountsAs: 'absent' }))).toBe(0);
    expect(dayValue(day([OL, OL]), settings({ leaveCountsAs: 'excused' }))).toBeNull();
  });

  it.each(LATE_COUNTS_AS.flatMap((late) => LEAVE_COUNTS_AS.map((leave) => [late, leave] as const)))(
    'R128: a partial day is (present + late) / recorded whatever the settings (late=%s, leave=%s)',
    (lateCountsAs, leaveCountsAs) => {
      const s = settings({ lateCountsAs, leaveCountsAs, lateCutoffTime: '08:00' });
      expect(dayValue(day([A, P, P]), s)).toBeCloseTo(2 / 3);
      expect(dayValue(day([A, L]), s)).toBe(0.5);
      expect(dayValue(day([OL, P]), s)).toBe(0.5);
      expect(dayValue(day([A, OL, L, P]), s)).toBe(0.5);
    },
  );
});

describe('R128 attendancePercentage (§5.3)', () => {
  const D = (date: string, statuses: AttendanceStatus[] | null, over: Partial<PercentageDay> = {}): PercentageDay => ({
    date,
    teachingDay: true,
    enrolled: true,
    day: statuses === null ? null : day(statuses),
    ...over,
  });

  it('R128: zero counted days is null ("no recorded days"), never 100 or NaN', () => {
    const r = attendancePercentage([D('2026-10-05', null), D('2026-10-06', null)], settings());
    expect(r.percentage).toBeNull();
    expect(r.countedDays).toBe(0);
    expect(r.teachingDays).toBe(2);
    expect(r.unrecorded).toBe(2);
    expect(attendancePercentage([], settings()).percentage).toBeNull();
  });

  it('R128: 100 and 0 are legitimate values of a non-empty set', () => {
    expect(attendancePercentage([D('2026-10-05', [P])], settings()).percentage).toBe(100);
    expect(attendancePercentage([D('2026-10-05', [A])], settings()).percentage).toBe(0);
  });

  it('R128: non-teaching and not-enrolled days count in neither numerator nor denominator', () => {
    const r = attendancePercentage(
      [
        D('2026-10-05', [P]),
        D('2026-10-06', [A], { teachingDay: false }),
        D('2026-10-07', [A], { enrolled: false }),
        D('2026-10-08', [A]),
      ],
      settings(),
    );
    expect(r).toMatchObject({ percentage: 50, countedDays: 2, teachingDays: 2, present: 1, absent: 1, unrecorded: 0 });
  });

  it('R128: excused leave leaves the denominator; leave=absent counts it as 0', () => {
    const days = [D('2026-10-05', [P]), D('2026-10-06', [OL]), D('2026-10-07', null)];
    expect(attendancePercentage(days, settings({ leaveCountsAs: 'excused' }))).toMatchObject({
      percentage: 100,
      countedDays: 1,
      excludedLeaveDays: 1,
      onLeave: 0,
      teachingDays: 3,
      unrecorded: 1,
    });
    expect(attendancePercentage(days, settings({ leaveCountsAs: 'absent' }))).toMatchObject({
      percentage: 50,
      countedDays: 2,
      excludedLeaveDays: 0,
      onLeave: 1,
      unrecorded: 1,
    });
  });

  it('R128: one decimal, half up, rounded once at the end (2 of 3 → 66.7; 1/3 partial days)', () => {
    expect(
      attendancePercentage([D('2026-10-05', [P]), D('2026-10-06', [P]), D('2026-10-07', [A])], settings()).percentage,
    ).toBe(66.7);
    expect(attendancePercentage([D('2026-10-05', [A, P, P])], settings()).percentage).toBe(66.7);
    // 0.5 + 1 + 1 + 1 over 8 days with 4 absent = 3.5 / 8 = 43.75 → 43.8 (half up).
    const days = [
      D('2026-10-05', [L]),
      D('2026-10-06', [P]),
      D('2026-10-07', [P]),
      D('2026-10-08', [P]),
      D('2026-10-09', [A]),
      D('2026-10-10', [A]),
      D('2026-10-11', [A]),
      D('2026-10-12', [A]),
    ];
    expect(attendancePercentage(days, settings({ lateCountsAs: 'half_day' })).percentage).toBe(43.8);
  });

  it.each(LATE_COUNTS_AS.flatMap((late) => LEAVE_COUNTS_AS.map((leave) => [late, leave] as const)))(
    'R128: a mixed range under late=%s, leave=%s counts by derived status',
    (lateCountsAs, leaveCountsAs) => {
      const s = settings({ lateCountsAs, leaveCountsAs, lateCutoffTime: '08:30' });
      const days = [
        D('2026-10-05', [P]),
        { ...D('2026-10-06', null), day: day([L], '09:00') },
        D('2026-10-07', [A]),
        D('2026-10-08', [OL]),
        D('2026-10-09', [A, P]),
      ];
      const r = attendancePercentage(days, s);
      const lateValue = lateCountsAs === 'present' ? 1 : lateCountsAs === 'half_day' ? 0.5 : 0;
      const leaveCounted = leaveCountsAs === 'absent';
      const sum = 1 + lateValue + 0 + 0 + 0.5;
      const counted = leaveCounted ? 5 : 4;
      expect(r.countedDays).toBe(counted);
      expect(r.excludedLeaveDays).toBe(leaveCounted ? 0 : 1);
      expect(r.percentage).toBe(Math.round((sum / counted) * 1000) / 10);
      expect(r).toMatchObject({ present: 1, late: 1, absent: 1, partial: 1, onLeave: leaveCounted ? 1 : 0 });
    },
  );
});
